/** MCP trade events use the web market channel. PRD §§8.1 and 12, MVP Phase 3. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  predictionTrade:
    'place_bet and sell_shares publish the committed prediction market state',
  buyShares: 'buy_shares publishes prediction_trade',
  perpTrade: 'open_position and close_position publish perp_trade',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP trade broadcasts against disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-trade-broadcast',
      file: 'packages/testing/integration/mcp-trade-broadcast.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // Record the real broadcaster's input in this child. CI runs without Redis.
  const actualApi = await import('@feed/api');
  const {
    db,
    eq,
    markets,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    positions,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');

  type Published = { channel: string; payload: Record<string, unknown> };
  const published: Published[] = [];
  const { broadcastToChannel: realBroadcastToChannel } = actualApi;

  mock.module('@feed/api', () => ({
    ...actualApi,
    broadcastToChannel: async (
      channel: Parameters<typeof realBroadcastToChannel>[0],
      payload: Parameters<typeof realBroadcastToChannel>[1]
    ) => {
      published.push({ channel, payload });
      await realBroadcastToChannel(channel, payload);
    },
  }));

  const {
    executeBuyShares,
    executeClosePosition,
    executeOpenPosition,
    executePlaceBet,
    executeSellShares,
  } = await import('../../mcp/src/handlers/tool-handlers');

  async function createUser(): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `mcp_bc_${id.slice(-10)}`,
      profileComplete: true,
      virtualBalance: '10000',
      totalDeposited: '10000',
      updatedAt: new Date(),
    });
    return id;
  }

  async function createPredictionMarket(): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(markets).values({
      id,
      question: `MCP broadcast market ${id}`,
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });
    return id;
  }

  async function createPerpMarket(): Promise<string> {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const ticker = `MCPBC${suffix}`.toUpperCase();
    const orgId = `mcp-bc-org-${suffix}`;
    const now = new Date();
    await db.insert(organizationState).values({
      id: orgId,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: now,
    });
    await db.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: orgId,
      name: 'MCP Broadcast Test Org',
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

  const agentFor = (userId: string) => ({ agentId: 'mcp-bc-agent', userId });

  function marketEvents(type: string): Array<Record<string, unknown>> {
    return published
      .filter((event) => event.channel === 'markets')
      .map((event) => event.payload)
      .filter((payload) => payload.type === type);
  }

  async function storedMarket(marketId: string) {
    const [row] = await db
      .select({ yesShares: markets.yesShares, noShares: markets.noShares })
      .from(markets)
      .where(eq(markets.id, marketId));
    return {
      yesShares: Number(row?.yesShares),
      noShares: Number(row?.noShares),
    };
  }

  test(cases.predictionTrade, async () => {
    const userId = await createUser();
    const marketId = await createPredictionMarket();
    published.length = 0;

    await executePlaceBet(agentFor(userId), {
      marketId,
      side: 'YES',
      amount: 100,
    });
    const afterBuy = await storedMarket(marketId);
    const buys = marketEvents('prediction_trade');
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({
      marketId,
      trade: { actorId: userId, action: 'buy', side: 'yes' },
    });
    // The event carries the market state the trade committed.
    expect(Number(buys[0]?.yesShares)).toBeCloseTo(afterBuy.yesShares, 4);
    expect(Number(buys[0]?.noShares)).toBeCloseTo(afterBuy.noShares, 4);

    const [held] = await db
      .select({ id: positions.id, shares: positions.shares })
      .from(positions)
      .where(eq(positions.userId, userId));
    if (!held) throw new Error('place_bet stored no position');

    published.length = 0;
    await executeSellShares(agentFor(userId), {
      positionId: held.id,
      shares: Number(held.shares),
    });
    const afterSell = await storedMarket(marketId);
    const sells = marketEvents('prediction_trade');
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({
      marketId,
      trade: { actorId: userId, action: 'sell', side: 'yes' },
    });
    // The event carries the market state the trade committed.
    expect(Number(sells[0]?.yesShares)).toBeCloseTo(afterSell.yesShares, 4);
    expect(Number(sells[0]?.noShares)).toBeCloseTo(afterSell.noShares, 4);
  });

  test(cases.buyShares, async () => {
    const userId = await createUser();
    const marketId = await createPredictionMarket();
    published.length = 0;

    await executeBuyShares(agentFor(userId), {
      marketId,
      outcome: 'NO',
      amount: 50,
    });
    const events = marketEvents('prediction_trade');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      marketId,
      trade: { actorId: userId, action: 'buy', side: 'no' },
    });
  });

  test(cases.perpTrade, async () => {
    const userId = await createUser();
    const ticker = await createPerpMarket();
    published.length = 0;

    await executeOpenPosition(agentFor(userId), {
      ticker,
      side: 'LONG',
      amount: 100,
      leverage: 2,
    });
    const [position] = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    if (!position) throw new Error('open_position stored no position');
    const opens = marketEvents('perp_trade');
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({
      action: 'open',
      ticker,
      positionId: position.id,
    });

    published.length = 0;
    await executeClosePosition(agentFor(userId), {
      positionId: position.id,
    });
    const closes = marketEvents('perp_trade');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      action: 'close',
      ticker,
      positionId: position.id,
    });
  });
}
