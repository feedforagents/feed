import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as actualDb from '@feed/db';
import { NextResponse } from 'next/server';

type Market = {
  id: string;
  resolved: boolean;
  endDate: Date;
  question: string;
};

let market: Market | null;
let casRows: { id: string }[] = [];
const ipSeen: (string | undefined)[] = [];

mock.module('@feed/db', () => ({
  ...actualDb,
  db: {
    select: () => {
      const c = {
        from: () => c,
        where: () => c,
        limit: async () => (market ? [market] : []),
      };
      return c;
    },
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => casRows }),
      }),
    }),
  },
}));

mock.module('@feed/core/markets/prediction', () => ({
  PredictionDbAdapter: class {},
  PredictionMarketService: class {},
}));

mock.module('@feed/engine', () => ({
  FEE_CONFIG: {},
  invalidateAfterPredictionTrade: async () => undefined,
  WalletService: {},
}));

mock.module('@/lib/services/market-resolution-notifications', () => ({
  notifyResolvedMarketOwners: async () => 0,
}));

mock.module('@feed/api', () => ({
  broadcastToChannel: async () => undefined,
  checkProgress: async () => undefined,
  checkRateLimitAndDuplicates: () => null,
  errorResponse: (message: string, code: string, status: number) =>
    NextResponse.json({ error: { message, code } }, { status }),
  getClientIp: () => '203.0.113.7',
  invalidateMarketsApiPredictionsList: async () => undefined,
  invalidateMarketsApiPredictionsListAndAllPositions: async () => undefined,
  logAdminModify: async (ctx: { ipAddress?: string }) => {
    ipSeen.push(ctx.ipAddress);
  },
  RATE_LIMIT_CONFIGS: { ADMIN_ACTION: {} },
  requireAdmin: async () => ({ userId: 'admin-1' }),
  successResponse: (data: object) => NextResponse.json(data),
  withErrorHandling: (handler: () => Promise<Response>) => handler,
}));

const { POST } = await import('../route');

function post(body: object) {
  return POST(
    new Request('http://localhost/api/admin/markets/m1', {
      method: 'POST',
      headers: { 'x-forwarded-for': 'spoofed' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ marketId: 'm1' }) }
  ) as Promise<Response>;
}

const day = 24 * 60 * 60 * 1000;
const future = (days: number) =>
  new Date(Date.now() + days * day).toISOString();

describe('POST /api/admin/markets/[marketId] extend', () => {
  beforeEach(() => {
    market = {
      id: 'm1',
      resolved: false,
      endDate: new Date(Date.now() + 2 * day),
      question: 'Q?',
    };
    casRows = [];
    ipSeen.length = 0;
  });

  it('rejects invalid dates (NaN comparison used to pass)', async () => {
    const res = await post({ action: 'extend', newEndDate: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  it('rejects extending resolved markets', async () => {
    market = { ...(market as Market), resolved: true };
    const res = await post({ action: 'extend', newEndDate: future(5) });
    expect(res.status).toBe(400);
  });

  it('rejects shortening via extend', async () => {
    const res = await post({ action: 'extend', newEndDate: future(1) });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the compare-and-set loses', async () => {
    const res = await post({ action: 'extend', newEndDate: future(5) });
    expect(res.status).toBe(409);
  });

  it('extends and audits with the trusted client IP', async () => {
    casRows = [{ id: 'm1' }];
    const res = await post({ action: 'extend', newEndDate: future(5) });
    expect(res.status).toBe(200);
    expect(ipSeen).toEqual(['203.0.113.7']);
  });

  it('requires a boolean resolution to resolve', async () => {
    const res = await post({ action: 'resolve' });
    expect(res.status).toBe(400);
  });
});
