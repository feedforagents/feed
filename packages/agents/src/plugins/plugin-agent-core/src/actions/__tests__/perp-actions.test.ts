import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

const openPositionMock = mock(
  async (input: { size: number; leverage: number }) => ({
    positionId: 'pos-1',
    entryPrice: 100,
    size: input.size,
    leverage: input.leverage,
  })
);
const closePositionMock = mock(async (input: { percentage?: number }) => ({
  size: input.percentage === undefined ? 1000 : 1000 * input.percentage,
  realizedPnL: 5,
  remainingSize:
    input.percentage === undefined ? 0 : 1000 * (1 - input.percentage),
  exitPrice: 101,
}));
const recordTradeMock = mock(async () => {
  throw new Error('analytics down');
});

let openPositionRow: Record<string, unknown> | null = {
  id: 'pos-1',
  ticker: 'ABC',
  side: 'long',
  size: 1000,
  entryPrice: 100,
};

mock.module('@feed/db', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  isNull: (a: unknown) => a,
  perpPositions: {},
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (openPositionRow ? [openPositionRow] : []),
        }),
      }),
    }),
  },
}));

mock.module('@feed/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {
    getMarketsSnapshot = async () => [{ ticker: 'ABC' }];
    openPosition = openPositionMock;
    closePosition = closePositionMock;
  },
}));

mock.module('@feed/engine', () => ({
  createPerpPriceImpactPort: () => ({}),
  createTradingFeeProcessor: () => ({
    processTradingFee: async () => ({}),
  }),
  createUserWalletAdapter: () => ({}),
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.001,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0.01,
  },
  FeeService: { processTradingFee: async () => ({}) },
  WalletService: { getBalance: async () => ({ balance: 10_000 }) },
}));

mock.module('../../../../../services/AgentPnLService', () => ({
  AgentPnLService: class {
    recordTrade = recordTradeMock;
  },
}));

const { openPerpAction } = await import('../open-perp');
const { closePerpAction } = await import('../close-perp');

const runtime = { agentId: '123456789012345678' } as IAgentRuntime;
const message = {} as Memory;
const stateWith = (actionParams: Record<string, unknown>) =>
  ({ data: { actionParams } }) as unknown as State;

describe('OPEN_PERP', () => {
  beforeEach(() => {
    openPositionMock.mockClear();
  });

  test('treats amount as collateral and opens notional = amount x leverage', async () => {
    const result = await openPerpAction.handler(
      runtime,
      message,
      stateWith({ ticker: 'ABC', side: 'LONG', amount: 100, leverage: 5 })
    );

    expect(result?.success).toBe(true);
    expect(openPositionMock).toHaveBeenCalledTimes(1);
    const call = openPositionMock.mock.calls[0]?.[0];
    expect(call?.size).toBe(500);
    expect(call?.leverage).toBe(5);
  });

  test('reports success when analytics recording fails after the trade', async () => {
    const result = await openPerpAction.handler(
      runtime,
      message,
      stateWith({ ticker: 'ABC', side: 'SHORT', amount: 50 })
    );
    expect(result?.success).toBe(true);
  });

  test.each([
    [Number.NaN],
    [-10],
    [0],
    [Number.POSITIVE_INFINITY],
  ])('rejects invalid amount %p without trading', async (amount) => {
    const result = await openPerpAction.handler(
      runtime,
      message,
      stateWith({ ticker: 'ABC', side: 'LONG', amount })
    );
    expect(result?.success).toBe(false);
    expect(openPositionMock).not.toHaveBeenCalled();
  });

  test('rejects non-finite leverage', async () => {
    const result = await openPerpAction.handler(
      runtime,
      message,
      stateWith({
        ticker: 'ABC',
        side: 'LONG',
        amount: 10,
        leverage: Number.NaN,
      })
    );
    expect(result?.success).toBe(false);
    expect(openPositionMock).not.toHaveBeenCalled();
  });
});

describe('CLOSE_PERP', () => {
  beforeEach(() => {
    closePositionMock.mockClear();
    openPositionRow = {
      id: 'pos-1',
      ticker: 'ABC',
      side: 'long',
      size: 1000,
      entryPrice: 100,
    };
  });

  test.each([
    [0],
    [-5],
    [Number.NaN],
    [5000],
  ])('never closes on invalid explicit amount %p', async (amount) => {
    const result = await closePerpAction.handler(
      runtime,
      message,
      stateWith({ positionId: 'pos-1', amount })
    );
    expect(result?.success).toBe(false);
    expect(closePositionMock).not.toHaveBeenCalled();
  });

  test('partial close uses the requested notional amount', async () => {
    const result = await closePerpAction.handler(
      runtime,
      message,
      stateWith({ positionId: 'pos-1', amount: 250 })
    );
    expect(result?.success).toBe(true);
    expect(closePositionMock.mock.calls[0]?.[0]?.percentage).toBe(0.25);
  });

  test('omitted amount performs a full close', async () => {
    const result = await closePerpAction.handler(
      runtime,
      message,
      stateWith({ positionId: 'pos-1' })
    );
    expect(result?.success).toBe(true);
    expect(closePositionMock.mock.calls[0]?.[0]?.percentage).toBeUndefined();
  });
});
