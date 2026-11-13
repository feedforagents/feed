import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = {
  id: string;
  userId: string;
  tradeType: string;
  tradeAmount: string;
  tradeId: string | null;
  marketId: string | null;
  idempotencyKey?: string | null;
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

mock.module('@feed/engine', () => ({
  FeeService: { processTradingFee },
  isValidFeeType: (type: string) => type === 'perp_open',
}));

const { drainTradingFeeOutboxBatch } = await import(
  '../../../apps/web/src/lib/services/trading-fee-outbox'
);

const row = (id: string): Row => ({
  id,
  userId: 'user-1',
  tradeType: 'perp_open',
  tradeAmount: '100',
  tradeId: 'pos-1',
  marketId: 'BTC',
});

beforeEach(() => {
  processTradingFee.mockClear();
  pendingRows = [];
  claimable = new Set();
});

describe('drainTradingFeeOutboxBatch', () => {
  test('processes rows it claims', async () => {
    pendingRows = [row('a'), row('b')];
    claimable = new Set(['a', 'b']);

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 2, processed: 2, failed: 0 });
    expect(processTradingFee).toHaveBeenCalledTimes(2);
  });

  test('forwards the stored key so an already-settled fee replays instead of charging again', async () => {
    pendingRows = [{ ...row('a'), idempotencyKey: 'op-key-1' }];
    claimable = new Set(['a']);

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 1, processed: 1, failed: 0 });
    expect(processTradingFee).toHaveBeenCalledTimes(1);
    expect(processTradingFee).toHaveBeenCalledWith(
      'user-1',
      'perp_open',
      100,
      'pos-1',
      'BTC',
      expect.anything(),
      'op-key-1'
    );
  });

  test('drains keyless rows unkeyed, as before', async () => {
    pendingRows = [row('a')];
    claimable = new Set(['a']);

    const result = await drainTradingFeeOutboxBatch();

    expect(result).toEqual({ examined: 1, processed: 1, failed: 0 });
    expect(processTradingFee).toHaveBeenCalledWith(
      'user-1',
      'perp_open',
      100,
      'pos-1',
      'BTC',
      expect.anything(),
      undefined
    );
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
});
