/**
 * NPC trade execution in a leased PostgreSQL database (PRD §9.1, MVP Phase 6).
 * Successful legacy closes write fee rows and credit the stability fund along
 * with the NPC wallet. Keep those effects inside the verified test database.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { TradingDecision } from '@feed/engine';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'TradeExecutionService (NPC) money paths';
const cases = {
  predictionMirror:
    'mirrors accumulated holdings across repeated buys and sells them all',
  nonzeroSell: 'rejects a non-zero amount on a prediction sell',
  concurrentClose: 'credits a legacy perp close exactly once under concurrency',
  leveragedClose:
    'returns only the margin (not full notional) on a leveraged legacy perp close',
  otherActor: "refuses to settle another actor's legacy position",
};

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { actorState, and, db, eq, markets, poolPositions, positions } =
    await import('@feed/db');
  const { TradeExecutionService } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');

  const ACTOR_ID = 'test-npc-exec';
  const OTHER_ACTOR_ID = 'test-npc-other';
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

  describe(suite, () => {
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

    it(cases.predictionMirror, async () => {
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

    it(cases.nonzeroSell, async () => {
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

    it(cases.concurrentClose, async () => {
      const positionId = await generateSnowflakeId();
      const now = new Date();
      await db.insert(poolPositions).values({
        id: positionId,
        poolId: ACTOR_ID,
        marketType: 'perp',
        ticker: 'NOSUCHTICKER',
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

    it(cases.leveragedClose, async () => {
      const positionId = await generateSnowflakeId();
      const now = new Date();
      await db.insert(poolPositions).values({
        id: positionId,
        poolId: ACTOR_ID,
        marketType: 'perp',
        ticker: 'NOSUCHTICKER',
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

    it(cases.otherActor, async () => {
      const positionId = await generateSnowflakeId();
      const now = new Date();
      await db.insert(poolPositions).values({
        id: positionId,
        poolId: OTHER_ACTOR_ID,
        marketType: 'perp',
        ticker: 'NOSUCHTICKER',
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
} else {
  it('runs NPC trade execution in a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'npc-trade-execution',
      file: 'packages/testing/integration/npc-trade-execution.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
}
