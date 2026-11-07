/**
 * Integration Test — Prediction Market Trades `total`
 *
 * @route GET /api/markets/predictions/[id]/trades
 *
 * Real PostgreSQL (DATABASE_URL must point at a disposable DB with the
 * drizzle migrations applied). No DB mocking: fixtures are inserted as
 * rows and both the trades handler and the sibling market-detail handler
 * run against them.
 *
 * The market detail route reports `tradeCount` for the same market as the
 * count of user pred_buy/pred_sell balance transactions plus NPC trades.
 * The trades route merges exactly those two sources, so its `total` must
 * be that same count on every page — the perps sibling route returns the
 * full merged count as `total` too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';

const RUN = Math.random().toString(36).slice(2, 8);
const MARKET_ID = `f10-market-${RUN}`;
const OTHER_MARKET_ID = `f10-other-${RUN}`;
const TRADER_ID = `f10-trader-${RUN}`;
const NPC_ID = `f10-npc-${RUN}`;

const BALANCE_TRADES = 25; // user pred_buy/pred_sell rows for MARKET_ID
const NPC_TRADES = 10; // NPC prediction trades for MARKET_ID
const REAL_TOTAL = BALANCE_TRADES + NPC_TRADES; // 35

const { db, markets, users, balanceTransactions, npcTrades, sql } =
  await import('@feed/db');
const { GET: getTrades } = await import('../route');
const { GET: getDetail } = await import('../../route');

function tradesRequest(limit: number, offset: number) {
  return new NextRequest(
    `http://localhost/api/markets/predictions/${MARKET_ID}/trades?limit=${limit}&offset=${offset}`
  );
}

async function callTrades(limit: number, offset: number) {
  const res = await getTrades(tradesRequest(limit, offset), {
    params: Promise.resolve({ id: MARKET_ID }),
  });
  return (await res.json()) as {
    trades: unknown[];
    total: number;
    hasMore: boolean;
  };
}

describe('GET /api/markets/predictions/[id]/trades total', () => {
  beforeAll(async () => {
    const now = new Date();
    await db.insert(users).values([
      {
        id: TRADER_ID,
        username: `trader-${RUN}`,
        displayName: 'Trader',
        updatedAt: now,
      },
      {
        id: NPC_ID,
        username: `npc-${RUN}`,
        displayName: 'NPC',
        isActor: true,
        updatedAt: now,
      },
    ]);
    await db.insert(markets).values([
      {
        id: MARKET_ID,
        question: 'Will the F10 fixture resolve yes?',
        liquidity: '1000',
        endDate: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        updatedAt: now,
      },
      {
        id: OTHER_MARKET_ID,
        question: 'Unrelated market',
        liquidity: '1000',
        endDate: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        updatedAt: now,
      },
    ]);

    // 25 user trades on this market, one per minute, alternating buy/sell.
    const balanceRows = Array.from({ length: BALANCE_TRADES }, (_, i) => ({
      id: `f10-bt-${RUN}-${i}`,
      userId: TRADER_ID,
      type: i % 2 === 0 ? 'pred_buy' : 'pred_sell',
      amount: '10',
      balanceBefore: '100',
      balanceAfter: '90',
      relatedId: MARKET_ID,
      createdAt: new Date(now.getTime() - (100 + i) * 60_000),
    }));
    // Decoys that must NOT be counted: a refund row on this market and
    // trades belonging to another market.
    balanceRows.push(
      {
        id: `f10-bt-${RUN}-cancel`,
        userId: TRADER_ID,
        type: 'pred_cancel',
        amount: '10',
        balanceBefore: '100',
        balanceAfter: '110',
        relatedId: MARKET_ID,
        createdAt: new Date(now.getTime() - 30 * 60_000),
      },
      {
        id: `f10-bt-${RUN}-other`,
        userId: TRADER_ID,
        type: 'pred_buy',
        amount: '10',
        balanceBefore: '100',
        balanceAfter: '90',
        relatedId: OTHER_MARKET_ID,
        createdAt: new Date(now.getTime() - 20 * 60_000),
      }
    );
    await db.insert(balanceTransactions).values(balanceRows);

    // 10 NPC prediction trades on this market, one per minute.
    const npcRows = Array.from({ length: NPC_TRADES }, (_, i) => ({
      id: `f10-npc-${RUN}-${i}`,
      npcActorId: NPC_ID,
      marketType: 'prediction',
      marketId: MARKET_ID,
      action: 'buy',
      side: 'yes',
      amount: 5,
      price: 0.5,
      executedAt: new Date(now.getTime() - (50 + i) * 60_000),
    }));
    // Decoy: an NPC perp trade that happens to carry the same marketId.
    npcRows.push({
      id: `f10-npc-${RUN}-perp`,
      npcActorId: NPC_ID,
      marketType: 'perp',
      marketId: MARKET_ID,
      action: 'buy',
      side: 'long',
      amount: 5,
      price: 0.5,
      executedAt: new Date(now.getTime() - 10 * 60_000),
    });
    await db.insert(npcTrades).values(npcRows);
  });

  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM "BalanceTransaction" WHERE "relatedId" IN (${MARKET_ID}, ${OTHER_MARKET_ID})`
    );
    await db.execute(
      sql`DELETE FROM "NPCTrade" WHERE "marketId" = ${MARKET_ID}`
    );
    await db.execute(
      sql`DELETE FROM "Market" WHERE "id" IN (${MARKET_ID}, ${OTHER_MARKET_ID})`
    );
    await db.execute(
      sql`DELETE FROM "User" WHERE "id" IN (${TRADER_ID}, ${NPC_ID})`
    );
  });

  it('reports the full merged trade count as total on the first page', async () => {
    const page = await callTrades(20, 0);
    expect(page.trades.length).toBe(20);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(REAL_TOTAL);
  });

  it('reports the same total on the last page', async () => {
    const page = await callTrades(20, 20);
    expect(page.trades.length).toBe(REAL_TOTAL - 20);
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(REAL_TOTAL);
  });

  it('agrees with the market detail tradeCount for the same market', async () => {
    const res = await getDetail(
      new NextRequest(`http://localhost/api/markets/predictions/${MARKET_ID}`),
      { params: Promise.resolve({ id: MARKET_ID }) }
    );
    const body = (await res.json()) as {
      market: { tradeCount: number };
    };
    expect(body.market.tradeCount).toBe(REAL_TOTAL);

    const page = await callTrades(20, 0);
    expect(page.total).toBe(body.market.tradeCount);
  });
});
