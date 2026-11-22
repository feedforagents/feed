/**
 * Integration Test: Prediction Trading Modal Buy Quote vs Execution
 *
 * The trading modal (PredictionTradingModal, opened from feed market
 * cards) shows a Trade Preview before the user confirms: Shares
 * Received, Avg Price/Share, If-Wins payout, and Profit. Those numbers
 * are the user's only pre-trade statement of what a buy will credit.
 *
 * Execution (POST /api/markets/predictions/[id]/buy ->
 * PredictionMarketService.buy) charges the configured trading fee on
 * the gross amount and swaps only the net amount through the CPMM, so
 * the credited shares are the fee-aware ones. The modal's quote must be
 * computed the same way (`calculatePredictionBuyQuote`, the fee-aware
 * quote the markets terminal already uses); the fee-free
 * `PredictionPricing.calculateBuy` overstates the shares and the
 * payout on every trade (measured on the base: a 100pt buy into a
 * 500/500 pool previews 183.33 shares and is credited 183.16).
 *
 * This suite drives the real service against a real database, wired
 * exactly like the buy route (FEE_CONFIG fee values), and pins the
 * quote the modal displays to the executed result and to the stored
 * position row. The wallet port is the no-op stub used by the existing
 * market integration suites — the fee is inside the pricing
 * calculation, not the wallet, and the fee-ledger split (FeeService)
 * does not change the credited shares.
 *
 * Each buy also records a PredictionPriceHistory row through the real
 * adapter. That table's marketId has no cascading FK, so teardown
 * deletes the history for the owned market IDs before the markets
 * themselves, lets any cleanup failure fail the suite instead of
 * swallowing it, and verifies every owned row is gone.
 *
 * Scope: this suite is quote-arithmetic and stored-position evidence.
 * It does not exercise wallet debit, fee-ledger allocation, balance
 * constraints, HTTP authentication, or market resolution/redemption.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  calculateExpectedPayout,
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  count,
  db,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { generateSnowflakeId } from '@feed/shared';
import { calculatePredictionBuyQuote } from '../../../apps/web/src/components/markets/predictionBuyQuote';

const testUserIds: string[] = [];
const testMarketIds: string[] = [];

async function createTestUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-${id}`,
    username: `f82-quote-${id}`,
    displayName: 'f82-quote',
    virtualBalance: '100000',
    totalDeposited: '100000',
    totalWithdrawn: '0',
    lifetimePnL: '0',
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  testUserIds.push(id);
  return id;
}

async function createMarket(params: {
  yesShares: number;
  noShares: number;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(markets).values({
    id,
    question: `f82-quote-${id}`,
    liquidity: (params.yesShares + params.noShares).toFixed(2),
    yesShares: params.yesShares.toFixed(6),
    noShares: params.noShares.toFixed(6),
    resolved: false,
    endDate: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
  });
  testMarketIds.push(id);
  return id;
}

/** The buy path wired exactly as the production buy route wires it. */
function buyService(): PredictionMarketService {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 100000 }),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });
}

afterAll(async () => {
  // Delete in dependency order: the price-history rows the buys
  // recorded and the positions first, then their markets, then the
  // users. No error suppression — a cleanup failure fails the suite.
  if (testMarketIds.length > 0) {
    await db
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, testMarketIds));
    await db
      .delete(positions)
      .where(inArray(positions.marketId, testMarketIds));
    await db.delete(markets).where(inArray(markets.id, testMarketIds));
  }
  if (testUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, testUserIds));
  }

  // Prove every owned row is gone, including any row a partially
  // completed case left behind.
  if (testMarketIds.length > 0) {
    const [historyLeft] = await db
      .select({ n: count() })
      .from(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, testMarketIds));
    assert.ok(historyLeft);
    assert.equal(historyLeft.n, 0, 'price-history rows left behind');
    const [positionsLeft] = await db
      .select({ n: count() })
      .from(positions)
      .where(inArray(positions.marketId, testMarketIds));
    assert.ok(positionsLeft);
    assert.equal(positionsLeft.n, 0, 'position rows left behind');
    const [marketsLeft] = await db
      .select({ n: count() })
      .from(markets)
      .where(inArray(markets.id, testMarketIds));
    assert.ok(marketsLeft);
    assert.equal(marketsLeft.n, 0, 'market rows left behind');
  }
  if (testUserIds.length > 0) {
    const [usersLeft] = await db
      .select({ n: count() })
      .from(users)
      .where(inArray(users.id, testUserIds));
    assert.ok(usersLeft);
    assert.equal(usersLeft.n, 0, 'user rows left behind');
  }
});

describe('prediction modal buy quote matches execution', () => {
  const cases = [
    { yesShares: 500, noShares: 500, side: 'yes' as const, amount: 100 },
    { yesShares: 500, noShares: 500, side: 'no' as const, amount: 10 },
    { yesShares: 800, noShares: 200, side: 'yes' as const, amount: 50 },
    { yesShares: 200, noShares: 800, side: 'no' as const, amount: 100 },
  ];

  for (const c of cases) {
    test(`quote == credited shares (pool ${c.yesShares}/${c.noShares}, ${c.side.toUpperCase()}, ${c.amount}pt)`, async () => {
      const userId = await createTestUser();
      const marketId = await createMarket(c);

      // The quote the modal renders before the user confirms.
      const quote = calculatePredictionBuyQuote(
        c.yesShares,
        c.noShares,
        c.side,
        c.amount
      );

      // The real execution.
      const result = await buyService().buy({
        userId,
        marketId,
        side: c.side,
        amount: c.amount,
      });

      expect(result.shares).toBeCloseTo(quote.sharesBought, 9);
      expect(result.avgPrice).toBeCloseTo(quote.avgPrice, 9);
      expect(result.feePaid).toBeCloseTo(quote.fee, 9);
      expect(result.totalCost).toBe(c.amount);

      // The stored position row — the ledger record — holds the quoted shares.
      const [position] = await db
        .select()
        .from(positions)
        .where(eq(positions.marketId, marketId));
      expect(position).toBeDefined();
      expect(Number(position?.shares)).toBeCloseTo(quote.sharesBought, 6);
      expect(Number(position?.avgPrice)).toBeCloseTo(quote.avgPrice, 6);

      // The "If {side} Wins" payout the modal derives from the quote is
      // the redemption the executed shares actually earn (1pt per share,
      // settled to cents — PRD §9.2, D-14).
      expect(calculateExpectedPayout(result.shares, result.avgPrice)).toBe(
        calculateExpectedPayout(quote.sharesBought, quote.avgPrice)
      );
    });
  }
});
