import { describe, expect, mock, test } from 'bun:test';

/**
 * Regression tests for the reputation/PnL math in the engine.
 *
 * `updateTradingMetrics` writes `averageROI` (= lifetimePnL / totalDeposited)
 * to a not-null column. When an agent has no recorded deposits
 * (`totalDeposited = 0`) — e.g. funded only with a welcome bonus, or a null
 * column read back through `parseFloat` as NaN — the raw division produced
 * NaN/Infinity, which silently serialised to `null` in the user data export.
 * These tests pin the neutral `0` behaviour that the codebase already uses for
 * empty bases (see `normalizePnL` -> 0.5, `calculateWinRate` -> 0).
 */

// --- @feed/db mock (registered before the service module loads) -------------

const usersTable = {
  id: 'id',
  lifetimePnL: 'lifetimePnL',
  totalDeposited: 'totalDeposited',
};
const metricsTable = { userId: 'userId' };
const feedbacksTable = { userId: 'userId' };

const state: {
  user: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  capturedSets: Record<string, unknown>[];
} = { user: null, metrics: null, capturedSets: [] };

const fakeDb = {
  select: (_cols?: unknown) => ({
    from: (table: unknown) => ({
      where: (_cond?: unknown) => ({
        limit: async (_n?: number) => {
          if (table === usersTable) return state.user ? [state.user] : [];
          if (table === metricsTable)
            return state.metrics ? [state.metrics] : [];
          return [];
        },
      }),
    }),
  }),
  insert: (table: unknown) => ({
    values: async (v: Record<string, unknown>) => {
      if (table === metricsTable) state.metrics = v;
      return [{ id: '1' }];
    },
  }),
  update: (table: unknown) => ({
    set: (payload: Record<string, unknown>) => ({
      where: async (_cond?: unknown) => {
        if (table === metricsTable) state.capturedSets.push(payload);
        return [{}];
      },
    }),
  }),
};

mock.module('@feed/db', () => ({
  db: fakeDb,
  users: usersTable,
  agentPerformanceMetrics: metricsTable,
  feedbacks: feedbacksTable,
  eq: (_a: unknown, _b: unknown) => ({ __eq: true }),
  and: (...args: unknown[]) => args,
  desc: (x: unknown) => x,
  gte: (_a: unknown, _b: unknown) => ({ __gte: true }),
}));

// Mock @feed/shared too so the service module loads without its real
// side-effectful dependencies (logger/snowflake are irrelevant to this math).
mock.module('@feed/shared', () => ({
  generateSnowflakeId: async () => '1234567890',
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

const { calculateAverageROI, updateTradingMetrics } = await import(
  './reputation-calculation-service'
);

// --- calculateAverageROI (pure) ---------------------------------------------

describe('calculateAverageROI', () => {
  test('returns lifetimePnL / totalInvested for a normal base', () => {
    expect(calculateAverageROI(250, 1000)).toBeCloseTo(0.25);
    // A genuine loss must still yield a real negative ratio.
    expect(calculateAverageROI(-100, 1000)).toBeCloseTo(-0.1);
    expect(calculateAverageROI(0, 1000)).toBe(0);
  });

  test('returns 0 (not Infinity) when the base is zero and pnl is positive', () => {
    // Before the fix: 100 / 0 === Infinity.
    expect(calculateAverageROI(100, 0)).toBe(0);
    expect(Number.isFinite(calculateAverageROI(100, 0))).toBe(true);
  });

  test('returns 0 (not NaN) when both pnl and base are zero', () => {
    // Before the fix: 0 / 0 === NaN.
    expect(calculateAverageROI(0, 0)).toBe(0);
    expect(Number.isFinite(calculateAverageROI(0, 0))).toBe(true);
  });

  test('returns 0 (not -Infinity) when the base is zero and pnl is negative', () => {
    // Before the fix: -100 / 0 === -Infinity.
    expect(calculateAverageROI(-100, 0)).toBe(0);
    expect(Number.isFinite(calculateAverageROI(-100, 0))).toBe(true);
  });

  test('returns 0 for a non-positive base', () => {
    expect(calculateAverageROI(100, -1000)).toBe(0);
  });

  test('returns 0 for non-finite inputs', () => {
    expect(calculateAverageROI(100, Number.NaN)).toBe(0);
    expect(calculateAverageROI(Number.NaN, 1000)).toBe(0);
    expect(calculateAverageROI(Number.POSITIVE_INFINITY, 1000)).toBe(0);
  });
});

// --- updateTradingMetrics (end-to-end through the mocked db) -----------------

function setMetrics(overrides: Record<string, unknown> = {}) {
  state.metrics = {
    id: 'm1',
    userId: 'u1',
    normalizedPnL: 0.5,
    averageFeedbackScore: 0.5,
    averageIntelScore: 0.5,
    gamesPlayed: 0,
    totalFeedbackCount: 0,
    winRate: 0,
    totalTrades: 1,
    profitableTrades: 0,
    averageROI: 0,
    firstActivityAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function writtenAverageROI(): unknown {
  return state.capturedSets.find((s) => 'averageROI' in s)?.averageROI;
}

describe('updateTradingMetrics.averageROI', () => {
  test('writes a finite averageROI (0) when totalDeposited is 0', async () => {
    state.user = { lifetimePnL: 100, totalDeposited: 0 };
    setMetrics();
    state.capturedSets = [];

    await updateTradingMetrics('u1', 50, 0, false);

    const roi = writtenAverageROI();
    expect(roi).toBeDefined();
    expect(Number.isFinite(roi as number)).toBe(true);
    expect(roi).toBe(0);
  });

  test('stays finite when both pnl and deposits are zero', async () => {
    state.user = { lifetimePnL: 0, totalDeposited: 0 };
    setMetrics();
    state.capturedSets = [];

    await updateTradingMetrics('u1', 0, 0, false);

    const roi = writtenAverageROI();
    expect(Number.isFinite(roi as number)).toBe(true);
    expect(roi).toBe(0);
  });

  test('still writes the real ratio for a normal base', async () => {
    state.user = { lifetimePnL: 250, totalDeposited: 1000 };
    setMetrics();
    state.capturedSets = [];

    await updateTradingMetrics('u1', 250, 1000, true);

    const roi = writtenAverageROI();
    expect(Number.isFinite(roi as number)).toBe(true);
    expect(roi).toBeCloseTo(0.25);
  });

  test('throws when the user does not exist', async () => {
    state.user = null;
    setMetrics();
    state.capturedSets = [];

    await expect(updateTradingMetrics('missing', 10, 10, true)).rejects.toThrow(
      'not found'
    );
  });
});
