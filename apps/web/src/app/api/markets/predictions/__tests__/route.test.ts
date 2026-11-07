import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';
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
    shares: 5,
    avgPrice: 0.5,
  },
  {
    id: 'p2',
    userId: 'user-1',
    marketId: 'm2',
    side: 'no',
    shares: 3,
    avgPrice: 0.4,
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
  PredictionPricing: {
    getCurrentPrice: () => 0.5,
    // Mirrors floorPoints(shares) in the real implementation.
    calculateExpectedPayout: (shares: number) => Math.floor(shares * 100) / 100,
  },
  calculatePredictionPositionSnapshot: () => ({
    currentUnitPrice: 0.5,
    currentProbability: 0.5,
    currentValue: 1,
    costBasis: 1,
    unrealizedPnL: 0,
  }),
}));

mock.module('@feed/engine', () => ({
  FEE_CONFIG: {
    TRADING_FEE_RATE: 0.01,
    PLATFORM_SHARE: 0.5,
    REFERRER_SHARE: 0.5,
    MIN_FEE_AMOUNT: 0,
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
  questions: Array<{ id: string; userPositions: Array<{ id: string }> }>;
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
});
