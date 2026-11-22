/** PRD §13 and MVP Phase 6: the validation bridge reports current holdings. */
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { startBridge } from './helpers/simulation-bridge';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const holdingsCase = 'returns the remaining open holdings through the bridge';
const collisionCase =
  'rolls back a failed seed without deleting an existing holding';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the simulation holdings cases in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'bridge-scenario-positions',
      file: 'packages/testing/integration/simulation-bridge-scenario-positions.integration.test.ts',
      cases: [holdingsCase, collisionCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Verified bridge lease URL required');
  const { db, eq, markets, perpPositions, positions } = await import(
    '@feed/db'
  );
  const now = new Date();
  const npcId = 'npc-000';
  const positionShape = z.object({
    id: z.string(),
    marketType: z.enum(['prediction', 'perp']),
    side: z.string(),
    size: z.number(),
    unrealizedPnL: z.number(),
  });
  const scenarioShape = z.object({ positions: z.array(positionShape) });

  const perpRow = {
    userId: npcId,
    ticker: 'NVDA',
    organizationId: 'nvidia',
    leverage: 5,
    openedAt: now,
    lastUpdated: now,
    entryPrice: 100,
    currentPrice: 95,
    liquidationPrice: 120,
    unrealizedPnL: 2.5,
    unrealizedPnLPercent: 5,
  };

  async function seedHoldings(prefix: string, openPerpId = `${prefix}-open`) {
    const marketId = `${prefix}-market`;
    const closedPerpId = `${prefix}-closed`;
    await db.transaction(async (tx) => {
      await tx.insert(markets).values({
        id: marketId,
        question: 'Will the simulation holdings market resolve yes?',
        yesShares: '3000',
        noShares: '7000',
        liquidity: '10000',
        endDate: new Date(now.getTime() + 86_400_000),
        updatedAt: now,
      });
      await tx.insert(positions).values(
        [
          { status: 'active', shares: '5', pnl: '0', side: true },
          {
            status: 'resolved',
            shares: '10',
            pnl: '5',
            side: true,
            outcome: true,
          },
          { status: 'closed', shares: '0', pnl: '1', side: false },
          { status: 'cancelled', shares: '9', pnl: '0', side: true },
        ].map((values) => ({
          ...values,
          id: `${prefix}-prediction-${values.status}`,
          userId: npcId,
          marketId,
          questionId: 1,
          avgPrice: '0.5',
          updatedAt: now,
        }))
      );
      await tx.insert(perpPositions).values([
        {
          ...perpRow,
          id: closedPerpId,
          side: 'long',
          size: 100,
          closedAt: now,
        },
        { ...perpRow, id: openPerpId, side: 'short', size: 100 },
      ]);
    });
    return openPerpId;
  }

  test(holdingsCase, async () => {
    const prefix = 'bridge-current-positions';
    const openPerpId = await seedHoldings(prefix);
    // A partial close changes the remaining size without setting closedAt.
    await db
      .update(perpPositions)
      .set({ size: 50 })
      .where(eq(perpPositions.id, openPerpId));
    const bridge = await startBridge(databaseUrl);
    try {
      const init = await bridge.request('/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numNPCs: 1, seed: 42 }),
      });
      expect(init.status).toBe(200);
      await init.arrayBuffer();
      const requestId = 'bridge-active-holdings';
      const response = await bridge.request(`/scenario/${npcId}`, {
        headers: { 'x-request-id': requestId },
      });
      expect(response.status).toBe(200);
      const scenario = scenarioShape.parse(await response.json());
      expect(scenario.positions).toEqual([
        {
          id: `${prefix}-prediction-active`,
          marketType: 'prediction',
          side: 'yes',
          size: 5,
          unrealizedPnL: 0,
        },
        {
          id: openPerpId,
          marketType: 'perp',
          side: 'short',
          size: 50,
          unrealizedPnL: 2.5,
        },
      ]);
      console.info('Simulation bridge current holdings', {
        requestId,
        status: response.status,
        positions: scenario.positions,
      });
    } finally {
      await bridge.stop();
    }
  }, 30_000);

  test(collisionCase, async () => {
    const prefix = 'bridge-positions-collision';
    const [sentinel] = await db
      .insert(perpPositions)
      .values({
        ...perpRow,
        id: 'bridge-positions-sentinel',
        userId: 'independent-holder',
        side: 'long',
        size: 20,
      })
      .returning();
    if (!sentinel) throw new Error('Sentinel holding insert returned no row');
    await expect(seedHoldings(prefix, sentinel.id)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    expect(
      await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, sentinel.id))
    ).toEqual([sentinel]);
    expect(
      await db
        .select()
        .from(markets)
        .where(eq(markets.id, `${prefix}-market`))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(positions)
        .where(eq(positions.marketId, `${prefix}-market`))
    ).toEqual([]);
  });
}
