/** Funding-netted mark P&L in the retained perps trades feed. PRD §9.3, MVP Phase 6. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const fundedRows =
  'nets a charge and rebate on open rows and preserves closed rows';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks perp trades P&L on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'perp-asset-trades-funding',
      file: 'packages/testing/integration/perp-asset-trades-funding.integration.test.ts',
      cases: [fundedRows],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));

  const { db, perpPositions, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/markets/perps/trades/[ticker]/route'
  );

  test(fundedRows, async () => {
    const openedAt = new Date('2026-01-01T00:00:00Z');
    const closedAt = new Date('2026-01-01T08:00:00Z');
    const userId = await generateSnowflakeId();
    const ids = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    const [charge, rebate, closed] = ids;
    await db.insert(users).values({
      id: userId,
      username: `perp-feed-funding-${userId}`,
      updatedAt: openedAt,
    });
    const position = {
      userId,
      ticker: 'AMZN',
      organizationId: 'aimazon',
      entryPrice: 100,
      currentPrice: 105,
      size: 8000,
      leverage: 2,
      liquidationPrice: 60,
      unrealizedPnLPercent: 0,
      openedAt,
      lastUpdated: openedAt,
    };
    await db.insert(perpPositions).values([
      {
        ...position,
        id: charge,
        side: 'long',
        unrealizedPnL: 1579.04,
        fundingPaid: 18.12,
      },
      {
        ...position,
        id: rebate,
        side: 'short',
        unrealizedPnL: 383.34,
        fundingPaid: -10.16,
      },
      {
        ...position,
        id: closed,
        side: 'long',
        unrealizedPnL: 0,
        fundingPaid: 18.12,
        closedAt,
      },
    ]);

    const response = await GET(
      new NextRequest(
        'http://127.0.0.1/api/markets/perps/trades/AMZN?limit=10'
      ),
      { params: Promise.resolve({ ticker: 'AMZN' }) }
    );
    expect(response.status).toBe(200);
    const { trades } = (await response.json()) as {
      trades: Array<{
        id: string;
        unrealizedPnL: number;
        closedAt: string | null;
      }>;
    };
    expect(trades).toHaveLength(3);
    const byId = new Map(trades.map((row) => [row.id, row]));
    expect(byId.get(charge)?.unrealizedPnL).toBeCloseTo(1560.92, 2);
    expect(byId.get(rebate)?.unrealizedPnL).toBeCloseTo(393.5, 2);
    expect(byId.get(closed)).toMatchObject({
      closedAt: closedAt.toISOString(),
      unrealizedPnL: 0,
    });
  });
}
