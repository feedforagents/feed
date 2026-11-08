/**
 * Integration Test: Position Detail Modal Add-Buy Quote vs Execution
 *
 * The position detail modal (PositionDetailModal, opened from a profile
 * position) lets a holder add to an existing prediction position. Its
 * trade tab shows Shares Received, an If-{side}-Wins payout, and the
 * Expected Profit before the user confirms — the user's only pre-trade
 * statement of what the add will credit.
 *
 * Execution (POST /api/markets/predictions/[id]/buy ->
 * PredictionMarketService.buy, the same route the modal's buy button
 * calls) charges the configured trading fee on the gross amount and
 * swaps only the net amount through the CPMM, so the credited shares
 * are the fee-aware ones. The modal's quote must be computed the same
 * way (`calculatePredictionBuyQuote`, the fee-aware quote the markets
 * terminal already uses); the fee-free `PredictionPricing.calculateBuy`
 * overstates the shares and the payout on every add (measured on the
 * base, from a held position in a 500/500 pool: adding 100pt previews
 * 169.94 shares and is credited 169.78).
 *
 * This suite drives the real service against a real database, wired
 * exactly like the buy route (FEE_CONFIG fee values): each case first
 * opens a position through the service, then pins the quote the modal
 * displays for the add to the executed add result and to the stored
 * position row's share delta. The wallet port is the no-op stub used
 * by the existing market integration suites — the fee is inside the
 * pricing calculation, not the wallet, and the fee-ledger split
 * (FeeService) does not change the credited shares.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  calculateExpectedPayout,
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import { db, eq, markets, positions, users } from '@feed/db';
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
    username: `f86-add-quote-${id}`,
    displayName: 'f86-add-quote',
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
    question: `f86-add-quote-${id}`,
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

async function poolOf(marketId: string) {
  const [market] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);
  return {
    yes: Number(market?.yesShares),
    no: Number(market?.noShares),
  };
}

async function totalShares(userId: string, marketId: string) {
  const rows = await db
    .select()
    .from(positions)
    .where(eq(positions.userId, userId));
  return rows
    .filter((row) => row.marketId === marketId)
    .reduce((sum, row) => sum + Number(row.shares), 0);
}

afterAll(async () => {
  for (const marketId of testMarketIds) {
    await db
      .delete(positions)
      .where(eq(positions.marketId, marketId))
      .catch(() => {});
    await db
      .delete(markets)
      .where(eq(markets.id, marketId))
      .catch(() => {});
  }
  for (const userId of testUserIds) {
    await db
      .delete(users)
      .where(eq(users.id, userId))
      .catch(() => {});
  }
});

describe('position detail add-buy quote matches execution', () => {
  const cases = [
    {
      yesShares: 500,
      noShares: 500,
      openSide: 'yes' as const,
      openAmount: 50,
      addSide: 'yes' as const,
      addAmount: 100,
    },
    {
      yesShares: 500,
      noShares: 500,
      openSide: 'no' as const,
      openAmount: 25,
      addSide: 'no' as const,
      addAmount: 10,
    },
    {
      yesShares: 800,
      noShares: 200,
      openSide: 'yes' as const,
      openAmount: 20,
      addSide: 'yes' as const,
      addAmount: 50,
    },
    {
      yesShares: 200,
      noShares: 800,
      openSide: 'no' as const,
      openAmount: 30,
      addSide: 'no' as const,
      addAmount: 100,
    },
  ];

  for (const c of cases) {
    test(`add quote == credited shares (pool ${c.yesShares}/${c.noShares}, hold ${c.openSide.toUpperCase()} ${c.openAmount}, add ${c.addSide.toUpperCase()} ${c.addAmount}pt)`, async () => {
      const userId = await createTestUser();
      const marketId = await createMarket(c);
      const service = buyService();

      // The modal's precondition: the user already holds this position,
      // opened through the same real execution path.
      await service.buy({
        userId,
        marketId,
        side: c.openSide,
        amount: c.openAmount,
      });
      const sharesBefore = await totalShares(userId, marketId);
      expect(sharesBefore).toBeGreaterThan(0);

      // The quote the modal renders for the add, computed on the
      // market's current pool — what its props carry.
      const pool = await poolOf(marketId);
      const quote = calculatePredictionBuyQuote(
        pool.yes,
        pool.no,
        c.addSide,
        c.addAmount
      );

      // The real add execution (the modal's buy button, same route).
      const result = await service.buy({
        userId,
        marketId,
        side: c.addSide,
        amount: c.addAmount,
      });

      expect(result.shares).toBeCloseTo(quote.sharesBought, 9);
      expect(result.avgPrice).toBeCloseTo(quote.avgPrice, 9);
      expect(result.feePaid).toBeCloseTo(quote.fee, 9);
      expect(result.totalCost).toBe(c.addAmount);

      // The stored position row grows by exactly the quoted shares —
      // Shares Received is the increment, not a fresh position.
      const sharesAfter = await totalShares(userId, marketId);
      expect(sharesAfter - sharesBefore).toBeCloseTo(quote.sharesBought, 6);

      // The "If {side} Wins" payout the modal derives from the quote is
      // the redemption the executed add shares actually earn (1pt per
      // share, settled to cents — PRD §9.2, D-14).
      expect(calculateExpectedPayout(result.shares, result.avgPrice)).toBe(
        calculateExpectedPayout(quote.sharesBought, quote.avgPrice)
      );
    });
  }
});
