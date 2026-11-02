import { describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

let capturedDeps: Record<string, unknown> | null = null;

const processTradingFeeMock = mock(
  async () =>
    ({ feeCharged: 0, referrerPaid: 0 }) as unknown as Record<string, unknown>
);

mock.module('@feed/db', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  isNull: (a: unknown) => a,
  perpPositions: {},
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 'pos-1',
              ticker: 'ABC',
              side: 'long',
              size: 1000,
              entryPrice: 100,
            },
          ],
        }),
      }),
    }),
  },
}));

mock.module('@feed/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {
    constructor(deps: Record<string, unknown>) {
      capturedDeps = deps;
    }
    getMarketsSnapshot = async () => [{ ticker: 'ABC' }];
    openPosition = async (input: { size: number; leverage: number }) => ({
      positionId: 'pos-1',
      entryPrice: 100,
      size: input.size,
      leverage: input.leverage,
    });
    closePosition = async () => ({
      size: 1000,
      realizedPnL: 5,
      remainingSize: 0,
      exitPrice: 101,
    });
  },
}));

mock.module('@feed/engine', () => ({
  createPerpPriceImpactPort: () => ({}),
  createUserWalletAdapter: () => ({}),
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.001,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0.01,
    FEE_TYPES: {
      PERP_OPEN: 'perp_open',
      PERP_CLOSE: 'perp_close',
    },
  },
  FeeService: { processTradingFee: processTradingFeeMock },
  WalletService: { getBalance: async () => ({ balance: 10_000 }) },
}));

mock.module('../../../../../services/AgentPnLService', () => ({
  AgentPnLService: class {
    recordTrade = async () => undefined;
  },
}));

const { openPerpAction } = await import('../open-perp');
const { closePerpAction } = await import('../close-perp');

const runtime = { agentId: '123456789012345678' } as IAgentRuntime;
const message = {} as Memory;
const stateWith = (actionParams: Record<string, unknown>) =>
  ({ data: { actionParams } }) as unknown as State;

describe('plugin perp fee settlement wiring', () => {
  test('OPEN_PERP wires a feeProcessor that delegates to FeeService', async () => {
    capturedDeps = null;
    const result = await openPerpAction.handler(
      runtime,
      message,
      stateWith({ ticker: 'ABC', side: 'LONG', amount: 100, leverage: 5 })
    );
    expect(result?.success).toBe(true);
    const feeProcessor = capturedDeps?.feeProcessor as
      | {
          processTradingFee: (
            args: Record<string, unknown>
          ) => Promise<unknown>;
        }
      | undefined;
    expect(feeProcessor).toBeDefined();
    await feeProcessor?.processTradingFee({
      userId: 'user-1',
      amount: 0.5,
      type: 'perp_open',
      relatedId: 'rel-1',
      positionId: 'pos-1',
    });
    expect(processTradingFeeMock).toHaveBeenCalledWith(
      'user-1',
      'perp_open',
      0.5,
      'pos-1',
      'rel-1'
    );
  });

  test('CLOSE_PERP wires a feeProcessor that delegates to FeeService', async () => {
    capturedDeps = null;
    processTradingFeeMock.mockClear();
    const result = await closePerpAction.handler(
      runtime,
      message,
      stateWith({ positionId: 'pos-1' })
    );
    expect(result?.success).toBe(true);
    const feeProcessor = capturedDeps?.feeProcessor as
      | {
          processTradingFee: (
            args: Record<string, unknown>
          ) => Promise<unknown>;
        }
      | undefined;
    expect(feeProcessor).toBeDefined();
    await feeProcessor?.processTradingFee({
      userId: 'user-1',
      amount: 0.5,
      type: 'perp_close',
      relatedId: 'rel-2',
      positionId: 'pos-1',
    });
    expect(processTradingFeeMock).toHaveBeenCalledWith(
      'user-1',
      'perp_close',
      0.5,
      'pos-1',
      'rel-2'
    );
  });
});
