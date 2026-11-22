/** PRD §9.2 and MVP Phase 0: the simulator reads the same CPMM price as Feed. */
import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { startBridge } from './helpers/simulation-bridge';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the simulation bridge price case in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'bridge-prediction-prices',
      file: 'packages/testing/integration/simulation-bridge-prediction-prices.integration.test.ts',
      cases: ['reads the persisted CPMM pool price on each scenario request'],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Verified bridge lease URL required');
  const { db, eq, markets, questions } = await import('@feed/db');
  const responseShape = z.object({
    marketState: z.object({
      marketSource: z.literal('database'),
      predictionMarkets: z.array(
        z.object({ id: z.string(), yesPrice: z.number(), noPrice: z.number() })
      ),
    }),
  });
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;

  afterAll(async () => {
    try {
      await bridge?.stop();
    } finally {
      await db.$disconnect();
    }
  });

  const now = new Date();
  const endDate = new Date(now.getTime() + 86_400_000);

  async function createMarket(id: string, yesShares: string, noShares: string) {
    const [row] = await db
      .insert(markets)
      .values({
        id,
        question: `Will the bridge test market ${id} resolve yes?`,
        liquidity: '10000',
        yesShares,
        noShares,
        endDate,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('Market insert returned no row');
    return row;
  }

  test('reads the persisted CPMM pool price on each scenario request', async () => {
    const first = await createMarket('bridge-prices-a', '3000', '7000');
    const second = await createMarket('bridge-prices-b', '9000', '1000');
    await expect(createMarket(first.id, '5000', '5000')).rejects.toThrow();
    expect(
      await db.select().from(markets).where(eq(markets.id, first.id))
    ).toEqual([first]);

    const seeded = await db
      .insert(questions)
      .values(
        [first.id, second.id, null].map((marketId, index) => ({
          id: `bridge-price-question-${index}`,
          questionNumber: index + 1,
          marketId,
          text: `Will the bridge price test question ${index} resolve yes?`,
          scenarioId: 1,
          outcome: false,
          rank: 1,
          resolutionDate: endDate,
          status: 'active',
          updatedAt: now,
        }))
      )
      .returning();
    expect(seeded).toHaveLength(3);

    const ownedBridge = await startBridge(databaseUrl);
    bridge = ownedBridge;
    const init = await ownedBridge.request('/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numNPCs: 1, seed: 42 }),
    });
    expect(init.status).toBe(200);
    await init.arrayBuffer();

    async function readPrices(requestId: string) {
      const response = await ownedBridge.request('/scenario/npc-000', {
        headers: { 'x-request-id': requestId },
      });
      expect(response.status).toBe(200);
      const body = responseShape.parse(await response.json());
      const prices = new Map(
        body.marketState.predictionMarkets.map((market) => [
          market.id,
          [market.yesPrice, market.noPrice],
        ])
      );
      console.info('Simulation bridge prices', {
        requestId,
        status: response.status,
        prices: Object.fromEntries(prices),
      });
      return prices;
    }

    const initial = await readPrices('bridge-cpmm-initial');
    expect(initial.get('bridge-price-question-0')).toEqual([70, 30]);
    expect(initial.get('bridge-price-question-1')).toEqual([10, 90]);
    expect(initial.get('bridge-price-question-2')).toEqual([50, 50]);

    await db
      .update(markets)
      .set({ yesShares: '6000', noShares: '4000' })
      .where(eq(markets.id, first.id));

    const updated = await readPrices('bridge-cpmm-updated');
    expect(updated.get('bridge-price-question-0')).toEqual([40, 60]);
    expect(updated.get('bridge-price-question-1')).toEqual([10, 90]);
    expect(updated.get('bridge-price-question-2')).toEqual([50, 50]);
  }, 30_000);
}
