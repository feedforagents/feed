/**
 * PRD §9.3 / MVP Phase 6: the authenticated perp preview must enforce the
 * same account-level rejections as the open flow.
 *
 * previewOrder quotes an executable-looking order while openPosition /
 * addToPosition / the flip leg refuse it for the per-user exposure cap
 * (MAX_PERP_USER_EXPOSURE) or the max-positions limit. The preview route
 * claims to reuse the same execution engine as order placement; the
 * exposure/positions checks are part of that flow.
 */
import { describe, expect, test } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';
import { POST } from '../../../apps/web/src/app/api/markets/perps/preview/route';

const ip = crypto.getRandomValues(new Uint8Array(2));
const clientIp = `198.19.${ip[0]}.${ip[1]}`;

function ticker(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

async function createUser(balance: string): Promise<string> {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `perp-exp-${userId}`,
    virtualBalance: balance,
    totalDeposited: balance,
    lifetimePnL: '0',
    updatedAt: new Date(),
  });
  return userId;
}

async function createMarket(t: string): Promise<void> {
  await db.insert(organizationState).values({
    id: t,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: new Date(),
  });
  await db.insert(perpMarketSnapshots).values({
    ticker: t,
    organizationId: t,
    currentPrice: 100,
    markPrice: 100,
    indexPrice: 100,
    high24h: 100,
    low24h: 100,
    openInterest: 1000000,
    volume24h: 0,
    bidDepth: 1000000,
    askDepth: 1000000,
    maxLeverage: 20,
    minOrderSize: 10,
    fundingRate: {
      ticker: t,
      rate: 0,
      predictedRate: 0,
      nextFundingTime: new Date().toISOString(),
    },
  });
}

async function preview(
  userId: string,
  t: string,
  side: 'long' | 'short',
  size: number,
  leverage: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new NextRequest(
    'http://localhost/api/markets/perps/preview',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': clientIp,
        authorization: `Bearer steward:test:${userId}`,
      },
      body: JSON.stringify({ ticker: t, side, size, leverage }),
    }
  );
  const response = await POST(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

function errorMessage(body: Record<string, unknown>): string {
  const error = body.error as Record<string, unknown> | undefined;
  if (error && typeof error.message === 'string') return error.message;
  return JSON.stringify(body);
}

async function cleanup(userId: string, tickers: string[]): Promise<void> {
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  for (const t of tickers) {
    await db.delete(stockPrices).where(eq(stockPrices.organizationId, t));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, t));
    await db.delete(organizationState).where(eq(organizationState.id, t));
  }
  await db.delete(users).where(eq(users.id, userId));
}

describe('perp preview enforces the exposure cap', () => {
  test('fresh open over the exposure cap is rejected by the preview', async () => {
    const userId = await createUser('10000');
    const t1 = ticker('PEXPA');
    const t2 = ticker('PEXPB');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t1);
      await createMarket(t2);
      const service = createPerpMarketService({ withPriceImpact: true });
      // Existing exposure: 40,000 size x 20 leverage = 800,000.
      await service.openPosition({
        userId,
        ticker: t1,
        side: 'long',
        size: 40000,
        leverage: 20,
      });
      // New leg adds 20,000 x 20 = 400,000 -> 1,200,000 total, over the cap.
      const quoted = await preview(userId, t2, 'long', 20000, 20);
      expect(quoted.status).toBe(400);
      expect(errorMessage(quoted.body)).toMatch(
        /Total exposure would exceed limit/
      );
      await expect(
        service.openPosition({
          userId,
          ticker: t2,
          side: 'long',
          size: 20000,
          leverage: 20,
        })
      ).rejects.toThrow(/Total exposure would exceed limit/);
    } finally {
      await cleanup(userId, [t1, t2]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });

  test('add over the exposure cap is rejected by the preview', async () => {
    const userId = await createUser('10000');
    const t1 = ticker('PEXPC');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t1);
      const service = createPerpMarketService({ withPriceImpact: true });
      await service.openPosition({
        userId,
        ticker: t1,
        side: 'long',
        size: 40000,
        leverage: 20,
      });
      const quoted = await preview(userId, t1, 'long', 20000, 20);
      expect(quoted.status).toBe(400);
      expect(errorMessage(quoted.body)).toMatch(
        /Total exposure would exceed limit/
      );
      await expect(
        service.openPosition({
          userId,
          ticker: t1,
          side: 'long',
          size: 20000,
          leverage: 20,
        })
      ).rejects.toThrow(/Total exposure would exceed limit/);
    } finally {
      await cleanup(userId, [t1]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });

  test('add to a legacy position above the leverage cap is rejected by the preview', async () => {
    const userId = await createUser('10000');
    const t1 = ticker('PEXPH');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t1);
      const now = new Date();
      // Legacy position opened before the market cap was lowered: 50x
      // against a 20x cap. Inserted directly because openPosition refuses
      // a 50x input at the current cap.
      await db.insert(perpPositions).values({
        id: `test-pos-legacy-${userId}`,
        userId,
        ticker: t1,
        organizationId: t1,
        side: 'long',
        entryPrice: 100,
        currentPrice: 100,
        size: 100,
        leverage: 50,
        liquidationPrice: 50,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        fundingPaid: 0,
        openedAt: now,
        lastUpdated: now,
        closedAt: null,
        realizedPnL: 0,
      });
      // The add is small: 100 x 50 = 5,000 exposure, far under the cap,
      // and 100 + 100 is far under the market size limit, so the leverage
      // cap is the only reason this order is refused.
      const quoted = await preview(userId, t1, 'long', 100, 20);
      expect(quoted.status).toBe(400);
      expect(errorMessage(quoted.body)).toMatch(
        /Cannot add to a position above the leverage cap/
      );
      const service = createPerpMarketService({ withPriceImpact: true });
      await expect(
        service.openPosition({
          userId,
          ticker: t1,
          side: 'long',
          size: 100,
          leverage: 20,
        })
      ).rejects.toThrow(/Cannot add to a position above the leverage cap/);
    } finally {
      await cleanup(userId, [t1]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });

  test('flip over the exposure cap is rejected by the preview', async () => {
    const userId = await createUser('10000');
    const t1 = ticker('PEXPD');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t1);
      const service = createPerpMarketService({ withPriceImpact: true });
      await service.openPosition({
        userId,
        ticker: t1,
        side: 'long',
        size: 40000,
        leverage: 20,
      });
      // Inverse leg: (100,000 - 40,000) x 20 = 1,200,000 new exposure.
      // Gross size 100,000 equals the market limit, so size is not the
      // reason this order is refused.
      const quoted = await preview(userId, t1, 'short', 100000, 20);
      expect(quoted.status).toBe(400);
      expect(errorMessage(quoted.body)).toMatch(
        /Total exposure would exceed limit/
      );
      await expect(
        service.openPosition({
          userId,
          ticker: t1,
          side: 'short',
          size: 100000,
          leverage: 20,
        })
      ).rejects.toThrow(/Total exposure would exceed limit/);
    } finally {
      await cleanup(userId, [t1]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });

  test('fresh open at the 50-position limit is rejected by the preview', async () => {
    const userId = await createUser('10000');
    const t51 = ticker('PEXPE');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t51);
      const now = new Date();
      for (let i = 0; i < 50; i++) {
        const t = ticker(`PEXPF${i}`);
        await db.insert(perpPositions).values({
          id: `test-pos-${i}-${userId}`,
          userId,
          ticker: t,
          organizationId: t,
          side: 'long',
          entryPrice: 100,
          currentPrice: 100,
          size: 100,
          leverage: 2,
          liquidationPrice: 50,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          fundingPaid: 0,
          openedAt: now,
          lastUpdated: now,
          closedAt: null,
          realizedPnL: 0,
        });
      }
      const quoted = await preview(userId, t51, 'long', 100, 2);
      expect(quoted.status).toBe(400);
      expect(errorMessage(quoted.body)).toMatch(/Maximum positions reached/);
      const service = createPerpMarketService({ withPriceImpact: true });
      await expect(
        service.openPosition({
          userId,
          ticker: t51,
          side: 'long',
          size: 100,
          leverage: 2,
        })
      ).rejects.toThrow(/Maximum positions reached/);
    } finally {
      await cleanup(userId, [t51]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });

  test('reduce that lowers exposure is still quoted', async () => {
    const userId = await createUser('10000');
    const t1 = ticker('PEXPG');
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await createMarket(t1);
      const service = createPerpMarketService({ withPriceImpact: true });
      await service.openPosition({
        userId,
        ticker: t1,
        side: 'long',
        size: 40000,
        leverage: 20,
      });
      const quoted = await preview(userId, t1, 'short', 10000, 20);
      expect(quoted.status).toBe(200);
      const reduced = await service.openPosition({
        userId,
        ticker: t1,
        side: 'short',
        size: 10000,
        leverage: 20,
      });
      expect(reduced.remainingSize).toBe(30000);
    } finally {
      await cleanup(userId, [t1]);
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });
});
