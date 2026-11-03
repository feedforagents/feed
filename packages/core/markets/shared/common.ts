export type MarketKind = 'prediction' | 'perp';

export interface FeeConfig {
  tradingFeeRate: number; // e.g. 0.001 = 0.1%
  platformShare: number; // 0-1
  referrerShare: number; // 0-1
  minFeeAmount: number;
}

export interface FeeProcessor {
  processTradingFee: (params: {
    userId: string;
    amount: number;
    type: string;
    relatedId?: string;
    positionId?: string;
  }) => Promise<{ feeCharged: number; referrerPaid?: number }>;
}

/**
 * Persists failed fee processing for asynchronous retry (transactional outbox companion).
 * Enqueue runs after inline retries are exhausted so fee intent is never dropped silently.
 */
export interface TradingFeeOutboxPort {
  enqueue(params: {
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
    lastError?: string;
  }): Promise<void>;
}

export interface WalletPort {
  debit(params: {
    userId: string;
    amount: number;
    reason: string;
    description?: string;
    relatedId?: string;
  }): Promise<void>;
  credit(params: {
    userId: string;
    amount: number;
    reason: string;
    description?: string;
    relatedId?: string;
    /**
     * Stable id for this credit attempt. Stored as the balance-transaction
     * primary key so a retry or a lost response can see whether it landed.
     * `relatedId` stays the domain id (market id for prediction sells).
     */
    idempotencyKey?: string;
  }): Promise<void>;
  /**
   * True when a credit with this attempt id is already stored.
   * Missing means the wallet cannot tell; callers must not treat that as
   * "not applied".
   */
  creditWasApplied?(params: {
    userId: string;
    idempotencyKey: string;
  }): Promise<boolean>;
  recordPnL(params: {
    userId: string;
    pnl: number;
    reason: string;
    relatedId?: string;
  }): Promise<void>;
  getBalance(
    userId: string
  ): Promise<{ balance: number; lifetimePnL?: number }>;
}

export interface BroadcastPort {
  emit(channel: string, payload: Record<string, unknown>): Promise<void>;
}

export interface CachePort {
  invalidate(pattern: string): Promise<void>;
}

export interface ClockPort {
  now(): Date;
}

export interface DbTransaction<T = void> {
  <R>(fn: (tx: T) => Promise<R>): Promise<R>;
}
