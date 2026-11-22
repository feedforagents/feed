/**
 * Settled prediction result classification (PRD §9.2 [D-14]).
 *
 * The wallet's closed-positions tab badges each resolved prediction row
 * Won or Lost and filters by that outcome. Settlement records the result
 * on the position row (`outcome`), but partial sells accumulate their
 * realized pnl into the same row before settlement — so a position that
 * won its market can finish with negative total pnl, and a position that
 * lost can finish positive. These scenarios are built with the real
 * PredictionMarketService against a real database (the only stub is the
 * wallet port, which records credits instead of moving balances, per the
 * market-engine-integration precedent; the `server-only` marker package
 * is stubbed so the web route module loads under bun).
 *
 * Expected classification comes from the row's recorded outcome; the
 * pre-fix tab classified by the pnl sign and showed both flipped rows
 * backwards.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { PredictionMarketService } from '@feed/core/markets/prediction';
import {
  runIsolatedClosedPredictionPositionsCases,
  verifyClosedPredictionPositionsChildLease,
} from './helpers/sub-market-isolation';

if (
  !process.env.FEED_CLOSED_PREDICTION_POSITIONS_CHILD &&
  !process.env.FEED_CLOSED_PREDICTION_POSITIONS_LEASE_FILE
) {
  test('runs all four settlement classification cases in a fresh database', async () => {
    await runIsolatedClosedPredictionPositionsCases({
      name: 'settled-prediction-classification',
      file: 'packages/testing/integration/settled-result-classification.integration.test.ts',
      cases: [
        'settled prediction result classification > a winning position with negative total pnl (partial sell at a loss first) is classified as won',
        'settled prediction result classification > a losing position with positive total pnl (partial sell at a profit first) is classified as lost',
        'settled prediction result classification > plain settled positions keep their classification (guards)',
        'settled prediction result classification > positions closed by a full sell (never resolved) still classify by pnl (guard)',
      ],
    });
  }, 300_000);
} else {
  // Settlement creates several related rows. Retire the verified database
  // instead of inferring which generated rows are safe to delete.
  await verifyClosedPredictionPositionsChildLease();
  mock.module('server-only', () => ({}));
  const { PredictionDbAdapter, PredictionMarketService: TradingService } =
    await import('@feed/core/markets/prediction');
  const { db, eq, positions, users } = await import('@feed/db');
  const { FEE_CONFIG } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/markets/positions/[userId]/route'
  );
  const { closedPredictionWon } = await import(
    '../../../apps/web/src/components/wallet/v2/closed-prediction-outcome'
  );
  afterAll(async () => {
    await db.$disconnect();
  });

  const credits: Array<{ userId: string; amount: number; reason: string }> = [];

  function makeService() {
    return new TradingService({
      db: new PredictionDbAdapter(),
      wallet: {
        debit: async () => {},
        credit: async (input: {
          userId: string;
          amount: number;
          reason: string;
        }) => {
          credits.push(input);
        },
        recordPnL: async () => {},
        getBalance: async () => ({ balance: 1000000 }),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
  }

  async function makeUser(tag: string) {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `f40-${tag}-${id}`,
      displayName: `F40 ${tag}`,
      updatedAt: new Date(),
    });
    return id;
  }

  let nextQuestionNumber = 1;

  async function makeMarket(service: PredictionMarketService, tag: string) {
    const questionId = await generateSnowflakeId();
    await db.question.create({
      data: {
        id: questionId,
        questionNumber: nextQuestionNumber++,
        text: `F40 settled result ${tag}: will it flip?`,
        scenarioId: 1,
        outcome: true,
        rank: 1,
        status: 'active',
        resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const market = await service.ensureMarketExists({
      marketId: questionId,
      initialLiquidity: 20000,
    });
    return market.id;
  }

  async function rowsFor(userId: string, marketId: string) {
    const rows = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, userId));
    return rows.filter((r) => r.marketId === marketId);
  }

  async function closedSnapshot(userId: string) {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/markets/positions/${userId}?status=closed&type=predictions`
      ),
      { params: Promise.resolve({ userId }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.predictions.positions as Array<{
      id: string;
      marketId: string;
      pnl: number | null;
      outcome: boolean | null;
      status: string;
    }>;
  }

  /** Buy YES, move the price with a whale trade, sell `fraction` of the position. */
  async function buyMovePartialSell(params: {
    service: PredictionMarketService;
    userId: string;
    whaleId: string;
    marketId: string;
    whaleSide: 'yes' | 'no';
    fraction: number;
  }) {
    const { service, userId, whaleId, marketId, whaleSide, fraction } = params;
    const buy = await service.buy({
      userId,
      marketId,
      side: 'yes',
      amount: 200,
    });
    await service.buy({
      userId: whaleId,
      marketId,
      side: whaleSide,
      amount: 15000,
      maxOddsMove: 0.99,
    });
    const sellShares = Math.floor(buy.shares * fraction * 100) / 100;
    await service.sell({ userId, marketId, shares: sellShares });
  }

  describe('settled prediction result classification', () => {
    test('a winning position with negative total pnl (partial sell at a loss first) is classified as won', async () => {
      const service = makeService();
      const userId = await makeUser('win-neg');
      const whaleId = await makeUser('win-neg-whale');
      const marketId = await makeMarket(service, 'win-neg');
      await buyMovePartialSell({
        service,
        userId,
        whaleId,
        marketId,
        whaleSide: 'no',
        fraction: 0.9,
      });
      await service.resolve({ marketId, winningSide: 'yes' });

      const [row] = await rowsFor(userId, marketId);
      expect(row?.status).toBe('resolved');
      expect(row?.outcome).toBe(true);
      // The fixture really is the flipped case: won the market, lost money
      // overall, and still received the settlement credit for the rest.
      expect(Number(row?.pnl)).toBeLessThan(0);
      expect(
        credits.some(
          (c) =>
            c.userId === userId && c.reason === 'pred_resolve' && c.amount > 0
        )
      ).toBe(true);

      const snapshot = await closedSnapshot(userId);
      const shown = snapshot.find((p) => p.marketId === marketId);
      expect(shown?.outcome).toBe(true);
      expect(shown?.pnl).toBeLessThan(0);
      expect(
        closedPredictionWon({ outcome: shown!.outcome, pnl: shown!.pnl ?? 0 })
      ).toBe(true);
    });

    test('a losing position with positive total pnl (partial sell at a profit first) is classified as lost', async () => {
      const service = makeService();
      const userId = await makeUser('lose-pos');
      const whaleId = await makeUser('lose-pos-whale');
      const marketId = await makeMarket(service, 'lose-pos');
      await buyMovePartialSell({
        service,
        userId,
        whaleId,
        marketId,
        whaleSide: 'yes',
        fraction: 0.9,
      });
      await service.resolve({ marketId, winningSide: 'no' });

      const [row] = await rowsFor(userId, marketId);
      expect(row?.status).toBe('resolved');
      expect(row?.outcome).toBe(false);
      expect(Number(row?.pnl)).toBeGreaterThan(0);
      expect(
        credits.some((c) => c.userId === userId && c.reason === 'pred_resolve')
      ).toBe(false);

      const snapshot = await closedSnapshot(userId);
      const shown = snapshot.find((p) => p.marketId === marketId);
      expect(shown?.outcome).toBe(false);
      expect(shown?.pnl).toBeGreaterThan(0);
      expect(
        closedPredictionWon({ outcome: shown!.outcome, pnl: shown!.pnl ?? 0 })
      ).toBe(false);
    });

    test('plain settled positions keep their classification (guards)', async () => {
      const service = makeService();

      const winnerId = await makeUser('plain-win');
      const winMarket = await makeMarket(service, 'plain-win');
      await service.buy({
        userId: winnerId,
        marketId: winMarket,
        side: 'yes',
        amount: 200,
      });
      await service.resolve({ marketId: winMarket, winningSide: 'yes' });
      const [winRow] = await rowsFor(winnerId, winMarket);
      expect(winRow?.outcome).toBe(true);
      expect(Number(winRow?.pnl)).toBeGreaterThan(0);
      expect(
        closedPredictionWon({
          outcome: winRow!.outcome,
          pnl: Number(winRow!.pnl),
        })
      ).toBe(true);

      const loserId = await makeUser('plain-lose');
      const loseMarket = await makeMarket(service, 'plain-lose');
      await service.buy({
        userId: loserId,
        marketId: loseMarket,
        side: 'yes',
        amount: 200,
      });
      await service.resolve({ marketId: loseMarket, winningSide: 'no' });
      const [loseRow] = await rowsFor(loserId, loseMarket);
      expect(loseRow?.outcome).toBe(false);
      expect(Number(loseRow?.pnl)).toBeLessThan(0);
      expect(
        closedPredictionWon({
          outcome: loseRow!.outcome,
          pnl: Number(loseRow!.pnl),
        })
      ).toBe(false);
    });

    test('positions closed by a full sell (never resolved) still classify by pnl (guard)', async () => {
      const service = makeService();
      const userId = await makeUser('sold-out');
      const whaleId = await makeUser('sold-out-whale');
      const marketId = await makeMarket(service, 'sold-out');
      const buy = await service.buy({
        userId,
        marketId,
        side: 'yes',
        amount: 200,
      });
      await service.buy({
        userId: whaleId,
        marketId,
        side: 'no',
        amount: 15000,
        maxOddsMove: 0.99,
      });
      await service.sell({
        userId,
        marketId,
        shares: Math.floor(buy.shares * 100) / 100,
      });

      const [row] = await rowsFor(userId, marketId);
      expect(row?.status).toBe('closed');
      expect(row?.outcome).toBeNull();
      expect(Number(row?.pnl)).toBeLessThan(0);
      expect(
        closedPredictionWon({ outcome: null, pnl: Number(row!.pnl) })
      ).toBe(false);
      expect(closedPredictionWon({ outcome: null, pnl: 5 })).toBe(true);
    });
  });
}
