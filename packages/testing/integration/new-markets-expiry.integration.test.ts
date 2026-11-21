/** PRD §9.2 / MVP Phase 6: preserve the existing prediction lifecycle. */
import { describe, expect, test } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import { db, eq, markets, questions } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getNewMarkets } from '@/app/api/feed/new-markets/route';

function makeService() {
  // List/buy-eligibility cases only. The inert wallet is isolation, not
  // evidence for funded buys: the buy below is expected to throw before any
  // wallet call, inside assertMarketActiveForBuy.
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 0 }),
    },
    fees: {
      tradingFeeRate: 0,
      platformShare: 0,
      referrerShare: 0,
      minFeeAmount: 0,
    },
  });
}

function uniqueQuestionNumber() {
  return 910_000 + Math.floor(Math.random() * 8_000);
}

async function insertFixture(kind: 'expired' | 'live') {
  const now = new Date();
  const id = await generateSnowflakeId();
  const questionNumber = uniqueQuestionNumber();
  const text = `New-markets expiry ${kind} ${id}`;
  // Created 1h ago: inside the feed's 24h "recently opened" window.
  const createdAt = new Date(now.getTime() - 60 * 60 * 1000);
  // Expired: resolution 30m ago (a 15m market whose resolution is held for
  // manual review, or whose reject postponed it, stays 'active' like this).
  // Live: resolves in 24h.
  const resolutionDate = new Date(
    now.getTime() + (kind === 'expired' ? -30 : 24 * 60) * 60 * 1000
  );
  await db.insert(questions).values({
    id,
    questionNumber,
    text,
    scenarioId: 1,
    outcome: true,
    rank: 1,
    resolutionDate,
    status: 'active',
    createdAt,
    updatedAt: now,
  });
  await db.insert(markets).values({
    id,
    question: text,
    yesShares: '100',
    noShares: '100',
    liquidity: '1000',
    resolved: false,
    resolution: null,
    endDate: resolutionDate,
    createdAt,
    updatedAt: now,
  });
  // The feed joins markets on questions.marketId.
  await db.update(questions).set({ marketId: id }).where(eq(questions.id, id));
  return { id, questionNumber, text };
}

async function cleanup(ids: string[]) {
  for (const id of ids) {
    await db.delete(markets).where(eq(markets.id, id));
    await db.delete(questions).where(eq(questions.id, id));
  }
}

describe('new-markets feed expiry', () => {
  test('an expired-but-unresolved market is not shown as a New Market trade card', async () => {
    const expired = await insertFixture('expired');
    const live = await insertFixture('live');
    try {
      const res = await getNewMarkets(
        new NextRequest('http://localhost/api/feed/new-markets')
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        markets: Array<{ marketId: string | null; text: string }>;
      };
      const shown = body.markets.map((m) => m.marketId);

      // The trading list and the buy path already agree the expired market
      // is closed: it is excluded from listMarkets and a buy is rejected.
      // These run before the feed assertion so a base failure still proves
      // the divergence (feed shows it, list/buy refuse it) instead of
      // stopping at the first expect.
      const service = makeService();
      const listed = await service.listMarkets();
      expect(listed.some((m) => m.id === expired.id)).toBe(false);
      expect(listed.some((m) => m.id === live.id)).toBe(true);
      await expect(
        service.buy({
          userId: 'new-markets-expiry-probe',
          marketId: expired.id,
          side: 'yes',
          amount: 10,
        })
      ).rejects.toThrow('Market expired');

      // The live market is shown; the expired one must not be.
      expect(shown).toContain(live.id);
      expect(shown).not.toContain(expired.id);
    } finally {
      await cleanup([expired.id, live.id]);
    }
  });
});
