import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
import { calculatePredictionPositionSnapshot } from '../../../../../../../../packages/core/markets/prediction/positionSnapshot';
import { PredictionPricing } from '../../../../../../../../packages/core/markets/prediction/pricing';
import { MarketQuerySchema } from '../../../../../../../../packages/shared/src/validation/schemas/market';

type Market = {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  endDate: Date;
  resolved: boolean;
  status: 'active';
};

function market(id: string): Market {
  return {
    id,
    question: `Question ${id}?`,
    yesShares: 100,
    noShares: 100,
    liquidity: 200,
    endDate: new Date('2030-01-01T00:00:00Z'),
    resolved: false,
    status: 'active',
  };
}

const pages: Record<number, Market[]> = {
  0: [market('m1')],
  1: [market('m2')],
};

const positions = [
  {
    id: 'p1',
    userId: 'user-1',
    marketId: 'm1',
    side: 'yes',
    shares: 1.98,
    avgPrice: 0.5,
    cashCostBasis: 1,
  },
  {
    id: 'p2',
    userId: 'user-1',
    marketId: 'm2',
    side: 'no',
    shares: 3,
    avgPrice: 0.4,
    cashCostBasis: null,
  },
];

const cache = new Map<string, unknown>();

mock.module('@feed/api', () => ({
  addPublicReadHeaders: () => undefined,
  CACHE_KEYS: {
    MARKETS_API_PREDICTIONS_LIST: 'list',
    MARKETS_API_PREDICTIONS_POSITIONS: 'positions',
  },
  DEFAULT_TTLS: {
    MARKETS_API_PREDICTIONS_LIST: 30,
    MARKETS_API_PREDICTIONS_POSITIONS: 30,
  },
  getCacheOrFetch: async (
    key: string,
    fetchFn: () => Promise<unknown>,
    options: { namespace: string }
  ) => {
    const fullKey = `${options.namespace}:${key}`;
    if (!cache.has(fullKey)) {
      // Round-trip through JSON like the real Redis-backed cache.
      cache.set(fullKey, JSON.parse(JSON.stringify(await fetchFn())));
    }
    return cache.get(fullKey);
  },
  publicRateLimit: async () => ({
    error: null,
    user: { userId: 'user-1' },
    rateLimitInfo: null,
  }),
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/core/markets/prediction', () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {
    countUnresolvedMarkets = async () => 2;
    listMarkets = async ({ offset }: { limit: number; offset: number }) =>
      pages[offset] ?? [];
    listUserPositions = async () => positions;
  },
  PredictionPricing,
  calculatePredictionPositionSnapshot,
}));

mock.module('@feed/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.001,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0.01,
  },
  WalletService: {},
}));

mock.module('@feed/shared', () => ({
  logger: { info: mock(), warn: mock(), error: mock() },
  MarketQuerySchema,
  toISOOrNull: (value: Date | null | undefined) =>
    value ? new Date(value).toISOString() : null,
}));

const { GET } = await import('../route');

type ListBody = {
  questions: Array<{
    id: string;
    userPositions: Array<{
      id: string;
      costBasis: number;
      currentValue: number;
      unrealizedPnL: number;
    }>;
  }>;
};

async function fetchPage(page: number): Promise<ListBody> {
  const response = (await GET(
    new Request(
      `http://localhost/api/markets/predictions?page=${page}&limit=1&userId=user-1`
    ) as unknown as NextRequest
  )) as Response;
  return (await response.json()) as ListBody;
}

describe('GET /api/markets/predictions user positions cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('does not let a page-1 cache entry hide page-2 positions', async () => {
    const first = await fetchPage(1);
    const second = await fetchPage(2);

    expect(first.questions[0]?.id).toBe('m1');
    expect(first.questions[0]?.userPositions.map((p) => p.id)).toEqual(['p1']);
    expect(second.questions[0]?.id).toBe('m2');
    expect(second.questions[0]?.userPositions.map((p) => p.id)).toEqual(['p2']);
  });

  it('preserves persisted cashCostBasis across the positions cache and falls back on legacy rows', async () => {
    const first = await fetchPage(1);
    const firstCached = await fetchPage(1);
    const second = await fetchPage(2);

    const p1Miss = first.questions[0]?.userPositions[0];
    const p1Hit = firstCached.questions[0]?.userPositions[0];
    const p2Legacy = second.questions[0]?.userPositions[0];

    expect(p1Miss?.costBasis).toBe(1);
    expect(p1Miss?.unrealizedPnL).toBeCloseTo(
      (p1Miss?.currentValue ?? 0) - 1,
      10
    );
    expect(p1Hit?.costBasis).toBe(1);
    expect(p2Legacy?.costBasis).toBeCloseTo((3 * 0.4) / (1 - 0.001), 10);
  });
});
