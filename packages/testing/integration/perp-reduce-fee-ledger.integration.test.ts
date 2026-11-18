/**
 * PRD §9.1 (Trading fee) / MVP Phase 6: an opposite-side order that reduces a
 * perp position pays the canonical fee on the ordered size. Execution, the
 * preview and the fee ledger (TradingFee row and users.totalFeesPaid) agree.
 * Only the server-only marker is stubbed; the routes and database run for real.
 */
import { expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  dbWrite,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  tradingFees,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';

const ip = crypto.getRandomValues(new Uint8Array(2));
const clientIp = `198.19.${ip[0]}.${ip[1]}`;

async function setupMarket(userId: string, ticker: string) {
  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username: userId,
      virtualBalance: '10000',
      totalDeposited: '10000',
      lifetimePnL: '0',
      updatedAt: new Date(),
    });
    await tx.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await tx.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: ticker,
      currentPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 0,
      volume24h: 0,
      fundingRate: {
        ticker,
        rate: 0,
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0,
      },
    });
  });
}

async function cleanup(userId: string, ticker: string) {
  await dbWrite.delete(tradingFees).where(eq(tradingFees.userId, userId));
  await dbWrite
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await dbWrite
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await dbWrite.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await dbWrite
    .delete(stockPrices)
    .where(eq(stockPrices.organizationId, ticker));
  await dbWrite
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await dbWrite
    .delete(organizationState)
    .where(eq(organizationState.id, ticker));
  await dbWrite.delete(users).where(eq(users.id, userId));
}

async function post(
  route: (request: NextRequest) => Promise<Response>,
  path: string,
  userId: string,
  body: Record<string, unknown>
) {
  const previous = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
  try {
    const response = await route(
      new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          authorization: `Bearer steward:test:${userId}`,
        },
        body: JSON.stringify(body),
      })
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBeLessThan(300);
    return json;
  } finally {
    if (previous === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previous;
  }
}

test('reduce through the open route charges and records the canonical fee on the ordered size', async () => {
  const userId = `reduce-fee-${crypto.randomUUID()}`;
  const ticker = `REDUCEFEE${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await setupMarket(userId, ticker);
  const { POST: openRoute } = await import(
    '../../../apps/web/src/app/api/markets/perps/open/route'
  );
  const { POST: previewRoute } = await import(
    '../../../apps/web/src/app/api/markets/perps/preview/route'
  );
  try {
    const opened = await post(openRoute, '/api/markets/perps/open', userId, {
      ticker,
      side: 'long',
      size: 116,
      leverage: 1,
      orderType: 'market',
    });

    const order = { ticker, side: 'short', size: 30.01, leverage: 1 };
    const { preview } = await post(
      previewRoute,
      '/api/markets/perps/preview',
      userId,
      order
    );
    expect(preview.rebalanceType).toBe('reduce');

    // 116 * (30.01 / 116) is 30.009999999999998: settling that size floors
    // to 30.00 and charges 0.03, not the canonical fee on 30.01.
    const reduced = await post(openRoute, '/api/markets/perps/open', userId, {
      ...order,
      orderType: 'market',
    });
    expect(reduced.position.rebalanceType).toBe('reduce');
    expect(reduced.fee.amount).toBe(0.04);
    expect(reduced.fee.amount).toBe(preview.estimatedFee);

    const [closeFee] = await dbWrite
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.tradeType, 'perp_close'))
      .then((rows) => rows.filter((row) => row.userId === userId));
    expect(Number(closeFee?.feeAmount)).toBe(reduced.fee.amount);

    const [user] = await dbWrite
      .select({ totalFeesPaid: users.totalFeesPaid })
      .from(users)
      .where(eq(users.id, userId));
    expect(Number(user?.totalFeesPaid)).toBeCloseTo(
      opened.fee.amount + reduced.fee.amount,
      9
    );

    const [position] = await dbWrite
      .select({ size: perpPositions.size })
      .from(perpPositions)
      .where(eq(perpPositions.id, opened.position.positionId));
    expect(Number(position?.size)).toBeCloseTo(85.99, 9);
  } finally {
    await cleanup(userId, ticker);
  }
});
