/**
 * Voided prediction result classification.
 *
 * A voided (cancelled) position is refunded at cost basis with no
 * resolution (PRD §9.2 [D-14] — a winning share redeems for exactly 1 pt,
 * so with no resolution there is no winner). The old boolean classifier
 * (`outcome ?? pnl >= 0`) called every such row won: on the head of open
 * PR #2036, which lists cancelled rows in the closed view, a real
 * cancel flow produced status 'cancelled', outcome null, pnl 0 — and
 * `closedPredictionWon` returned true, so the row badges "Won +0.00" and
 * counts under the Won filter. These cases prove the row classifies as
 * 'void' instead, using the real PredictionMarketService.cancel against a
 * real database and the real positions route (same harness as
 * settled-result-classification).
 *
 * The API row is read with status=all: on the base the closed view does
 * not list cancelled rows yet (that is #2036's fix), but status=all
 * already returns them, so the same assertions fail on the base and pass
 * on the fix without depending on #2036.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { PredictionMarketService } from '@feed/core/markets/prediction';
import {
  runIsolatedClosedPredictionPositionsCases,
  verifyClosedPredictionPositionsChildLease,
} from './helpers/sub-market-isolation';

const CASES = [
  'voided prediction result classification > a voided position is classified as void, not won',
  'voided prediction result classification > void classification leaves settled and sell-closed rows alone (guards)',
];

if (
  !process.env.FEED_CLOSED_PREDICTION_POSITIONS_CHILD &&
  !process.env.FEED_CLOSED_PREDICTION_POSITIONS_LEASE_FILE
) {
  test('runs both voided prediction classification cases in a fresh database', async () => {
    await runIsolatedClosedPredictionPositionsCases({
      name: 'voided-prediction-classification',
      file: 'packages/testing/integration/voided-prediction-result-classification.integration.test.ts',
      cases: CASES,
    });
  }, 300_000);
} else {
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
  const { closedPredictionOutcome, closedPredictionWon } = await import(
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
      username: `voidcls-${tag}-${id}`,
      displayName: `Void Cls ${tag}`,
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
        text: `Void classification ${tag}: will it flip?`,
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

  async function allSnapshot(userId: string) {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/markets/positions/${userId}?status=all&type=predictions`
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

  describe('voided prediction result classification', () => {
    test('a voided position is classified as void, not won', async () => {
      const service = makeService();
      const userId = await makeUser('voided');
      const marketId = await makeMarket(service, 'voided');
      await service.buy({
        userId,
        marketId,
        side: 'yes',
        amount: 200,
      });
      const result = await service.cancel({ marketId });
      expect(result.positionsRefunded).toBe(1);
      expect(result.totalRefunded).toBe(200);

      const [row] = await rowsFor(userId, marketId);
      expect(row?.status).toBe('cancelled');
      expect(row?.outcome).toBeNull();
      // Full refund: the stored pnl is the cost-basis refund, ~0.
      expect(Math.abs(Number(row?.pnl ?? 0))).toBeLessThan(1);

      const snapshot = await allSnapshot(userId);
      const shown = snapshot.find((p) => p.marketId === marketId);
      expect(shown).toBeDefined();
      expect(shown?.status).toBe('cancelled');
      expect(shown?.outcome).toBeNull();
      // The defect: on the base this classifies as won ("Won +0.00").
      expect(
        closedPredictionOutcome({
          outcome: shown!.outcome,
          pnl: shown!.pnl ?? 0,
          status: shown!.status,
        })
      ).toBe('void');
      expect(
        closedPredictionWon({
          outcome: shown!.outcome,
          pnl: shown!.pnl ?? 0,
          status: shown!.status,
        })
      ).toBe(false);
    });

    test('void classification leaves settled and sell-closed rows alone (guards)', async () => {
      // Resolved rows still classify by outcome, even when the pnl sign
      // disagrees (the settled-result-classification cases).
      expect(
        closedPredictionOutcome({ outcome: true, pnl: -5, status: 'resolved' })
      ).toBe('won');
      expect(
        closedPredictionOutcome({ outcome: false, pnl: 5, status: 'resolved' })
      ).toBe('lost');
      // A sell-closed row at exactly breakeven is still a win by the
      // long-standing pnl rule — only status 'cancelled' voids.
      expect(
        closedPredictionOutcome({ outcome: null, pnl: 0, status: 'closed' })
      ).toBe('won');
      expect(
        closedPredictionOutcome({ outcome: null, pnl: 5, status: 'closed' })
      ).toBe('won');
      expect(
        closedPredictionOutcome({ outcome: null, pnl: -5, status: 'closed' })
      ).toBe('lost');
      // Callers that do not pass a status keep the old behaviour.
      expect(closedPredictionWon({ outcome: null, pnl: 5 })).toBe(true);
      expect(closedPredictionWon({ outcome: null, pnl: -5 })).toBe(false);
    });
  });
}
