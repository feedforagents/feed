/**
 * Integration Tests: NPC trade execution money paths
 *
 * Runs against a real Postgres database (DATABASE_URL):
 * - repeated prediction buys keep the poolPositions mirror in sync with the
 *   canonical position, and a sell exits the full canonical holding
 * - legacy poolPositions closes credit exactly once and only to the owner
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  actorState,
  and,
  db,
  eq,
  markets,
  npcTrades,
  poolPositions,
  positions,
} from '@feed/db';
import type { TradingDecision } from '@feed/engine';
import { TradeExecutionService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const suffix = Date.now().toString(36);
const ACTOR_ID = `test-npc-exec-${suffix}`;
const OTHER_ACTOR_ID = `test-npc-other-${suffix}`;
let MARKET_ID = '';

async function actorBalance(actorId: string): Promise<number> {
  const [row] = await db
    .select({ tradingBalance: actorState.tradingBalance })
    .from(actorState)
    .where(eq(actorState.id, actorId));
  return Number(row?.tradingBalance);
}

function decision(overrides: Partial<TradingDecision>): TradingDecision {
  return {
    npcId: ACTOR_ID,
    npcName: 'Test NPC',
    action: 'hold',
    marketType: null,
    amount: 0,
    confidence: 0.8,
    reasoning: 'integration test',
    ...overrides,
  };
}

describe('TradeExecutionService (NPC) money paths', () => {
  const service = new TradeExecutionService();

  beforeAll(async () => {
    const now = new Date();
    await db.insert(actorState).values([
      { id: ACTOR_ID, tradingBalance: '10000', updatedAt: now },
      { id: OTHER_ACTOR_ID, tradingBalance: '10000', updatedAt: now },
    ]);
    MARKET_ID = await generateSnowflakeId();
    await db.insert(markets).values({
      id: MARKET_ID,
      question: 'Integration test: NPC mirror market',
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await db.delete(npcTrades).where(eq(npcTrades.npcActorId, ACTOR_ID));
    await db.delete(poolPositions).where(eq(poolPositions.poolId, ACTOR_ID));
    await db
      .delete(poolPositions)
      .where(eq(poolPositions.poolId, OTHER_ACTOR_ID));
    await db.delete(positions).where(eq(positions.userId, ACTOR_ID));
    await db.delete(markets).where(eq(markets.id, MARKET_ID));
    await db.delete(actorState).where(eq(actorState.id, ACTOR_ID));
    await db.delete(actorState).where(eq(actorState.id, OTHER_ACTOR_ID));
  });

  it('mirrors accumulated holdings across repeated buys and sells them all', async () => {
    await service.executeSingleDecision(
      decision({
        action: 'buy_yes',
        marketType: 'prediction',
        marketId: MARKET_ID,
        amount: 50,
      })
    );
    await service.executeSingleDecision(
      decision({
        action: 'buy_yes',
        marketType: 'prediction',
        marketId: MARKET_ID,
        amount: 50,
      })
    );

    const [canonical] = await db
      .select()
      .from(positions)
      .where(
        and(eq(positions.userId, ACTOR_ID), eq(positions.marketId, MARKET_ID))
      );
    const [mirror] = await db
      .select()
      .from(poolPositions)
      .where(
        and(
          eq(poolPositions.poolId, ACTOR_ID),
          eq(poolPositions.marketId, MARKET_ID)
        )
      );
    expect(Number(canonical?.shares)).toBeGreaterThan(0);
    expect(mirror?.shares).toBeCloseTo(Number(canonical?.shares), 6);
    expect(mirror?.size).toBeCloseTo(100, 6);

    const sold = await service.executeSingleDecision(
      decision({
        action: 'sell_yes',
        marketType: 'prediction',
        marketId: MARKET_ID,
        amount: 0,
      })
    );
    expect(sold.shares).toBeCloseTo(Number(canonical?.shares), 6);

    const [after] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, canonical?.id ?? ''));
    expect(Number(after?.shares)).toBe(0);
    const [mirrorAfter] = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.id, mirror?.id ?? ''));
    expect(mirrorAfter?.closedAt).not.toBeNull();
  });

  it('rejects a non-zero amount on a prediction sell', async () => {
    await expect(
      service.executeSingleDecision(
        decision({
          action: 'sell_yes',
          marketType: 'prediction',
          marketId: MARKET_ID,
          amount: 10,
        })
      )
    ).rejects.toThrow(/must be 0/);
  });

  it('credits a legacy perp close exactly once under concurrency', async () => {
    const positionId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(poolPositions).values({
      id: positionId,
      poolId: ACTOR_ID,
      marketType: 'perp',
      ticker: `NOSUCHTICKER${suffix}`,
      side: 'long',
      entryPrice: 100,
      currentPrice: 110,
      size: 100,
      unrealizedPnL: 0,
      openedAt: now,
      updatedAt: now,
    });
    const before = await actorBalance(ACTOR_ID);

    const results = await Promise.allSettled(
      [0, 1].map(() =>
        service.executeSingleDecision(
          decision({
            action: 'close_position',
            marketType: 'perp',
            positionId,
          })
        )
      )
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // size 100 + pnl 10 - fee 0.1
    expect(await actorBalance(ACTOR_ID)).toBeCloseTo(before + 109.9, 2);
  });

  it('returns only the margin (not full notional) on a leveraged legacy perp close', async () => {
    const positionId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(poolPositions).values({
      id: positionId,
      poolId: ACTOR_ID,
      marketType: 'perp',
      ticker: `NOSUCHTICKER${suffix}`,
      side: 'long',
      entryPrice: 100,
      currentPrice: 110,
      size: 100,
      leverage: 5,
      unrealizedPnL: 0,
      openedAt: now,
      updatedAt: now,
    });
    const before = await actorBalance(ACTOR_ID);

    const result = await service.executeSingleDecision(
      decision({
        action: 'close_position',
        marketType: 'perp',
        positionId,
      })
    );
    expect(result.action).toBe('close_position');
    // Capital at risk is the margin (size / leverage = 20), not the $100
    // notional: margin 20 + pnl 10 - fee 0.1 = 29.9. Crediting the full
    // notional would mint $80 of balance that was never debited.
    expect(await actorBalance(ACTOR_ID)).toBeCloseTo(before + 29.9, 2);
  });

  it("refuses to settle another actor's legacy position", async () => {
    const positionId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(poolPositions).values({
      id: positionId,
      poolId: OTHER_ACTOR_ID,
      marketType: 'perp',
      ticker: `NOSUCHTICKER${suffix}`,
      side: 'long',
      entryPrice: 100,
      currentPrice: 100,
      size: 100,
      unrealizedPnL: 0,
      openedAt: now,
      updatedAt: now,
    });
    const before = await actorBalance(ACTOR_ID);

    await expect(
      service.executeSingleDecision(
        decision({
          action: 'close_position',
          marketType: 'perp',
          positionId,
        })
      )
    ).rejects.toThrow(/not owned/);
    expect(await actorBalance(ACTOR_ID)).toBe(before);
  });
});
