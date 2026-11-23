/** Preview and placement order-size parity. PRD §§9.1/9.3, MVP Phase 6. */
import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  fresh: 'enforces fresh size bounds for anonymous and signed-in viewers',
  add: 'uses the added order minimum and the resulting same-side maximum',
  reduce: 'rejects a below-minimum reduce and permits a close above the cap',
  flip: 'checks the inverse leg when a large order flips a position',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks perp preview bounds in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'perp-preview-size-bounds',
      file: 'packages/testing/integration/perp-preview-size-bounds.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { db, eq, organizationState, perpMarketSnapshots, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { createPerpMarketService } = await import(
    '../../../apps/web/src/app/api/markets/perps/_adapters'
  );
  const { POST } = await import(
    '../../../apps/web/src/app/api/markets/perps/preview/route'
  );

  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `preview-size-${userId}`,
    virtualBalance: '1000000',
    totalDeposited: '1000000',
    lifetimePnL: '0',
    updatedAt: new Date(),
  });

  async function market(ticker: string, openInterest = 0) {
    await db.transaction(async (tx) => {
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
        markPrice: 100,
        indexPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest,
        volume24h: 0,
        fundingRate: {
          ticker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: new Date().toISOString(),
        },
        minOrderSize: 25,
        maxLeverage: 20,
      });
    });
  }

  const service = createPerpMarketService({ withPriceImpact: true });

  function order(
    ticker: string,
    size: number,
    side: 'long' | 'short' = 'long'
  ) {
    return { ticker, size, side, leverage: 2 };
  }

  function preview(input: ReturnType<typeof order>, authenticated = true) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (authenticated)
      headers.set('authorization', `Bearer steward:test:${userId}`);
    return POST(
      new NextRequest('http://localhost/api/markets/perps/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
    );
  }

  function place(input: ReturnType<typeof order>) {
    return service.openPosition({ userId, ...input });
  }

  async function expectRejected(
    input: ReturnType<typeof order>,
    message: string,
    authenticated = true
  ) {
    const response = await preview(input, authenticated);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
  }

  async function expectQuote(
    input: ReturnType<typeof order>,
    fields: Record<string, string | number>,
    authenticated = true
  ) {
    const response = await preview(input, authenticated);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preview: fields });
  }

  const minimum = 'Order size below minimum (25)';
  const maximum = 'Order size exceeds market limit (10,000)';

  test(cases.fresh, async () => {
    const ticker = 'PREVFRESH';
    await market(ticker);
    for (const authenticated of [false, true]) {
      await expectRejected(order(ticker, 24), minimum, authenticated);
      await expectRejected(order(ticker, 10_001), maximum, authenticated);
      await expectQuote(
        order(ticker, 25),
        { previewType: 'open', size: 25 },
        authenticated
      );
    }
    await expect(place(order(ticker, 24))).rejects.toThrow(minimum);
    await expect(place(order(ticker, 10_001))).rejects.toThrow(maximum);
  });

  test(cases.add, async () => {
    const ticker = 'PREVADD';
    await market(ticker);
    await place(order(ticker, 9_000));
    await expectRejected(order(ticker, 24), minimum);
    await expectRejected(
      order(ticker, 1_001),
      'Total position size would exceed market limit (10,000)'
    );
    await expectQuote(order(ticker, 1_000), {
      previewType: 'add',
      resultingSize: 10_000,
    });
    await expect(place(order(ticker, 24))).rejects.toThrow(minimum);
    await expect(place(order(ticker, 1_001))).rejects.toThrow(
      'Total position size would exceed market limit (10,000)'
    );
  });

  test(cases.reduce, async () => {
    const ticker = 'PREVREDUCE';
    await market(ticker, 200_000);
    await place(order(ticker, 15_000));
    await db
      .update(perpMarketSnapshots)
      .set({ openInterest: 15_000 })
      .where(eq(perpMarketSnapshots.ticker, ticker));

    await expectRejected(order(ticker, 24, 'short'), minimum);
    await expect(place(order(ticker, 24, 'short'))).rejects.toThrow(minimum);
    await expectQuote(order(ticker, 12_000, 'short'), {
      rebalanceType: 'reduce',
      resultingSize: 3_000,
    });
    const close = order(ticker, 15_000, 'short');
    await expectQuote(close, { rebalanceType: 'close', resultingSize: 0 });
    expect(await place(close)).toMatchObject({
      rebalanceType: 'close',
      fullyClosed: true,
    });
  });

  test(cases.flip, async () => {
    const ticker = 'PREVFLIP';
    await market(ticker);
    await place(order(ticker, 6_000));
    await expectRejected(order(ticker, 6_024, 'short'), minimum);
    await expectRejected(order(ticker, 16_001, 'short'), maximum);
    await expect(place(order(ticker, 16_001, 'short'))).rejects.toThrow(
      maximum
    );
    const flip = order(ticker, 12_000, 'short');
    await expectQuote(flip, { rebalanceType: 'flip', resultingSize: 6_000 });
    expect(await place(flip)).toMatchObject({
      rebalanceType: 'flip',
      size: 6_000,
    });
  });
}
