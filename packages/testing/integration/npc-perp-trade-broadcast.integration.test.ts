/** NPC perp trades publish market events. PRD §§8.1 and 12, MVP Phase 3. */
import { expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  perpTrade:
    'open_long and close_position publish perp_trade on the markets channel',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks NPC perp trade broadcasts against disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'npc-perp-trade-broadcast',
      file: 'packages/testing/integration/npc-perp-trade-broadcast.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    actorState,
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    pools,
    users,
  } = await import('@feed/db');
  const { setBroadcastToChannel, TradeExecutionService } = await import(
    '@feed/engine'
  );
  const { generateSnowflakeId } = await import('@feed/shared');

  type Published = { channel: string; payload: Record<string, unknown> };
  const published: Published[] = [];
  setBroadcastToChannel(async (channel, data) => {
    published.push({ channel, payload: data });
  });

  async function createActor(): Promise<string> {
    const id = await generateSnowflakeId();
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        username: `npc-bc-${id.slice(-10)}`,
        isActor: true,
        updatedAt: now,
      });
      await tx.insert(actorState).values({
        id,
        tradingBalance: '10000',
        hasPool: true,
        updatedAt: now,
      });
      await tx.insert(pools).values({
        id,
        npcActorId: id,
        name: 'NPC broadcast test pool',
        updatedAt: now,
      });
    });
    return id;
  }

  async function seedPerpMarket(): Promise<string> {
    const ticker = 'NVDAI';
    const now = new Date();
    await db.insert(organizationState).values({
      id: 'nvidai',
      currentPrice: 100,
      basePrice: 100,
      updatedAt: now,
    });
    await db.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: 'nvidai',
      name: 'NPC Broadcast Test Org',
      currentPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 0,
      volume24h: 0,
      fundingRate: {
        ticker,
        rate: 0,
        nextFundingTime: now.toISOString(),
        predictedRate: 0,
      },
    });
    return ticker;
  }

  function marketEvents(type: string): Array<Record<string, unknown>> {
    return published
      .filter((event) => event.channel === 'markets')
      .map((event) => event.payload)
      .filter((payload) => payload.type === type);
  }

  test(cases.perpTrade, async () => {
    const actorId = await createActor();
    const ticker = await seedPerpMarket();
    const service = new TradeExecutionService();
    published.length = 0;

    const opened = await service.executeSingleDecision({
      npcId: actorId,
      npcName: 'NPC broadcast test actor',
      action: 'open_long',
      marketType: 'perp',
      ticker,
      confidence: 1,
      amount: 100,
      reasoning: 'Open a fixture position for the NPC broadcast path',
    });
    if (!opened.positionId) throw new Error('NPC open returned no position');
    const [position] = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, actorId));
    expect(position?.id).toBe(opened.positionId);
    const opens = marketEvents('perp_trade');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      action: 'open',
      ticker,
      positionId: opened.positionId,
    });

    published.length = 0;
    const closed = await service.executeSingleDecision({
      npcId: actorId,
      npcName: 'NPC broadcast test actor',
      action: 'close_position',
      marketType: 'perp',
      positionId: opened.positionId,
      confidence: 1,
      amount: 0,
      reasoning: 'Close the fixture position for the NPC broadcast path',
    });
    expect(closed.action).toBe('close_position');
    const closes = marketEvents('perp_trade');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      action: 'close',
      ticker,
      positionId: opened.positionId,
    });
  });
}
