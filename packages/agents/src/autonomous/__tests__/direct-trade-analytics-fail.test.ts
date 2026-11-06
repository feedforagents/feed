import { describe, expect, mock, test } from 'bun:test';

/**
 * REPRO (candidate): DirectExecutors awaits agentPnLService.recordTrade
 * AFTER the trade has committed, with no error guard — in all four trade
 * paths (prediction buy/sell, perp open/close). recordTrade does real DB
 * reads + a withTransaction insert, so a transient DB failure throws.
 * executeDirectTrade has no try/catch, and MultiStepExecutor converts the
 * throw into `{ success: false, summary: 'Trade failed: ...' }` — a
 * committed trade reported as failed, inviting a retry that double-buys
 * (prediction buy / perp open) or re-sells an already-closed position.
 *
 * The four plugin-agent actions (buy/sell-prediction, open/close-perp)
 * already guard this exact call with `.catch(...)` and the comment "The
 * [trade] is committed, so an analytics failure must not report it as
 * failed". DirectExecutors missed the same guard.
 *
 * Expected after fix: executeDirectTrade resolves `{ success: true }`
 * even when recordTrade throws; the analytics failure is only logged.
 */

let committedBuy = false;
let committedSell = false;
let committedPerpOpen = false;
let committedPerpClose = false;

const recordTradeMock = mock(async () => {
  throw new Error('DB unavailable');
});

class MockPredictionDbAdapter {
  async getPosition() {
    return { id: 'pos-1', status: 'active', shares: 10 };
  }
}

class MockPerpMarketService {
  async openPosition() {
    committedPerpOpen = true;
    return { entryPrice: 100 };
  }
  async closePosition() {
    committedPerpClose = true;
    return { realizedPnL: 2, exitPrice: 101, size: 100 };
  }
}

mock.module('@feed/db', () => ({
  actorState: { id: 'id', tradingBalance: 'tradingBalance' },
  aliasedTable: mock(() => ({})),
  and: (...args: unknown[]) => args,
  asSystem: (_ctx: unknown, fn: () => unknown) => fn(),
  asUser: (_ctx: unknown, fn: () => unknown) => fn(),
  chatParticipants: {},
  chats: {},
  comments: {},
  db: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => [
            {
              id: 'perp-pos-1',
              userId: 'agent-1',
              ticker: 'ABC',
              side: 'long',
            },
          ]),
        })),
      })),
    })),
  },
  desc: mock(() => ({})),
  dmAcceptances: {},
  eq: (a: unknown, b: unknown) => ({ a, b }),
  follows: {},
  groupMembers: {},
  groups: {},
  gte: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  messages: {},
  perpPositions: {},
  posts: {},
  reactions: {},
  shares: {},
  sql: {},
  users: { id: 'id', displayName: 'displayName' },
}));

mock.module('@feed/api', () => ({
  broadcastAgentActivity: mock(async () => undefined),
  broadcastChatMessage: mock(async () => undefined),
  broadcastToChannel: mock(async () => undefined),
  cachedDb: { invalidateUserCache: mock(async () => undefined) },
  notifyGroupChatMessage: mock(async () => undefined),
}));

mock.module('@feed/core/markets/perps', () => ({
  PerpDbAdapter: class {},
  PerpMarketService: MockPerpMarketService,
}));

mock.module('@feed/core/markets/prediction', () => ({
  PredictionDbAdapter: MockPredictionDbAdapter,
  PredictionMarketService: class {},
}));

mock.module('@feed/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0,
    PLATFORM_SHARE: 0,
    REFERRER_SHARE: 0,
    MIN_FEE_AMOUNT: 0,
    FEE_TYPES: {},
  },
  FeeService: { processTradingFee: mock(async () => ({ feeCharged: 0 })) },
  createNpcWalletAdapter: mock(() => ({})),
  createPerpPriceImpactPort: mock(() => ({})),
  createPerpSettlement: mock(() => ({})),
  generateTagsFromPost: mock(async () => []),
  invalidateAfterPredictionTrade: mock(async () => undefined),
  PredictionPricing: {
    getCurrentPrice: mock(() => 0.5),
  },
  StaticDataRegistry: {
    getActor: mock(() => null),
    getAllOrganizations: mock(() => [{ ticker: 'ABC', initialPrice: 100 }]),
  },
  storeTagsForPost: mock(async () => undefined),
  WalletService: { getBalance: mock(async () => ({ balance: 10_000 })) },
  withPredictionSettlement: mock(
    async (
      _marketId: string,
      _context: unknown,
      operation: (service: unknown) => Promise<unknown>
    ) => {
      const fakeService = {
        buy: mock(async () => {
          committedBuy = true;
          return { avgPrice: 0.5, shares: 10 };
        }),
        sell: mock(async () => {
          committedSell = true;
          return {
            netProceeds: 5,
            avgPrice: 0.5,
            pnl: 1,
            remainingShares: 0,
          };
        }),
        getMarket: mock(async () => ({ id: 'm1' })),
      };
      return operation(fakeService);
    }
  ),
}));

mock.module('@feed/shared', () => ({
  floorPoints: (n: number) => Math.floor(n * 100) / 100,
  isPureRepost: () => false,
}));

mock.module('../../shared/logger', () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module('../../shared/snowflake', () => ({
  generateSnowflakeId: mock(async () => 'snowflake-id'),
}));

mock.module('../../services/AgentPnLService', () => ({
  agentPnLService: { recordTrade: recordTradeMock },
}));

mock.module('../TopicDiversityService', () => ({
  topicDiversityService: { trackPostTopics: mock(async () => undefined) },
}));

mock.module('../utils/resolvePerpTicker', () => ({
  resolvePerpTicker: mock(() => ({ ticker: 'ABC' })),
}));

const { executeDirectTrade } = await import('../DirectExecutors');

describe('committed DirectExecutor trade vs analytics failure', () => {
  test('prediction buy still succeeds when recordTrade throws', async () => {
    committedBuy = false;
    const result = await executeDirectTrade({
      agentUserId: 'agent-1',
      marketType: 'prediction',
      marketId: 'm1',
      side: 'buy_yes',
      amount: 100,
    });
    expect(committedBuy).toBe(true);
    expect(result.success).toBe(true);
    expect(result.shares).toBe(10);
  });

  test('prediction sell still succeeds when recordTrade throws', async () => {
    committedSell = false;
    const result = await executeDirectTrade({
      agentUserId: 'agent-1',
      marketType: 'prediction',
      marketId: 'm1',
      side: 'sell_yes',
      amount: 0,
    });
    expect(committedSell).toBe(true);
    expect(result.success).toBe(true);
  });

  test('perp open still succeeds when recordTrade throws', async () => {
    committedPerpOpen = false;
    const result = await executeDirectTrade({
      agentUserId: 'agent-1',
      marketType: 'perp',
      marketId: 'ABC',
      side: 'open_long',
      amount: 100,
    });
    expect(committedPerpOpen).toBe(true);
    expect(result.success).toBe(true);
  });

  test('perp close still succeeds when recordTrade throws', async () => {
    committedPerpClose = false;
    const result = await executeDirectTrade({
      agentUserId: 'agent-1',
      marketType: 'perp',
      marketId: 'ABC',
      side: 'close_position',
      amount: 0,
    });
    expect(committedPerpClose).toBe(true);
    expect(result.success).toBe(true);
  });
});
