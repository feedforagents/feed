import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FeeService } from '../../engine/src/services/fee-service';

type Row = {
  id: string;
  userId: string;
  tradeType: string;
  tradeAmount: string;
  tradeId: string | null;
  marketId: string | null;
  idempotencyKey: string | null;
};

let pendingRows: Row[] = [];
/** IDs still present in the table (claimable). */
let claimable = new Set<string>();
const processTradingFee = mock(async () => undefined);

const tx = {
  delete: () => ({
    where: (predicate: { id: string }) => ({
      returning: async () => {
        if (!claimable.has(predicate.id)) return [];
        claimable.delete(predicate.id);
        return [{ id: predicate.id }];
      },
    }),
  }),
};

mock.module('@feed/db', () => ({
  db: {},
  dbWrite: {
    select: () => ({
      from: () => ({
        orderBy: () => ({ limit: async () => pendingRows }),
      }),
    }),
  },
  eq: (_column: unknown, id: string) => ({ id }),
  tradingFeeOutbox: { id: 'id', createdAt: 'createdAt' },
  withTransaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
}));

const { drainTradingFeeOutboxBatch } = await import(
  '../../engine/src/services/trading-fee-outbox'
);

const row = (id: string, idempotencyKey: string | null = null): Row => ({
  id,
  userId: 'user-1',
  tradeType: 'perp_open',
  tradeAmount: '100',
  tradeId: 'pos-1',
  marketId: 'BTC',
  idempotencyKey,
});

const originalProcessTradingFee = FeeService.processTradingFee;

beforeEach(() => {
  processTradingFee.mockClear();
  // @ts-expect-error test stub replaces the static method
  FeeService.processTradingFee = processTradingFee;
  pendingRows = [];
  claimable = new Set();
});

afterEach(() => {
  FeeService.processTradingFee = originalProcessTradingFee;
});

describe('drainTradingFeeOutboxBatch', () => {
  test('processes rows it claims', async () => {
    pendingRows = [row('a'), row('b')];
    claimable = new Set(['a', 'b']);

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 2, processed: 2, failed: 0 });
    expect(processTradingFee).toHaveBeenCalledTimes(2);
  });

  test('never charges a row another drain already claimed', async () => {
    // Both drains selected row "a"; the other drain claimed it first.
    pendingRows = [row('a')];
    claimable = new Set();

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 1, processed: 0, failed: 0 });
    expect(processTradingFee).not.toHaveBeenCalled();
  });

  test('concurrent drains over the same rows charge each row once', async () => {
    pendingRows = [row('a'), row('b')];
    claimable = new Set(['a', 'b']);

    const [first, second] = await Promise.all([
      drainTradingFeeOutboxBatch(),
      drainTradingFeeOutboxBatch(),
    ]);

    expect(first.processed + second.processed).toBe(2);
    expect(processTradingFee).toHaveBeenCalledTimes(2);
  });

  test('replays the stored idempotency key so a retried fee is not charged twice', async () => {
    pendingRows = [row('a', 'key-1')];
    claimable = new Set(['a']);

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 1, processed: 1, failed: 0 });
    expect(processTradingFee).toHaveBeenCalledTimes(1);
    expect(processTradingFee.mock.calls[0]?.[6]).toBe('key-1');
  });
});
