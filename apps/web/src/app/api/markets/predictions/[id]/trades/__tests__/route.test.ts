import { describe, expect, it, mock } from 'bun:test';
import type { NextRequest } from 'next/server';

const mockGetCache = mock();
const mockAddHeaders = mock();
const cachedPayload = { trades: [], total: 0, hasMore: false };

mock.module('@feed/api', () => ({
  addPublicReadHeaders: mockAddHeaders,
  getCache: mockGetCache,
  publicRateLimit: async () => ({
    error: null,
    rateLimitInfo: { limit: 60, remaining: 59 },
  }),
  setCache: async () => undefined,
  successResponse: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status }),
  withErrorHandling: (handler: (...args: unknown[]) => unknown) => handler,
}));

mock.module('@feed/db', () => ({
  and: () => undefined,
  balanceTransactions: {},
  count: () => undefined,
  db: {},
  eq: () => undefined,
  inArray: () => undefined,
  markets: {},
  npcTrades: {},
  sql: () => undefined,
  users: {},
}));

mock.module('@feed/shared', () => ({
  logger: { info: mock(), debug: mock(), warn: mock(), error: mock() },
}));

const { GET } = await import('../route');

describe('GET /api/markets/predictions/[id]/trades cache', () => {
  it('reads from the same namespace it writes and keeps rate-limit headers on hits', async () => {
    mockGetCache.mockResolvedValue(cachedPayload);

    const response = (await GET(
      new Request(
        'http://localhost/api/markets/predictions/m1/trades'
      ) as unknown as NextRequest,
      { params: Promise.resolve({ id: 'm1' }) }
    )) as Response;

    expect(response.status).toBe(200);
    expect(mockGetCache).toHaveBeenCalledWith('prediction-trades:v2:m1:20:0', {
      namespace: 'market-trades',
    });
    expect(mockAddHeaders).toHaveBeenCalledTimes(1);
  });

  it('rejects fractional offsets', async () => {
    await expect(
      GET(
        new Request(
          'http://localhost/api/markets/predictions/m1/trades?offset=1.5'
        ) as unknown as NextRequest,
        { params: Promise.resolve({ id: 'm1' }) }
      )
    ).rejects.toThrow();
  });
});
