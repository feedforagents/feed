/**
 * Virtual Wallet Service
 *
 * @description Manages user's virtual USD balance for trading. Provides
 * methods for checking balances, debiting/crediting funds, and tracking
 * transaction history.
 *
 * Features:
 * - Tracks all transactions
 * - Validates sufficient funds
 * - Calculates PnL
 */

import type { AfterCommitScheduler } from '@feed/core/markets/shared';
import {
  balanceTransactions,
  type DrizzleClient,
  db,
  dbWrite,
  desc,
  eq,
  type Transaction,
  users,
  withTransaction,
} from '@feed/db';
import {
  generateSnowflakeId,
  InsufficientFundsError,
  logger,
} from '@feed/shared';
import { EarnedPointsService } from './earned-points-service';

/**
 * User balance information
 *
 * @description Contains current balance and lifetime statistics.
 */
export interface BalanceInfo {
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  lifetimePnL: number;
}

/**
 * Transaction history item
 *
 * @description Represents a single balance transaction with before/after
 * balances and metadata.
 */
export interface TransactionHistoryItem {
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
 * Cache invalidation callback type
 *
 * @description Optional callback to invalidate user cache after balance changes.
 * This allows the web app to inject its caching strategy.
 */
export type CacheInvalidationCallback = (userId: string) => Promise<void>;

/**
 * Wallet Service Class
 *
 * @description Static service class for managing user virtual balances.
 * Provides methods for checking balances, debiting/crediting funds, and
 * retrieving transaction history.
 */
export class WalletService {
  /**
   * Optional cache invalidation callback
   */
  private static cacheInvalidationCallback: CacheInvalidationCallback | null =
    null;

  /**
   * Set the cache invalidation callback
   *
   * @description Allows the web app to inject its caching strategy.
   *
   * @param {CacheInvalidationCallback} callback - Cache invalidation function
   */
  static setCacheInvalidationCallback(
    callback: CacheInvalidationCallback
  ): void {
    WalletService.cacheInvalidationCallback = callback;
  }

  /**
   * Invalidate user cache if callback is set.
   *
   * Best-effort: by the time this runs the balance mutation has already been
   * applied, so a cache failure must not surface as a failed debit/credit
   * (callers would retry and double-apply the mutation).
   */
  private static async invalidateCache(userId: string): Promise<void> {
    const callback = WalletService.cacheInvalidationCallback;
    if (!callback) return;
    await callback(userId).catch((error: Error) => {
      logger.warn(
        'Wallet cache invalidation failed',
        { userId, error: error.message },
        'WalletService'
      );
    });
  }

  /**
   * Validate a debit/credit amount: must be a finite, non-negative number.
   * Negative amounts would silently invert the operation (a negative debit
   * mints balance).
   */
  private static assertValidAmount(
    operation: 'debit' | 'credit',
    userId: string,
    amount: number
  ): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(
        `Invalid ${operation} amount for ${userId}: ${amount}. Amount must be a finite non-negative number.`
      );
    }
  }

  /**
   * Apply balance change atomically
   *
   * @description Internal method to apply a balance change and create a
   * transaction record. Used by debit and credit methods. The user row is
   * locked (SELECT ... FOR UPDATE) so concurrent mutations serialize instead
   * of overwriting each other's absolute balance.
   *
   * @param {Transaction} tx - Drizzle transaction client
   * @param {string} userId - User ID
   * @param {number} delta - Amount to change (positive for credit, negative for debit)
   * @param {string} type - Transaction type identifier
   * @param {string} description - Transaction description
   * @param {string} [relatedId] - Optional related entity ID
   * @returns {Promise<void>}
   * @private
   */
  private static async applyBalanceChange(
    tx: Transaction | DrizzleClient,
    userId: string,
    delta: number,
    type: string,
    description: string,
    relatedId?: string
  ): Promise<void> {
    const result = await tx
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');

    const [user] = result;
    if (!user) {
      // Fail-fast: NPCs should have User records after bootstrap (ensureNpcUsers).
      // A missing user here indicates a bug in bootstrap or an invalid userId.
      throw new Error(
        `User not found for wallet operation: ${userId}. NPCs should have User records after bootstrap.`
      );
    }

    const currentBalance = Number(user.virtualBalance ?? 0);
    const newBalance = currentBalance + delta;

    // Reject non-finite values to prevent balance corruption
    if (
      !Number.isFinite(delta) ||
      !Number.isFinite(currentBalance) ||
      !Number.isFinite(newBalance)
    ) {
      throw new Error(
        `Invalid wallet mutation for ${userId}: delta=${delta}, balance=${currentBalance}, result=${newBalance}`
      );
    }

    // Prevent negative balance on debits
    if (delta < 0 && newBalance < 0) {
      throw new InsufficientFundsError(Math.abs(delta), currentBalance, 'USD');
    }

    await tx
      .update(users)
      .set({ virtualBalance: String(newBalance) })
      .where(eq(users.id, userId));

    await tx.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      type,
      amount: String(delta),
      balanceBefore: String(currentBalance),
      balanceAfter: String(newBalance),
      relatedId: relatedId ?? null,
      description,
    });
  }

  /**
   * Get user's current balance
   *
   * @description Retrieves user's current balance and lifetime statistics.
   *
   * @param {string} userId - User ID
   * @returns {Promise<BalanceInfo>} Balance information
   * @throws {Error} If user not found
   *
   * @example
   * ```typescript
   * const balance = await WalletService.getBalance(userId);
   * console.log(`Balance: $${balance.balance}`);
   * ```
   */
  static async getBalance(
    userId: string,
    dbClient?: Transaction | DrizzleClient
  ): Promise<BalanceInfo> {
    const result = await (dbClient ?? dbWrite)
      .select({
        virtualBalance: users.virtualBalance,
        totalDeposited: users.totalDeposited,
        totalWithdrawn: users.totalWithdrawn,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    return {
      balance: Number(user.virtualBalance ?? 0),
      totalDeposited: Number(user.totalDeposited ?? 0),
      totalWithdrawn: Number(user.totalWithdrawn ?? 0),
      lifetimePnL: Number(user.lifetimePnL ?? 0),
    };
  }

  /**
   * Check if user has sufficient balance
   *
   * @description Checks if user has enough balance for a transaction.
   *
   * @param {string} userId - User ID
   * @param {number} requiredAmount - Required amount
   * @returns {Promise<boolean>} True if user has sufficient balance
   *
   * @example
   * ```typescript
   * if (await WalletService.hasSufficientBalance(userId, 100)) {
   *   // Proceed with transaction
   * }
   * ```
   */
  static async hasSufficientBalance(
    userId: string,
    requiredAmount: number
  ): Promise<boolean> {
    const result = await db
      .select({
        virtualBalance: users.virtualBalance,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const [user] = result;
    if (!user) {
      return false;
    }

    return Number(user.virtualBalance ?? 0) >= requiredAmount;
  }

  /**
   * Debit from user's balance (opening position, buying shares)
   *
   * @description Debits an amount from user's balance. Used when opening
   * positions or buying shares. Creates a transaction record.
   *
   * @param {string} userId - User ID
   * @param {number} amount - Amount to debit
   * @param {string} type - Transaction type identifier
   * @param {string} description - Transaction description
   * @param {string} [relatedId] - Optional related entity ID
   * @param {Transaction} [tx] - Optional transaction client for atomic operations
   * @returns {Promise<void>}
   * @throws {Error} If user not found or insufficient balance
   *
   * @example
   * ```typescript
   * await WalletService.debit(userId, 100, 'pred_buy', 'Buying shares', tradeId);
   * ```
   */
  static async debit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    relatedId?: string,
    tx?: Transaction | DrizzleClient,
    afterCommit?: AfterCommitScheduler
  ): Promise<void> {
    WalletService.assertValidAmount('debit', userId, amount);
    const delta = -amount;

    if (tx) {
      await WalletService.applyBalanceChange(
        tx,
        userId,
        delta,
        type,
        description,
        relatedId
      );
    } else {
      await withTransaction(async (transaction) => {
        await WalletService.applyBalanceChange(
          transaction,
          userId,
          delta,
          type,
          description,
          relatedId
        );
      });
    }

    if (afterCommit) afterCommit(() => WalletService.invalidateCache(userId));
    else await WalletService.invalidateCache(userId);
  }

  /**
   * Credit to user's balance (closing position with profit, payouts)
   */
  static async credit(
    userId: string,
    amount: number,
    type: string,
    description: string,
    relatedId?: string,
    tx?: Transaction | DrizzleClient,
    afterCommit?: AfterCommitScheduler
  ): Promise<void> {
    WalletService.assertValidAmount('credit', userId, amount);
    if (tx) {
      await WalletService.applyBalanceChange(
        tx,
        userId,
        amount,
        type,
        description,
        relatedId
      );
    } else {
      await withTransaction(async (transaction) => {
        await WalletService.applyBalanceChange(
          transaction,
          userId,
          amount,
          type,
          description,
          relatedId
        );
      });
    }

    if (afterCommit) afterCommit(() => WalletService.invalidateCache(userId));
    else await WalletService.invalidateCache(userId);
  }

  /**
   * Record PnL (update lifetime PnL and earned points)
   *
   * Locks the user row and updates lifetimePnL and earnedPoints atomically.
   * Pass `tx` when the caller already holds a transaction that mutated this
   * user (e.g. a wallet debit/credit) — opening a second transaction against
   * the same locked row would block on the caller's own lock.
   *
   * lifetimePnL is part of the cached balance row, so this drops that cache
   * exactly like debit/credit do: deferred to `afterCommit` when the caller
   * schedules post-commit effects, otherwise after the mutation returns.
   */
  static async recordPnL(
    userId: string,
    pnl: number,
    tradeType: string,
    relatedId?: string,
    tx?: Transaction | DrizzleClient,
    afterCommit?: AfterCommitScheduler
  ): Promise<{
    previousLifetimePnL: number;
    newLifetimePnL: number;
    earnedPointsDelta: number;
  }> {
    // Reject non-finite PnL to prevent lifetime stats corruption
    if (!Number.isFinite(pnl)) {
      throw new Error(
        `Invalid PnL for ${userId}: pnl=${pnl}, tradeType=${tradeType}`
      );
    }

    const apply = async (transaction: Transaction | DrizzleClient) => {
      const [user] = await transaction
        .select({ lifetimePnL: users.lifetimePnL })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for('update');

      if (!user) {
        // Fail-fast: NPCs should have User records after bootstrap (ensureNpcUsers).
        // A missing user here indicates a bug in bootstrap or an invalid userId.
        throw new Error(
          `User not found for PnL recording: ${userId}. NPCs should have User records after bootstrap.`
        );
      }

      const previousLifetimePnL = Number(user.lifetimePnL);
      const newLifetimePnL = previousLifetimePnL + pnl;

      if (!Number.isFinite(newLifetimePnL)) {
        throw new Error(
          `Invalid lifetimePnL for ${userId}: prev=${previousLifetimePnL}, delta=${pnl}`
        );
      }

      await transaction
        .update(users)
        .set({ lifetimePnL: String(newLifetimePnL) })
        .where(eq(users.id, userId));

      // Award earned points within the same transaction (row already locked)
      const earnedPointsDelta =
        await EarnedPointsService.awardEarnedPointsForPnL(
          userId,
          newLifetimePnL,
          tradeType,
          relatedId,
          transaction
        );

      return {
        previousLifetimePnL,
        newLifetimePnL,
        earnedPointsDelta,
      };
    };

    const result = tx ? apply(tx) : withTransaction(apply);
    if (afterCommit) afterCommit(() => WalletService.invalidateCache(userId));
    else await WalletService.invalidateCache(userId);
    return result;
  }

  /**
   * Get transaction history
   */
  static async getTransactionHistory(
    userId: string,
    limit = 50
  ): Promise<TransactionHistoryItem[]> {
    const transactions = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId))
      .orderBy(desc(balanceTransactions.createdAt))
      .limit(limit);

    return transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: Number(tx.amount),
      balanceBefore: Number(tx.balanceBefore),
      balanceAfter: Number(tx.balanceAfter),
      description: tx.description,
      relatedId: tx.relatedId,
      createdAt: tx.createdAt,
    }));
  }
}
