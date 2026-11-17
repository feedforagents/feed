import {
  and,
  balanceTransactions,
  db,
  desc,
  eq,
  inArray,
  sql,
  type Transaction,
  users,
  WELCOME_BONUS_BALANCE_DESCRIPTION,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { CACHE_KEYS, invalidateCache } from '../cache';

const FUNDING_TRANSACTION_TYPES = [
  'deposit',
  'crypto_purchase',
  'stripe_purchase',
  'stripe_refund',
  'stripe_dispute',
  'stripe_dispute_won',
] as const;

export interface TradingBalanceFundingResult {
  success: boolean;
  balanceDelta: number;
  newBalance: number;
  alreadyProcessed?: boolean;
  error?: string;
  transactionId?: string;
}

export interface TradingBalanceFundingHistoryItem {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string | null;
  relatedId: string | null;
  createdAt: Date;
}

/**
 * Lock the user's row for the rest of the transaction and return the current
 * balance, or null if the user does not exist.
 *
 * Every funding mutation takes this lock BEFORE its idempotency check, so two
 * concurrent deliveries of the same event serialize: the second one sees the
 * first one's ledger row and returns alreadyProcessed. The locked balance is
 * also the one used for ledger balanceBefore/balanceAfter.
 */
async function lockUserBalance(
  tx: Transaction,
  userId: string
): Promise<number | null> {
  const [user] = await tx
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return user ? Number(user.virtualBalance ?? 0) : null;
}

const USER_NOT_FOUND: TradingBalanceFundingResult = {
  success: false,
  balanceDelta: 0,
  newBalance: 0,
  error: 'User not found',
};

/**
 * Convert a USD amount to balance units (100 per dollar).
 *
 * Stripe amounts arrive as whole cents divided by 100, which are not exact in
 * binary floating point (for example 1.13 * 100 === 112.99999999999999).
 * Flooring that product would credit one unit less than the cents charged, so
 * round to the nearest cent, matching how checkout computes the charge.
 */
export function usdToBalanceUnits(amountUSD: number): number {
  return Math.round(amountUSD * 100);
}

export class TradingBalanceFundingService {
  /**
   * Economic baseline for portfolio PnL uses:
   * netContributions = totalDeposited - totalWithdrawn.
   *
   * Rules retained here:
   * - capital entering the trading wallet increments totalDeposited
   * - refunds/disputes increment totalWithdrawn by the points actually deducted
   * - dispute reversals decrement totalWithdrawn to restore net contributions
   */
  private static async afterBalanceMutation(userId: string): Promise<void> {
    await Promise.allSettled([
      invalidateCache(userId, { namespace: CACHE_KEYS.USER_BALANCE }),
      invalidateCache(userId, { namespace: CACHE_KEYS.USER }),
    ]);
  }

  /**
   * The user's complete funding history, newest first.
   *
   * The settings Billing tab renders this array as the whole history,
   * with no continuation. Its count badge and "Show all N transactions"
   * button use the array length, so a cap silently hides older funding
   * transactions while presenting the returned window as complete.
   */
  static async getFundingHistory(
    userId: string
  ): Promise<TradingBalanceFundingHistoryItem[]> {
    const transactions = await db
      .select({
        id: balanceTransactions.id,
        type: balanceTransactions.type,
        amount: balanceTransactions.amount,
        balanceBefore: balanceTransactions.balanceBefore,
        balanceAfter: balanceTransactions.balanceAfter,
        description: balanceTransactions.description,
        relatedId: balanceTransactions.relatedId,
        createdAt: balanceTransactions.createdAt,
      })
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          inArray(balanceTransactions.type, [...FUNDING_TRANSACTION_TYPES])
        )
      )
      .orderBy(desc(balanceTransactions.createdAt));

    return transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amount: Number(transaction.amount),
      balanceBefore: Number(transaction.balanceBefore),
      balanceAfter: Number(transaction.balanceAfter),
      description: transaction.description,
      relatedId: transaction.relatedId,
      createdAt: transaction.createdAt,
    }));
  }

  static async awardWelcomeBonus(
    userId: string,
    amount: number
  ): Promise<TradingBalanceFundingResult> {
    const result = await db.transaction(
      async (tx): Promise<TradingBalanceFundingResult> => {
        const balanceBefore = await lockUserBalance(tx, userId);
        if (balanceBefore === null) {
          return USER_NOT_FOUND;
        }

        const [existingTransaction] = await tx
          .select({ id: balanceTransactions.id })
          .from(balanceTransactions)
          .where(
            and(
              eq(balanceTransactions.userId, userId),
              eq(
                balanceTransactions.description,
                WELCOME_BONUS_BALANCE_DESCRIPTION
              )
            )
          )
          .limit(1);

        if (existingTransaction) {
          return {
            success: true,
            balanceDelta: 0,
            newBalance: balanceBefore,
            alreadyProcessed: true,
          };
        }

        const balanceAfter = balanceBefore + amount;
        const transactionId = await generateSnowflakeId();

        await tx
          .update(users)
          .set({
            virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${amount}`,
            totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${amount}`,
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: transactionId,
          userId,
          type: 'deposit',
          amount: String(amount),
          balanceBefore: String(balanceBefore),
          balanceAfter: String(balanceAfter),
          description: WELCOME_BONUS_BALANCE_DESCRIPTION,
        });

        return {
          success: true,
          balanceDelta: amount,
          newBalance: balanceAfter,
          transactionId,
        };
      }
    );

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        'Welcome bonus funded to trading balance',
        { userId, amount, newBalance: result.newBalance },
        'TradingBalanceFundingService'
      );
      await this.afterBalanceMutation(userId);
    }

    return result;
  }

  static async creditAdminFunding(
    userId: string,
    amount: number,
    reason: string,
    description?: string
  ): Promise<TradingBalanceFundingResult> {
    const result = await db.transaction(
      async (tx): Promise<TradingBalanceFundingResult> => {
        const balanceBefore = await lockUserBalance(tx, userId);
        if (balanceBefore === null) {
          return USER_NOT_FOUND;
        }

        const balanceAfter = balanceBefore + amount;
        const transactionId = await generateSnowflakeId();

        await tx
          .update(users)
          .set({
            virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${amount}`,
            totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${amount}`,
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: transactionId,
          userId,
          type: 'deposit',
          amount: String(amount),
          balanceBefore: String(balanceBefore),
          balanceAfter: String(balanceAfter),
          description: description || reason,
        });

        return {
          success: true,
          balanceDelta: amount,
          newBalance: balanceAfter,
          transactionId,
        };
      }
    );

    if (!result.success) {
      return result;
    }

    logger.info(
      'Credited trading balance via admin funding adjustment',
      { userId, amount, reason, newBalance: result.newBalance },
      'TradingBalanceFundingService'
    );

    await this.afterBalanceMutation(userId);

    return result;
  }

  static async fundPurchase(
    userId: string,
    amountUSD: number,
    paymentRequestId: string,
    paymentTxHash?: string,
    paymentProvider: 'crypto' | 'stripe' = 'crypto'
  ): Promise<TradingBalanceFundingResult> {
    const balanceDelta = usdToBalanceUnits(amountUSD);
    const transactionType = `${paymentProvider}_purchase`;
    const relatedId = paymentTxHash || paymentRequestId;

    const result = await db.transaction(
      async (tx): Promise<TradingBalanceFundingResult> => {
        // Serialize all funding attempts for this payment across users, so a
        // payment can be credited to at most one account.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`funding:${transactionType}:${relatedId}`}))`
        );

        const balanceBefore = await lockUserBalance(tx, userId);
        if (balanceBefore === null) {
          return USER_NOT_FOUND;
        }

        const [existingTransaction] = await tx
          .select({
            id: balanceTransactions.id,
            userId: balanceTransactions.userId,
            amount: balanceTransactions.amount,
          })
          .from(balanceTransactions)
          .where(
            and(
              eq(balanceTransactions.type, transactionType),
              eq(balanceTransactions.relatedId, relatedId)
            )
          )
          .limit(1);

        if (existingTransaction && existingTransaction.userId !== userId) {
          logger.warn(
            'Purchase payment already credited to another account',
            { userId, paymentRequestId, paymentProvider, relatedId },
            'TradingBalanceFundingService'
          );
          return {
            success: false,
            balanceDelta: 0,
            newBalance: balanceBefore,
            error: 'Payment has already been credited to another account',
          };
        }

        if (existingTransaction) {
          logger.info(
            'Trading balance purchase already processed',
            { userId, paymentRequestId, paymentProvider, relatedId },
            'TradingBalanceFundingService'
          );
          return {
            success: true,
            balanceDelta: Number(existingTransaction.amount),
            newBalance: balanceBefore,
            alreadyProcessed: true,
            transactionId: existingTransaction.id,
          };
        }

        const balanceAfter = balanceBefore + balanceDelta;
        const transactionId = await generateSnowflakeId();

        await tx
          .update(users)
          .set({
            virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${balanceDelta}`,
            totalDeposited: sql`COALESCE(CAST("totalDeposited" AS NUMERIC), 0) + ${balanceDelta}`,
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: transactionId,
          userId,
          type: transactionType,
          amount: String(balanceDelta),
          balanceBefore: String(balanceBefore),
          balanceAfter: String(balanceAfter),
          relatedId,
          description: JSON.stringify({
            amountUSD,
            balanceUnitsPerDollar: 100,
            purchasedAt: new Date().toISOString(),
            paymentProvider,
            paymentRequestId,
            paymentTxHash,
          }),
        });

        return {
          success: true,
          balanceDelta,
          newBalance: balanceAfter,
          transactionId,
        };
      }
    );

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        'Funded trading balance from purchase',
        { userId, amountUSD, balanceDelta, paymentRequestId, paymentProvider },
        'TradingBalanceFundingService'
      );
      await this.afterBalanceMutation(userId);
    }

    return result;
  }

  static async reversePurchaseFunding(
    userId: string,
    paymentIntentId: string,
    reason: 'refund' | 'dispute',
    amountUSD: number,
    stripeEventId: string
  ): Promise<TradingBalanceFundingResult> {
    const requestedDeduction = usdToBalanceUnits(amountUSD);
    const transactionType =
      reason === 'refund' ? 'stripe_refund' : 'stripe_dispute';

    const result = await db.transaction(
      async (tx): Promise<TradingBalanceFundingResult> => {
        const balanceBefore = await lockUserBalance(tx, userId);
        if (balanceBefore === null) {
          return USER_NOT_FOUND;
        }

        const [existingReversal] = await tx
          .select({
            id: balanceTransactions.id,
            amount: balanceTransactions.amount,
          })
          .from(balanceTransactions)
          .where(
            and(
              eq(balanceTransactions.userId, userId),
              eq(balanceTransactions.relatedId, stripeEventId)
            )
          )
          .limit(1);

        if (existingReversal) {
          logger.info(
            'Trading balance reversal already processed',
            { userId, stripeEventId, reason },
            'TradingBalanceFundingService'
          );
          return {
            success: true,
            balanceDelta: Number(existingReversal.amount),
            newBalance: balanceBefore,
            alreadyProcessed: true,
            transactionId: existingReversal.id,
          };
        }

        // Invariant: one charge can lose at most its own amount across
        // refund + dispute. The dispute handler passes the ACTUAL dispute
        // amount (webhook: `dispute.amount / 100`), which can be the full
        // charge, only the unrefunded remainder, or a smaller slice of it
        // (Stripe: "The disputed amount might be the full amount of the
        // charge or a different amount"). Netting prior refunds out of the
        // requested amount is therefore wrong whenever the dispute is for
        // less than the full charge: e.g. $100 charge, $40 refund, $60
        // dispute must deduct $60, not $60 − $40 = $20.
        // Correct cap: min(dispute amount, charge amount − prior refunds
        // for the same payment intent). The charge amount comes from the
        // original `stripe_purchase` row for this PI — the same lookup the
        // dispute webhook uses to find the original transaction.
        let alreadyRefundedPoints = 0;
        let chargeAmountPoints: number | null = null;
        let netRequestedDeduction = requestedDeduction;
        if (reason === 'dispute') {
          const priorRefunds = await tx
            .select({
              amount: balanceTransactions.amount,
              description: balanceTransactions.description,
            })
            .from(balanceTransactions)
            .where(
              and(
                eq(balanceTransactions.userId, userId),
                eq(balanceTransactions.type, 'stripe_refund')
              )
            );
          alreadyRefundedPoints = priorRefunds.reduce(
            (
              sum: number,
              row: { amount: string; description: string | null }
            ) => {
              if (!row.description) return sum;
              let parsed: { originalPaymentIntentId?: string };
              try {
                parsed = JSON.parse(row.description) as {
                  originalPaymentIntentId?: string;
                };
              } catch {
                return sum;
              }
              return parsed.originalPaymentIntentId === paymentIntentId
                ? sum + Math.abs(Number(row.amount))
                : sum;
            },
            0
          );
          const [originalPurchase] = await tx
            .select({ amount: balanceTransactions.amount })
            .from(balanceTransactions)
            .where(
              and(
                eq(balanceTransactions.userId, userId),
                eq(balanceTransactions.relatedId, paymentIntentId),
                eq(balanceTransactions.type, 'stripe_purchase')
              )
            )
            .limit(1);
          if (originalPurchase) {
            chargeAmountPoints = Math.abs(Number(originalPurchase.amount));
            netRequestedDeduction = Math.min(
              requestedDeduction,
              Math.max(0, chargeAmountPoints - alreadyRefundedPoints)
            );
          } else {
            // No purchase row (the webhook returns early without one, so
            // this should not happen in production): keep the previous
            // netting instead of regressing to the base double-deduction.
            netRequestedDeduction = Math.max(
              0,
              requestedDeduction - alreadyRefundedPoints
            );
          }
        }

        const balanceAfter = Math.max(0, balanceBefore - netRequestedDeduction);
        const actualDeduction = balanceBefore - balanceAfter;
        const transactionId = await generateSnowflakeId();

        await tx
          .update(users)
          .set({
            virtualBalance: sql`GREATEST(0, COALESCE(CAST("virtualBalance" AS NUMERIC), 0) - ${netRequestedDeduction})`,
            totalWithdrawn: sql`COALESCE(CAST("totalWithdrawn" AS NUMERIC), 0) + ${actualDeduction}`,
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: transactionId,
          userId,
          type: transactionType,
          amount: String(-actualDeduction),
          balanceBefore: String(balanceBefore),
          balanceAfter: String(balanceAfter),
          relatedId: stripeEventId,
          description: JSON.stringify({
            amountUSD,
            balanceUnitsRequested: netRequestedDeduction,
            balanceUnitsDeducted: actualDeduction,
            alreadyRefundedBalanceUnits:
              reason === 'dispute' ? alreadyRefundedPoints : undefined,
            chargeAmountBalanceUnits:
              reason === 'dispute'
                ? (chargeAmountPoints ?? undefined)
                : undefined,
            originalPaymentIntentId: paymentIntentId,
            reversalReason: reason,
            reversedAt: new Date().toISOString(),
          }),
        });

        return {
          success: true,
          balanceDelta: -actualDeduction,
          newBalance: balanceAfter,
          transactionId,
        };
      }
    );

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        'Reversed trading balance funding',
        {
          userId,
          paymentIntentId,
          reason,
          amountUSD,
          balanceDelta: result.balanceDelta,
          newBalance: result.newBalance,
          stripeEventId,
        },
        'TradingBalanceFundingService'
      );
      await this.afterBalanceMutation(userId);
    }

    return result;
  }

  static async creditDisputeWon(
    userId: string,
    disputeId: string,
    amountUSD: number,
    stripeEventId: string
  ): Promise<TradingBalanceFundingResult> {
    const balanceDelta = usdToBalanceUnits(amountUSD);

    const result = await db.transaction(
      async (tx): Promise<TradingBalanceFundingResult> => {
        const balanceBefore = await lockUserBalance(tx, userId);
        if (balanceBefore === null) {
          return USER_NOT_FOUND;
        }

        const [existingCredit] = await tx
          .select({
            id: balanceTransactions.id,
            amount: balanceTransactions.amount,
          })
          .from(balanceTransactions)
          .where(
            and(
              eq(balanceTransactions.userId, userId),
              eq(balanceTransactions.relatedId, stripeEventId)
            )
          )
          .limit(1);

        if (existingCredit) {
          logger.info(
            'Dispute win funding credit already processed',
            { userId, stripeEventId, disputeId },
            'TradingBalanceFundingService'
          );
          return {
            success: true,
            balanceDelta: Number(existingCredit.amount),
            newBalance: balanceBefore,
            alreadyProcessed: true,
            transactionId: existingCredit.id,
          };
        }

        const balanceAfter = balanceBefore + balanceDelta;
        const transactionId = await generateSnowflakeId();

        await tx
          .update(users)
          .set({
            virtualBalance: sql`COALESCE(CAST("virtualBalance" AS NUMERIC), 0) + ${balanceDelta}`,
            totalWithdrawn: sql`GREATEST(0, COALESCE(CAST("totalWithdrawn" AS NUMERIC), 0) - ${balanceDelta})`,
          })
          .where(eq(users.id, userId));

        await tx.insert(balanceTransactions).values({
          id: transactionId,
          userId,
          type: 'stripe_dispute_won',
          amount: String(balanceDelta),
          balanceBefore: String(balanceBefore),
          balanceAfter: String(balanceAfter),
          relatedId: stripeEventId,
          description: JSON.stringify({
            amountUSD,
            balanceUnitsCredited: balanceDelta,
            disputeId,
            creditedAt: new Date().toISOString(),
          }),
        });

        return {
          success: true,
          balanceDelta,
          newBalance: balanceAfter,
          transactionId,
        };
      }
    );

    if (result.success && !result.alreadyProcessed) {
      logger.info(
        'Re-credited trading balance after dispute win',
        {
          userId,
          disputeId,
          amountUSD,
          balanceDelta,
          newBalance: result.newBalance,
          stripeEventId,
        },
        'TradingBalanceFundingService'
      );
      await this.afterBalanceMutation(userId);
    }

    return result;
  }
}
