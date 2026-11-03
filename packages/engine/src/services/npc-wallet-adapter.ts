/**
 * NPC Wallet Adapter
 *
 * Wraps actorState table operations to implement WalletPort interface.
 * This allows NPC trades to use the core PerpMarketService while
 * managing balances in the actorState table.
 *
 * Uses atomic SQL operations to prevent race conditions that could
 * lead to negative balances.
 */
import type { WalletPort } from '@feed/core/markets/shared';
import {
  actorState,
  and,
  db as defaultDb,
  eq,
  gte,
  sql,
  type Transaction,
} from '@feed/db';
import { logger, WalletCreditNotAppliedError } from '@feed/shared';

type DbClient = typeof defaultDb | Transaction;

/** Negative amounts would invert the operation (a negative debit mints). */
function assertValidAmount(
  operation: 'debit' | 'credit',
  actorId: string,
  amount: number
): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(
      `Invalid NPC ${operation} amount for ${actorId}: ${amount}. Amount must be a finite non-negative number.`
    );
  }
}

/**
 * Creates a WalletPort implementation for NPC actors.
 * Uses actorState.tradingBalance instead of user wallets.
 *
 * All debit operations are atomic - the balance check and update happen
 * in a single SQL statement to prevent race conditions.
 */
export function createNpcWalletAdapter(
  actorId: string,
  dbClient?: DbClient
): WalletPort {
  const db = dbClient ?? defaultDb;

  return {
    async debit({ amount, reason }: { amount: number; reason: string }) {
      assertValidAmount('debit', actorId, amount);
      // Atomic debit: check balance AND update in single statement
      // This prevents race conditions where concurrent debits could
      // both pass the balance check and cause negative balance
      const result = await db
        .update(actorState)
        .set({
          tradingBalance: sql`${actorState.tradingBalance} - ${amount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(actorState.id, actorId),
            gte(sql<number>`${actorState.tradingBalance}::numeric`, amount)
          )
        )
        .returning({ id: actorState.id });

      // If no rows updated, either actor doesn't exist or insufficient balance
      if (result.length === 0) {
        // Check if actor exists to provide better error message
        const [actor] = await db
          .select({ tradingBalance: actorState.tradingBalance })
          .from(actorState)
          .where(eq(actorState.id, actorId))
          .limit(1);

        if (!actor) {
          throw new Error(`Actor not found: ${actorId}`);
        }

        const currentBalance = Number(actor.tradingBalance);
        throw new Error(
          `Insufficient trading balance: ${currentBalance.toFixed(2)} < ${amount.toFixed(2)} (${reason})`
        );
      }
    },

    async credit({ amount }: { amount: number }) {
      try {
        assertValidAmount('credit', actorId, amount);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new WalletCreditNotAppliedError(message, { cause: err });
      }
      // Atomic credit using SQL increment. A zero-row update means the actor
      // row was missing and nothing was paid. Driver errors stay unclassified
      // so a lost response is not treated as "not applied".
      const result = await db
        .update(actorState)
        .set({
          tradingBalance: sql`${actorState.tradingBalance} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(actorState.id, actorId))
        .returning({ id: actorState.id });

      if (result.length === 0) {
        throw new WalletCreditNotAppliedError(`Actor not found: ${actorId}`);
      }
    },

    async recordPnL({ pnl, reason }: { pnl: number; reason: string }) {
      // For NPCs, we just update the trading balance directly
      // No separate PnL tracking like user wallets
      // Log PnL for debugging but don't modify balance here
      // (credit/debit already handles the balance changes)
      logger.debug(
        'NPC PnL recorded',
        { actorId, pnl: pnl.toFixed(2), reason },
        'NpcWalletAdapter'
      );
    },

    async getBalance() {
      const [actor] = await db
        .select({ tradingBalance: actorState.tradingBalance })
        .from(actorState)
        .where(eq(actorState.id, actorId))
        .limit(1);

      if (!actor) {
        return { balance: 0 };
      }

      return { balance: Number(actor.tradingBalance) };
    },
  };
}
