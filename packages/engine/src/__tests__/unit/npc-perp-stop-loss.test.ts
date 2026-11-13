/**
 * NPC portfolio risk controls must see live perp positions.
 *
 * Live NPC perp positions live in `perpPositions` (opened via
 * PerpMarketService). `poolPositions` only holds prediction mirrors and
 * legacy perp rows, so the stop-loss / profit-take / de-risk finders in
 * NPCInvestmentManager — which only queried `poolPositions` — never
 * produced a close action for a losing or over-leveraged perp position.
 * The position then bled until liquidation instead of being stop-lossed.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const poolPositionsTable = {
  __table: 'poolPositions',
  id: 'id',
  poolId: 'poolId',
  marketType: 'marketType',
  marketId: 'marketId',
  ticker: 'ticker',
  side: 'side',
  size: 'size',
  shares: 'shares',
  entryPrice: 'entryPrice',
  currentPrice: 'currentPrice',
  unrealizedPnL: 'unrealizedPnL',
  realizedPnL: 'realizedPnL',
  leverage: 'leverage',
  openedAt: 'openedAt',
  closedAt: 'closedAt',
  updatedAt: 'updatedAt',
};
const perpPositionsTable = {
  __table: 'perpPositions',
  id: 'id',
  userId: 'userId',
  ticker: 'ticker',
  organizationId: 'organizationId',
  side: 'side',
  entryPrice: 'entryPrice',
  currentPrice: 'currentPrice',
  size: 'size',
  leverage: 'leverage',
  unrealizedPnL: 'unrealizedPnL',
  openedAt: 'openedAt',
  closedAt: 'closedAt',
};
const actorStateTable = { __table: 'actorState', id: 'id' };
const actorRelationshipsTable = { __table: 'actorRelationships' };
const organizationStateTable = { __table: 'organizationState' };
const poolsTable = { __table: 'pools' };

type Row = Record<string, unknown>;
let poolRows: Row[] = [];
let perpRows: Row[] = [];

type WhereResult = Promise<Row[]> & {
  orderBy: (arg: unknown) => { limit: (n: number) => Promise<Row[]> };
};

function whereResult(rows: Row[]): WhereResult {
  const promise = Promise.resolve(rows) as WhereResult;
  promise.orderBy = () => ({
    limit: async (n: number) => rows.slice(0, n),
  });
  return promise;
}

const mockDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: (..._args: unknown[]) => {
        if (table === perpPositionsTable) return whereResult(perpRows);
        if (table === poolPositionsTable) return whereResult(poolRows);
        return whereResult([]);
      },
    }),
  }),
};

const genericStub = new Proxy(() => undefined, {
  get: () => genericStub,
  apply: () => undefined,
});

// Every name the engine/core/api graph imports from '@feed/db'. The mock
// must be a plain object with these as own keys: bun falls back to the
// real module for any named import the mock does not provide.
const feedDbNames = [
  'ActorStateRow',
  'AdminPermission',
  'AdminRoleType',
  'ArcState',
  'ArcStateType',
  'DailyTopic',
  'DailyTopicSourceType',
  'Decimal',
  'DrizzleClient',
  'GameOnboardingRow',
  'GameOnboardingState',
  'GameOnboardingStep',
  'JsonValue',
  'LongTermArcState',
  'MarketCategory',
  'MarketImpact',
  'NpcMemory',
  'PerpPosition',
  'Post',
  'Question',
  'ROLE_PERMISSIONS',
  'RelationshipState',
  'ScheduledEvent',
  'StorageMode',
  'StructuredEventData',
  'TimeframedMarket',
  'Transaction',
  'User',
  'WELCOME_BONUS_BALANCE_DESCRIPTION',
  'actorRelationships',
  'actorState',
  'adminAuditLogs',
  'adminRoles',
  'agentPerformanceMetrics',
  'agentTrades',
  'aliasedTable',
  'and',
  'arcStates',
  'asSystem',
  'asUser',
  'asc',
  'balanceTransactions',
  'buildCapitalBaseContributionSql',
  'buildDailyLoginRewardBalanceDescription',
  'chatParticipants',
  'chats',
  'checkDatabaseHealth',
  'comments',
  'count',
  'dailyTopics',
  'db',
  'dbWrite',
  'desc',
  'dmAcceptances',
  'eq',
  'exportJsonState',
  'feedbacks',
  'followStatuses',
  'follows',
  'gameConfigs',
  'gameOnboarding',
  'games',
  'generateSnowflakeId',
  'generationLocks',
  'getDbInstance',
  'getRawDrizzle',
  'getStorageMode',
  'groupInvites',
  'groupMembers',
  'groups',
  'gt',
  'gte',
  'hasBlocked',
  'inArray',
  'initializeJsonMode',
  'initializeMemoryMode',
  'isNotNull',
  'isNull',
  'isSimulationMode',
  'loadJsonSnapshot',
  'lt',
  'lte',
  'markets',
  'max',
  'messages',
  'min',
  'ne',
  'notInArray',
  'notifications',
  'npcInteractions',
  'npcTrades',
  'or',
  'organizationState',
  'organizations',
  'parodyHeadlines',
  'perpMarketSnapshots',
  'perpPositions',
  'pointsTransactions',
  'poolPositions',
  'pools',
  'positions',
  'postTags',
  'posts',
  'predictionPriceHistories',
  'profileUpdateLogs',
  'queryMonitor',
  'questionArcPlans',
  'questions',
  'reactions',
  'realtimeOutboxes',
  'referrals',
  'reports',
  'resetToPostgresMode',
  'rssFeedSources',
  'rssHeadlines',
  'saveJsonSnapshot',
  'sentryWebhookInboxes',
  'shares',
  'sql',
  'stockPrices',
  'sum',
  'systemMetricsSnapshots',
  'tags',
  'tickTokenStats',
  'timeframedMarkets',
  'tradingFees',
  'trendingTags',
  'userAchievements',
  'userActivityLogs',
  'userActorFollows',
  'userApiKeys',
  'userChallengeProgress',
  'userInteractions',
  'users',
  'whitelist',
  'whitelistConfig',
  'widgetCaches',
  'withTransaction',
  'worldEvents',
  'worldFacts',
  'worldStateSnapshots',
];

mock.module('@feed/db', () => {
  const mocked: Record<string, unknown> = {};
  for (const name of feedDbNames) mocked[name] = genericStub;
  mocked.db = mockDb;
  mocked.poolPositions = poolPositionsTable;
  mocked.perpPositions = perpPositionsTable;
  mocked.actorState = actorStateTable;
  mocked.actorRelationships = actorRelationshipsTable;
  mocked.organizationState = organizationStateTable;
  mocked.pools = poolsTable;
  return mocked;
});

// Import after mocks are set up
import { NPCInvestmentManager } from '../../npc/npc-investment-manager';

type PortfolioPositionLike = {
  id: string;
  marketType: string;
  ticker?: string;
  side: string;
};

type RebalanceActionLike = {
  type: string;
  positionId?: string;
  marketType: string;
  ticker?: string;
};

const manager = NPCInvestmentManager as unknown as {
  findPositionsWithLargeDrawdowns: (
    poolId: string,
    threshold: number
  ) => Promise<PortfolioPositionLike[]>;
  findPositionsWithLargeProfits: (
    poolId: string,
    threshold: number
  ) => Promise<PortfolioPositionLike[]>;
  generateDeRiskingActions: (
    poolId: string,
    metrics: { riskScore: number; unrealizedPnL: number }
  ) => Promise<RebalanceActionLike[]>;
};

const POOL_ID = 'test-npc-pool';

function perpRow(overrides: Row = {}): Row {
  return {
    id: 'perp-1',
    userId: POOL_ID,
    ticker: 'NVDAI',
    organizationId: 'nvidai',
    side: 'long',
    entryPrice: 100,
    currentPrice: 95,
    size: 10000,
    leverage: 5,
    unrealizedPnL: -500,
    openedAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

function predictionRow(overrides: Row = {}): Row {
  return {
    id: 'pred-1',
    poolId: POOL_ID,
    marketType: 'prediction',
    marketId: 'm1',
    side: 'YES',
    entryPrice: 50,
    currentPrice: 60,
    size: 100,
    shares: 2,
    unrealizedPnL: -25,
    leverage: null,
    openedAt: new Date(),
    closedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('NPCInvestmentManager perp stop-loss / profit-take / de-risk', () => {
  beforeEach(() => {
    poolRows = [];
    perpRows = [];
  });

  test('flags a losing live perp position for stop-loss', async () => {
    // -500 on 10000 notional at 5x = -25% of the 2000 margin, past the
    // 20% stop-loss threshold. Against notional it is only -5%, so a
    // notional-based check would (wrongly) stay silent.
    perpRows = [perpRow({ unrealizedPnL: -500 })];

    const lossy = await manager.findPositionsWithLargeDrawdowns(POOL_ID, 0.2);

    expect(lossy).toHaveLength(1);
    expect(lossy[0]?.id).toBe('perp-1');
    expect(lossy[0]?.marketType).toBe('perp');
    expect(lossy[0]?.ticker).toBe('NVDAI');
  });

  test('does not flag a perp loss below the margin threshold', async () => {
    perpRows = [perpRow({ unrealizedPnL: -100 })]; // -5% of margin

    const lossy = await manager.findPositionsWithLargeDrawdowns(POOL_ID, 0.2);

    expect(lossy).toHaveLength(0);
  });

  test('flags a profitable live perp position for profit-taking', async () => {
    // +600 on 2000 margin = +30% of margin, past the 25% threshold.
    perpRows = [perpRow({ unrealizedPnL: 600 })];

    const winners = await manager.findPositionsWithLargeProfits(POOL_ID, 0.25);

    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe('perp-1');
    expect(winners[0]?.marketType).toBe('perp');
  });

  test('still flags losing prediction positions', async () => {
    poolRows = [predictionRow({ unrealizedPnL: -25 })]; // -25% of cost

    const lossy = await manager.findPositionsWithLargeDrawdowns(POOL_ID, 0.2);

    expect(lossy).toHaveLength(1);
    expect(lossy[0]?.id).toBe('pred-1');
  });

  test('does not double-count a perp position mirrored in poolPositions', async () => {
    poolRows = [
      predictionRow({
        id: 'perp-1',
        marketType: 'perp',
        ticker: 'NVDAI',
        marketId: undefined,
        side: 'long',
        entryPrice: 100,
        currentPrice: 95,
        size: 10000,
        unrealizedPnL: -500,
        leverage: 5,
      }),
    ];
    perpRows = [perpRow({ unrealizedPnL: -500 })];

    const lossy = await manager.findPositionsWithLargeDrawdowns(POOL_ID, 0.2);

    expect(lossy).toHaveLength(1);
    expect(lossy[0]?.id).toBe('perp-1');
  });

  test('ignores closed perp positions', async () => {
    perpRows = [perpRow({ unrealizedPnL: -500, closedAt: new Date() })];

    const lossy = await manager.findPositionsWithLargeDrawdowns(POOL_ID, 0.2);

    expect(lossy).toHaveLength(0);
  });

  test('de-risking closes a high-leverage live perp position', async () => {
    perpRows = [perpRow({ unrealizedPnL: -500 })];

    const actions = await manager.generateDeRiskingActions(POOL_ID, {
      riskScore: 0.8,
      unrealizedPnL: -100,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('close');
    expect(actions[0]?.positionId).toBe('perp-1');
    expect(actions[0]?.marketType).toBe('perp');
    expect(actions[0]?.ticker).toBe('NVDAI');
  });
});
