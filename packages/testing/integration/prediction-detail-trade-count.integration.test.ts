/**
 * Integration test: the prediction market detail tradeCount counts every
 * executed trade on the market.
 *
 * GET /api/markets/predictions/[id] reports tradeCount as
 *   BalanceTransaction rows (type pred_buy/pred_sell, relatedId = market)
 *   + NPCTrade rows (marketType = 'prediction', marketId = market),
 * and the market's trades feed unions the same two sources. An NPC trade is
 * therefore visible on the market detail screen only if its execution path
 * writes one of those rows:
 *
 * - Users and non-NPC agents pay through WalletService -> pred_buy/pred_sell.
 * - TradeExecutionService (npc-investment-manager) mirrors every executed
 *   NPC prediction trade into NPCTrade.
 * - executeDirectTrade — the retained NPC execution path of the autonomous
 *   loop (MultiStepExecutor -> executeDirectTrade, used by npc-tick) — pays
 *   from the actorState wallet and records the trade only in AgentTrade
 *   (agent analytics). It writes neither source, so an autonomous NPC buy or
 *   sell moves the market price and opens/closes a real position while the
 *   detail screen's tradeCount and trades feed never show it.
 *
 * This suite executes real trades through both NPC paths against a real
 * database and reads the real detail route after each one. Nothing is
 * mocked.
 *
 * Run with:
 *   DATABASE_URL="postgresql://postgres@localhost:54373/feed_test_g33" \
 *     bun test integration/prediction-detail-trade-count.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { executeDirectTrade } from '@feed/agents';
import {
  actorState,
  agentTrades,
  balanceTransactions,
  db,
  eq,
  markets,
  npcTrades,
  positions,
} from '@feed/db';
import { TradeExecutionService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const NPC_ID = 'ailon-musk'; // static actor from StaticDataRegistry
const suffix = Date.now().toString(36);
const ENGINE_ACTOR_ID = `test-npc-g33-${suffix}`;

let MARKET_ID = '';
let originalActorState: typeof actorState.$inferSelect | undefined;

let GET: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/route').GET;
let GET_TRADES: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/trades/route').GET;

async function fetchDetailTradeCount(): Promise<number> {
  const request = new NextRequest(
    new Request(`http://localhost/api/markets/predictions/${MARKET_ID}`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: MARKET_ID }),
  });
  const body = (await response.json().catch(() => null)) as {
    market?: { tradeCount?: number };
    data?: { market?: { tradeCount?: number } };
  } | null;
  const tradeCount = body?.market?.tradeCount ?? body?.data?.market?.tradeCount;
  if (typeof tradeCount !== 'number') {
    throw new Error(
      `Detail route did not return a numeric tradeCount: ${JSON.stringify(body)}`
    );
  }
  return tradeCount;
}

async function npcPositionShares(userId: string): Promise<number> {
  const rows = await db
    .select({ shares: positions.shares, status: positions.status })
    .from(positions)
    .where(eq(positions.userId, userId));
  return rows
    .filter((r) => r.status === 'active' || !r.status)
    .reduce((sum, r) => sum + Number(r.shares), 0);
}

describe('prediction market detail tradeCount (all NPC execution paths)', () => {
  beforeAll(async () => {
    ({ GET } = await import(
      '../../../apps/web/src/app/api/markets/predictions/[id]/route'
    ));
    ({ GET: GET_TRADES } = await import(
      '../../../apps/web/src/app/api/markets/predictions/[id]/trades/route'
    ));

    [originalActorState] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, NPC_ID));

    const now = new Date();
    if (originalActorState) {
      await db
        .update(actorState)
        .set({ tradingBalance: '10000', updatedAt: now })
        .where(eq(actorState.id, NPC_ID));
    } else {
      await db
        .insert(actorState)
        .values({ id: NPC_ID, tradingBalance: '10000', updatedAt: now });
    }
    await db
      .insert(actorState)
      .values({ id: ENGINE_ACTOR_ID, tradingBalance: '10000', updatedAt: now });

    MARKET_ID = await generateSnowflakeId();
    await db.insert(markets).values({
      id: MARKET_ID,
      question: 'Integration test: detail tradeCount market',
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: now,
    });

    expect(await fetchDetailTradeCount()).toBe(0);
  });

  afterAll(async () => {
    await db.delete(npcTrades).where(eq(npcTrades.marketId, MARKET_ID));
    await db.delete(positions).where(eq(positions.marketId, MARKET_ID));
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.relatedId, MARKET_ID));
    await db.delete(agentTrades).where(eq(agentTrades.marketId, MARKET_ID));
    await db.delete(markets).where(eq(markets.id, MARKET_ID));
    await db.delete(actorState).where(eq(actorState.id, ENGINE_ACTOR_ID));
    if (originalActorState) {
      await db
        .update(actorState)
        .set({
          tradingBalance: originalActorState.tradingBalance,
          updatedAt: new Date(),
        })
        .where(eq(actorState.id, NPC_ID));
    } else {
      await db.delete(actorState).where(eq(actorState.id, NPC_ID));
    }
  });

  it('counts an autonomous-loop NPC buy (executeDirectTrade)', async () => {
    const result = await executeDirectTrade({
      agentUserId: NPC_ID,
      marketType: 'prediction',
      marketId: MARKET_ID,
      side: 'buy_yes',
      amount: 50,
      reasoning: 'integration test',
    });
    expect(result.success).toBe(true);

    // The trade really executed: a real position exists and the market moved.
    expect(await npcPositionShares(NPC_ID)).toBeGreaterThan(0);

    // ... so the market detail screen must count it.
    expect(await fetchDetailTradeCount()).toBe(1);
  });

  it('counts an autonomous-loop NPC sell (executeDirectTrade)', async () => {
    const result = await executeDirectTrade({
      agentUserId: NPC_ID,
      marketType: 'prediction',
      marketId: MARKET_ID,
      side: 'sell_yes',
      amount: 0,
      reasoning: 'integration test',
    });
    expect(result.success).toBe(true);
    expect(await npcPositionShares(NPC_ID)).toBe(0);

    expect(await fetchDetailTradeCount()).toBe(2);
  });

  it('counts a TradeExecutionService NPC buy exactly once (control)', async () => {
    const service = new TradeExecutionService();
    await service.executeSingleDecision({
      npcId: ENGINE_ACTOR_ID,
      npcName: 'G33 Control NPC',
      action: 'buy_no',
      marketType: 'prediction',
      marketId: MARKET_ID,
      amount: 50,
      confidence: 0.8,
      reasoning: 'integration test',
    });
    expect(await npcPositionShares(ENGINE_ACTOR_ID)).toBeGreaterThan(0);

    // 2 autonomous trades + 1 engine trade = 3 executed trades in total.
    expect(await fetchDetailTradeCount()).toBe(3);
  });

  it('lists every executed trade in the market trades feed', async () => {
    const request = new NextRequest(
      new Request(
        `http://localhost/api/markets/predictions/${MARKET_ID}/trades?limit=100&offset=0`
      )
    );
    const response = await GET_TRADES(request, {
      params: Promise.resolve({ id: MARKET_ID }),
    });
    const body = (await response.json().catch(() => null)) as {
      trades?: Array<{ type: string }>;
      data?: { trades?: Array<{ type: string }> };
    } | null;
    const trades = body?.trades ?? body?.data?.trades ?? [];
    // All three executed trades are NPC trades; the feed must list all 3.
    expect(trades.length).toBe(3);
    expect(trades.every((t) => t.type === 'npc')).toBe(true);
  });
});
