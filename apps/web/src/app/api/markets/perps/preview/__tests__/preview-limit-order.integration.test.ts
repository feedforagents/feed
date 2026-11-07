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
 * The requests are anonymous (no authorization header), so the route uses
 * its public previewOpenPosition path against a seeded perp market
 * snapshot. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, perpMarketSnapshots } from '@feed/db';
import { NextRequest } from 'next/server';

const TICKER = 'F9TST';

let POST: typeof import('../route').POST;

async function postPreview(body: Record<string, unknown>) {
  const request = new NextRequest(
    new Request('http://localhost/api/markets/perps/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  ({ POST } = await import('../route'));

  await db.insert(perpMarketSnapshots).values({
    ticker: TICKER,
    organizationId: 'f9-test-org',
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
