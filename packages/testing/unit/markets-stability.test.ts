/**
 * Markets Stability Tests
 *
 * Validates the price stability guards introduced in the markets QA pass:
 *   1. Prediction: MAX_ODDS_MOVE_PER_TRADE cap rejects oversized trades
 *   2. Prediction: ODDS_HARD_FLOOR/CEILING rejects trades pushing to extremes
 *   3. Prediction: callers can relax the cap via maxOddsMove option
 *   4. Perps: calculatePriceFromHoldings ceiling respects 4× initialPrice
 *   5. Perps: config constants sanity-check
 *
 * Trade amounts are pre-calculated to hit/miss specific thresholds:
 *   - Balanced pool (5000/5000, $10k): $3000 YES moves +21.76ppt (> 20ppt cap)
 *   - Thin pool (100/100): $700 NO pushes YES to ~1.6% (< 2% hard floor)
 *   - Skewed YES pool (250/9750): $2000 YES pushes YES to 98.26% (> 98% hard ceiling)
 *   - Skewed NO pool (9750/250): $5000 NO pushes YES to ~1.1% (< 2% hard floor)
 * Sells mirror the buy guards (same 20ppt cap, same 2%/98% bounds):
 *   - Balanced pool: selling 3000 YES shares moves odds -14.37ppt (passes);
 *     selling 4500 YES shares moves -20.52ppt (> 20ppt cap)
 *   - Skewed YES pool (250/9750): selling 2000 NO shares pushes YES to 98.25%
 *   - Skewed NO pool (9750/250): selling 2000 YES shares pushes YES to 1.75%
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  calculatePriceFromHoldings,
  PERP_MARKET_CONFIG,
} from '@feed/shared/constants/markets';
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionServiceDeps,
  PredictionSide,
  QuestionRecord,
} from '../../core/markets/prediction';
import {
  PredictionMarketService,
  PredictionPricing,
} from '../../core/markets/prediction';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

function makeMarket(
  overrides: Partial<PredictionMarketRecord> = {}
): PredictionMarketRecord {
  return {
    id: 'market-1',
    question: 'Will X happen?',
    yesShares: 5000,
    noShares: 5000,
    liquidity: 10_000,
    endDate: tomorrow,
    resolved: false,
    ...overrides,
  };
}

function makePosition(
  side: PredictionSide,
  shares: number
): PredictionPositionRecord {
  return {
    id: 'pos-1',
    userId: 'u1',
    marketId: 'market-1',
    side,
    shares,
    avgPrice: 0.5,
    cashCostBasis: 0,
    status: 'active',
    pnl: 0,
  };
}

function makeService(
  marketOverrides: Partial<PredictionMarketRecord> = {},
  position: PredictionPositionRecord | null = null
): PredictionMarketService {
  const market = makeMarket(marketOverrides);

  const mockDb: PredictionDbPort = {
    getMarketById: mock(async () => market),
    getMarketsByIds: mock(async () => [market]),
    createMarketFromQuestion: mock(async (q: QuestionRecord) =>
      makeMarket({ id: q.id, question: q.text })
    ),
    updateMarketState: mock(async (_id, updates) => ({
      ...market,
      ...updates,
    })),
    getPosition: mock(async (_userId, _marketId, side: PredictionSide) =>
      position && position.side === side ? position : null
    ),
    upsertPosition: mock(async (pos) => ({
      ...pos,
      id: pos.id ?? 'new-pos',
    })) as PredictionDbPort['upsertPosition'],
    deletePosition: mock(async () => {}),
    listPositionsForMarket: mock(async () => []),
    insertPriceSnapshot: mock(async () => {}),
  };

  const deps: PredictionServiceDeps = {
    db: mockDb,
    wallet: {
      debit: mock(async () => {}),
      credit: mock(async () => {}),
      recordPnL: mock(async () => {}),
      getBalance: mock(async () => ({ balance: 100_000, lifetimePnL: 0 })),
    },
    broadcast: { emit: mock(async () => {}) },
    fees: {
      tradingFeeRate: 0.01,
      platformShare: 0.8,
      referrerShare: 0.1,
      minFeeAmount: 0.01,
    },
  };

  return new PredictionMarketService(deps);
}

// ---------------------------------------------------------------------------
// 1. Prediction: MAX_ODDS_MOVE_PER_TRADE guard
// ---------------------------------------------------------------------------
describe('PredictionMarketService — odds move cap', () => {
  test('small trade (< 20ppt move) succeeds', async () => {
    const service = makeService();
    // $50 on a $10k pool moves odds by ~0.5ppt — well under the 20ppt cap
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'yes',
        amount: 50,
      })
    ).resolves.toBeDefined();
  });

  test('large trade that moves odds > 20ppt is rejected by default', async () => {
    const service = makeService();
    // $3000 YES buy on 5000/5000 pool → +21.76ppt (> 20ppt default cap)
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'yes',
        amount: 3000,
      })
    ).rejects.toThrow(/move odds by/i);
  });

  test('caller can relax the cap with maxOddsMove: 0.30', async () => {
    const service = makeService();
    // Same $3000 trade is allowed when caller allows up to 30ppt
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'yes',
        amount: 3000,
        maxOddsMove: 0.3,
      })
    ).resolves.toBeDefined();
  });

  test('thin pool: trade passing maxOddsMove but hitting hard floor is still rejected', async () => {
    // Thin market: 100/100 shares. $700 NO buy → YES odds ~1.57% (< 2% hard floor)
    // oddsShift ~48ppt is < maxOddsMove 100ppt, so only the hard floor catches it
    const service = makeService({
      yesShares: 100,
      noShares: 100,
      liquidity: 200,
    });
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'no',
        amount: 700,
        maxOddsMove: 1.0,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Prediction: hard floor/ceiling (2%/98%)
// ---------------------------------------------------------------------------
describe('PredictionMarketService — hard odds floor/ceiling', () => {
  test('trade pushing YES above 98% is rejected', async () => {
    // Skewed: 250/9750 → YES at 97.5%. $2000 YES buy → 98.26% (> 98% hard ceiling)
    // oddsShift is only ~0.76ppt (tiny), so only the ceiling guard catches it
    const service = makeService({
      yesShares: 250,
      noShares: 9750,
      liquidity: 10_000,
    });
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'yes',
        amount: 2000,
        maxOddsMove: 1.0,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });

  test('trade pushing YES below 2% is rejected', async () => {
    // Skewed: 9750/250 → YES at 2.5%. $5000 NO buy → ~1.1% (< 2% hard floor)
    // oddsShift ~1.38ppt is tiny, so only the floor guard catches it
    const service = makeService({
      yesShares: 9750,
      noShares: 250,
      liquidity: 10_000,
    });
    await expect(
      service.buy({
        userId: 'u1',
        marketId: 'market-1',
        side: 'no',
        amount: 5000,
        maxOddsMove: 1.0,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Prediction: PredictionPricing math is unchanged
// ---------------------------------------------------------------------------
describe('PredictionPricing static helpers', () => {
  test('getCurrentPrice returns 0.5 for balanced pool', () => {
    expect(PredictionPricing.getCurrentPrice(5000, 5000, 'yes')).toBeCloseTo(
      0.5
    );
    expect(PredictionPricing.getCurrentPrice(5000, 5000, 'no')).toBeCloseTo(
      0.5
    );
  });

  test('getCurrentPrice handles skewed pool', () => {
    // yesShares=9000, noShares=1000 → yesPrice = noShares/total = 1000/10000 = 10%
    expect(PredictionPricing.getCurrentPrice(9000, 1000, 'yes')).toBeCloseTo(
      0.1
    );
    expect(PredictionPricing.getCurrentPrice(9000, 1000, 'no')).toBeCloseTo(
      0.9
    );
  });

  test('calculateBuy yields positive sharesBought and valid new prices', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    expect(result.sharesBought).toBeGreaterThan(0);
    expect(result.newYesPrice).toBeGreaterThan(0.5); // YES price should rise
    expect(result.newYesPrice).toBeLessThan(1);
    expect(result.newNoPrice).toBeGreaterThan(0);
    expect(result.newYesPrice + result.newNoPrice).toBeCloseTo(1, 5);
  });

  test('initializeMarket clamps probability to [5%, 95%]', () => {
    const { yesShares: ys1, noShares: ns1 } =
      PredictionPricing.initializeMarket(10000, 0.0);
    const p1 = ns1 / (ys1 + ns1);
    expect(p1).toBeGreaterThanOrEqual(0.05);

    const { yesShares: ys2, noShares: ns2 } =
      PredictionPricing.initializeMarket(10000, 1.0);
    const p2 = ns2 / (ys2 + ns2);
    expect(p2).toBeLessThanOrEqual(0.95);
  });
});

// ---------------------------------------------------------------------------
// 4. Perps: calculatePriceFromHoldings ceiling is now 4× not 10×
// ---------------------------------------------------------------------------
describe('Perp AMM — PRICE_CEILING_RATIO', () => {
  test('PRICE_CEILING_RATIO is 4.0', () => {
    expect(PERP_MARKET_CONFIG.PRICE_CEILING_RATIO).toBe(4.0);
  });

  test('calculatePriceFromHoldings can never exceed 4× initialPrice', () => {
    // With currentPrice at 380 (near ceiling), per-trade clamp allows +30% → 494,
    // but the absolute ceiling of 4×100=400 takes precedence.
    const initialPrice = 100;
    const currentPrice = 380;
    const result = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      1_000_000
    );
    expect(result).toBeLessThanOrEqual(initialPrice * 4.0 + 0.001);
    expect(result).toBeCloseTo(initialPrice * 4.0, 0); // hits exactly 400
  });

  test('calculatePriceFromHoldings respects PRICE_FLOOR_RATIO of 5% on extreme shorts', () => {
    const initialPrice = 100;
    const currentPrice = 100;
    const result = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      -1_000_000
    );
    expect(result).toBeGreaterThanOrEqual(
      initialPrice * PERP_MARKET_CONFIG.PRICE_FLOOR_RATIO - 0.001
    );
  });

  test('calculatePriceFromHoldings clamps per-trade to ±30% of currentPrice', () => {
    const initialPrice = 100;
    const currentPrice = 200;
    const result = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      500_000
    );
    const maxAllowed = Math.min(
      currentPrice * (1 + PERP_MARKET_CONFIG.MAX_CHANGE_PER_TRADE),
      initialPrice * PERP_MARKET_CONFIG.PRICE_CEILING_RATIO
    );
    expect(result).toBeLessThanOrEqual(maxAllowed + 0.001);
  });
});

// ---------------------------------------------------------------------------
// 5. Perp AMM config constants
// ---------------------------------------------------------------------------
describe('Perp AMM — config constants', () => {
  test('MAX_CHANGE_PER_TRADE is 30% (unchanged)', () => {
    expect(PERP_MARKET_CONFIG.MAX_CHANGE_PER_TRADE).toBe(0.3);
  });

  test('PRICE_FLOOR_RATIO is 5% (unchanged)', () => {
    expect(PERP_MARKET_CONFIG.PRICE_FLOOR_RATIO).toBe(0.05);
  });

  test('INITIAL_BASE_RESERVE is unchanged', () => {
    expect(PERP_MARKET_CONFIG.INITIAL_BASE_RESERVE).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 6. Prediction: sells apply the same odds guards as buys
//    (revival of #1875 — the sell path had neither the 20ppt cap nor the
//    2%/98% hard bounds, so one sell could swing odds farther than any buy)
// ---------------------------------------------------------------------------
describe('PredictionMarketService — sell odds guards', () => {
  test('small sell (< 20ppt move) succeeds', async () => {
    const service = makeService({}, makePosition('yes', 5000));
    // Selling 3000 YES shares on a 5000/5000 pool moves odds -14.37ppt
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 3000,
      })
    ).resolves.toBeDefined();
  });

  test('large sell that moves odds > 20ppt is rejected by default', async () => {
    const service = makeService({}, makePosition('yes', 5000));
    // Selling 4500 YES shares on a 5000/5000 pool moves odds -20.52ppt
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 4500,
      })
    ).rejects.toThrow(/move odds by/i);
  });

  test('caller can relax the cap with maxOddsMove: 0.30', async () => {
    const service = makeService({}, makePosition('yes', 5000));
    // Same 4500-share sell is allowed when the caller allows up to 30ppt
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 4500,
        maxOddsMove: 0.3,
      })
    ).resolves.toBeDefined();
  });

  test('sell pushing YES above 98% is rejected', async () => {
    // Skewed: 250/9750 → YES at 97.5%. Selling 2000 NO shares → 98.25%
    // oddsShift is only ~0.75ppt, so only the ceiling guard catches it
    const service = makeService(
      {
        yesShares: 250,
        noShares: 9750,
        liquidity: 10_000,
      },
      makePosition('no', 2000)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 2000,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });

  test('sell pushing YES below 2% is rejected', async () => {
    // Skewed: 9750/250 → YES at 2.5%. Selling 2000 YES shares → 1.75%
    // oddsShift is only ~0.75ppt, so only the floor guard catches it
    const service = makeService(
      {
        yesShares: 9750,
        noShares: 250,
        liquidity: 10_000,
      },
      makePosition('yes', 2000)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 2000,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });

  test('relaxed cap still respects the hard ceiling', async () => {
    // Same 2000-NO sell with maxOddsMove 1.0: the cap is relaxed but the
    // 98% ceiling still rejects it
    const service = makeService(
      {
        yesShares: 250,
        noShares: 9750,
        liquidity: 10_000,
      },
      makePosition('no', 2000)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 2000,
        maxOddsMove: 1.0,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });

  test('sell unwinding an extreme market toward the center succeeds', async () => {
    // Pool 100/9900 → YES at 99.0%. Selling 500 YES moves odds to 98.89%
    // (toward 50%), so the ceiling must not block it — the holders of a
    // market that entered the band before this guard existed need an exit.
    const service = makeService(
      {
        yesShares: 100,
        noShares: 9900,
        liquidity: 10_000,
      },
      makePosition('yes', 500)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 500,
      })
    ).resolves.toBeDefined();
  });

  test('sell pushing an extreme market further out is still rejected', async () => {
    // Same 100/9900 pool. Selling 50 NO moves YES to 99.01% (away from
    // 50%), so the ceiling still rejects it.
    const service = makeService(
      {
        yesShares: 100,
        noShares: 9900,
        liquidity: 10_000,
      },
      makePosition('no', 50)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 50,
      })
    ).rejects.toThrow(/thin|extreme|floor|ceiling|push YES odds/i);
  });

  test('full-position exit above the 20ppt cap succeeds', async () => {
    // Pool 2000/6000 → YES at 75%. Selling the whole 5000-share position
    // moves odds -32.14ppt; the same shares sold in two legs reach the
    // identical end state, so a one-request full exit must not fail.
    const service = makeService(
      {
        yesShares: 2000,
        noShares: 6000,
        liquidity: 10_000,
      },
      makePosition('yes', 5000)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 5000,
      })
    ).resolves.toBeDefined();
  });

  test('partial sell above the 20ppt cap is still rejected', async () => {
    // Same 5000-share sell, but the holder owns 6000 shares — it is a
    // partial sell, so the cap still applies.
    const service = makeService(
      {
        yesShares: 2000,
        noShares: 6000,
        liquidity: 10_000,
      },
      makePosition('yes', 6000)
    );
    await expect(
      service.sell({
        userId: 'u1',
        marketId: 'market-1',
        shares: 5000,
      })
    ).rejects.toThrow(/move odds by/i);
  });
});
