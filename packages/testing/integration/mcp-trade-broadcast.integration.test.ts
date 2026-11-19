/**
 * MCP trades must publish the same `markets` realtime events as the web
 * trade routes. The web prediction buy/sell routes and the web perp
 * open/close routes give their services a broadcast port, so an open
 * market page (usePredictionMarketStream / usePerpMarketStream) moves when
 * a trade lands. The MCP trade tools built the same services without one,
 * so a trade placed by an agent never reached the website until a reload.
 *
 * Real MCP handlers, real market services, real Postgres. The real
 * `broadcastToChannel` still runs; the test only records each call to it.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';
import * as actualApi from '@feed/api';
import {
  db,
  eq,
  inArray,
  markets,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

type Published = { channel: string; payload: Record<string, unknown> };
const published: Published[] = [];
const realBroadcastToChannel = actualApi.broadcastToChannel;

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

const userIds: string[] = [];
const marketIds: string[] = [];
const tickers: string[] = [];
const orgIds: string[] = [];

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
  userIds.push(id);
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
  marketIds.push(id);
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
  tickers.push(ticker);
  orgIds.push(orgId);
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
  return { yesShares: Number(row?.yesShares), noShares: Number(row?.noShares) };
}

describe('MCP trade tools publish market events', () => {
  afterAll(async () => {
    await db.delete(positions).where(inArray(positions.userId, userIds));
    await db
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, marketIds));
    await db.delete(markets).where(inArray(markets.id, marketIds));
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, userIds));
    await db
      .delete(perpMarketSnapshots)
      .where(inArray(perpMarketSnapshots.ticker, tickers));
    await db
      .delete(organizationState)
      .where(inArray(organizationState.id, orgIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('place_bet and sell_shares publish prediction_trade with the stored market state', async () => {
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

  it('buy_shares publishes prediction_trade', async () => {
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

  it('open_position and close_position publish perp_trade', async () => {
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
});
