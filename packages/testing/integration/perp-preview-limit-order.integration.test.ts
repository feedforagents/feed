/**
 * POST /api/markets/perps/preview against a real database: a preview must
 * not silently quote a market execution for a limit order.
 *
 * The open and close routes both reject non-market orders with
 * UNSUPPORTED_ORDER_TYPE — "Limit opens are not supported by the service,
 * so they are rejected rather than silently executed at market" (open
 * route; the close route states the same rule). The preview route parses
 * the same PerpOpenPositionSchema, which accepts orderType 'limit' with a
 * limitPrice, but it dropped orderType entirely and quoted a market
 * execution anyway: the caller received execution prices, margin and a
 * liquidation price for an order the open route then refuses with a 400.
 *
 * Requests cover the public path and authenticated previewOrder path using
 * the existing CI synthetic bearer against an owned perp market snapshot. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, perpMarketSnapshots, perpPositions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let TICKER: string;
let userId: string;
let clientIp: string;

let POST: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/markets/perps/preview/route';

async function postPreview(body: Record<string, unknown>) {
  const request = new NextRequest(
    new Request('http://localhost/api/markets/perps/preview', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': clientIp,
      },
      body: JSON.stringify(body),
    })
  );
  const response = await POST(request);
  const parsed = (await response.json().catch(() => null)) as {
    preview?: { executionPrice?: number; totalRequired?: number };
    error?: unknown;
  } | null;
  return { status: response.status, body: parsed };
}

beforeAll(async () => {
  ({ POST } = await import(routePath));

  userId = await generateSnowflakeId();
  // Keep real rate limits enabled without sharing CI's anonymous bucket
  // with unrelated route tests. Use one documentation-range IP per fixture.
  clientIp = `2001:db8:1660:0:${BigInt(userId)
    .toString(16)
    .padStart(16, '0')
    .match(/.{4}/g)!
    .join(':')}`;
  TICKER = `L${BigInt(userId).toString(16).toUpperCase()}`;
  await db.insert(users).values({
    id: userId,
    username: `lp-${userId}`,
    virtualBalance: '1000',
    updatedAt: new Date(),
  });
  await db.insert(perpMarketSnapshots).values({
    ticker: TICKER,
    organizationId: `limit-preview-${userId}`,
    name: 'F9 Test Market',
    currentPrice: 100,
    high24h: 110,
    low24h: 90,
    fundingRate: {
      ticker: TICKER,
      rate: 0.0001,
      nextFundingTime: new Date(Date.now() + 3_600_000).toISOString(),
      predictedRate: 0.0001,
    },
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, TICKER));
});

describe('POST /api/markets/perps/preview order types', () => {
  it('rejects a limit order instead of quoting a market execution', async () => {
    const { status, body } = await postPreview({
      ticker: TICKER,
      side: 'long',
      size: 100,
      leverage: 5,
      orderType: 'limit',
      limitPrice: 90,
    });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain(
      'Only market open orders are supported'
    );
    expect(body?.preview).toBeUndefined();
  });

  it('still quotes a market order', async () => {
    const { status, body } = await postPreview({
      ticker: TICKER,
      side: 'long',
      size: 100,
      leverage: 5,
      orderType: 'market',
    });
    expect(status).toBe(200);
    expect(body?.preview?.executionPrice).toBeGreaterThan(0);
    expect(body?.preview?.totalRequired).toBeGreaterThan(0);
  });

  it('still quotes when orderType is omitted (schema default)', async () => {
    const { status, body } = await postPreview({
      ticker: TICKER,
      side: 'long',
      size: 100,
      leverage: 5,
    });
    expect(status).toBe(200);
    expect(body?.preview?.executionPrice).toBeGreaterThan(0);
  });
});

it('rejects short limits and malformed order payloads without quoting', async () => {
  for (const order of [
    { side: 'short', orderType: 'limit', limitPrice: 110 },
    { orderType: 'limit' },
    { orderType: 'limit', limitPrice: 0 },
    { orderType: 'stop' },
    { orderType: null },
  ]) {
    const { status, body } = await postPreview({
      ticker: TICKER,
      side: 'long',
      size: 100,
      leverage: 5,
      ...order,
    });
    expect(status).toBe(400);
    expect(body?.preview).toBeUndefined();
  }
});

it('preserves authenticated market preview and rejects limits without a trade', async () => {
  for (const orderType of ['market', 'limit']) {
    const response = await POST(
      new NextRequest('http://localhost/api/markets/perps/preview', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          authorization: `Bearer steward:test:${userId}`,
        },
        body: JSON.stringify({
          ticker: TICKER,
          side: 'long',
          size: 100,
          leverage: 5,
          orderType,
          limitPrice: 90,
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(orderType === 'market' ? 200 : 400);
    if (orderType === 'market') {
      expect(body.preview.previewType).toBe('open');
      expect(body.preview.executionPrice).toBeGreaterThan(0);
    } else {
      expect(body.error).toBe('Only market open orders are supported');
      expect(body.preview).toBeUndefined();
    }
  }
  expect(
    Number(
      (
        await db
          .select({ balance: users.virtualBalance })
          .from(users)
          .where(eq(users.id, userId))
      )[0]?.balance
    )
  ).toBe(1000);
  expect(
    await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId))
  ).toHaveLength(0);
});
