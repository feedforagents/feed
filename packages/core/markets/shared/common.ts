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

/**
 * Credit failed before any balance change committed.
 * Ambiguous failures (timeout, dropped connection) must not use this type:
 * the credit may already have been applied.
 */
export class WalletCreditNotAppliedError extends Error {
  readonly creditApplied = false as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WalletCreditNotAppliedError';
  }
}

const AMBIGUOUS_CREDIT_FAILURE =
  /timeout|etimedout|econnreset|econnrefused|econnaborted|connection|socket|deadlock|too many connections/i;

/**
 * Transport and lock failures where the wallet may have committed the credit
 * before the client observed the error.
 */
export function isAmbiguousCreditFailure(err: unknown): boolean {
  return err instanceof Error && AMBIGUOUS_CREDIT_FAILURE.test(err.message);
}

/**
 * True when the caller knows the credit did not commit.
 * Checks the flag as well as the class so a duplicated module copy still matches.
 */
export function isKnownCreditNotApplied(err: unknown): boolean {
  if (err instanceof WalletCreditNotAppliedError) return true;
  if (typeof err !== 'object' || err === null) return false;
  return (
    'creditApplied' in err &&
    (err as { creditApplied?: unknown }).creditApplied === false
  );
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
  }): Promise<void>;
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
