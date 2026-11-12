/**
 * Prediction Market Pricing Correctness Tests
 *
 * Verifies CPMM buy/sell math, k-invariant preservation, one-point share
 * redemption, and fee integration.
 */
import { describe, expect, test } from 'bun:test';
import { floorPoints } from '@feed/shared';

// Import pricing directly — no mocks needed for pure math
import {
  calculateExpectedPayout,
  PredictionPricing,
} from '../../core/markets/prediction/client';

// ─── CPMM Buy/Sell Math ─────────────────────────────────────────────────────

describe('CPMM constant product math', () => {
  const Y = 5000; // yesShares
  const N = 5000; // noShares
  const K = Y * N; // 25_000_000

  test('buy YES: k-invariant holds after trade', () => {
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    // k should be preserved (CPMM: USD added to NO side, YES removed)
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('buy NO: k-invariant holds after trade', () => {
    const result = PredictionPricing.calculateBuy(Y, N, 'no', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('sell YES: k-invariant holds after trade', () => {
    // Sell 100 YES shares back into the pool
    const result = PredictionPricing.calculateSell(Y, N, 'yes', 100);
    const kAfter = result.newYesShares * result.newNoShares;
    expect(kAfter).toBeCloseTo(K, 0);
  });

  test('buy YES in 50/50 market: exact share calculation', () => {
    // Pool: 5000/5000, buy $100 YES. Cash-in CPMM [D-14]: the $100 mints
    // 100 complete sets (buyer keeps the 100 YES) and the 100 minted NO
    // swap along the invariant for 5000 - 4901.96 ≈ 98.04 more YES.
    // newNoShares = 5000 + 100 = 5100
    // newYesShares = 25_000_000 / 5100 ≈ 4901.96
    // sharesBought = 100 + 98.04 ≈ 198.04
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    expect(result.sharesBought).toBeCloseTo(198.04, 1);
    expect(result.newNoShares).toBe(5100);
    expect(result.newYesShares).toBeCloseTo(25_000_000 / 5100, 6);
    // avgPrice = 100 / 198.04 ≈ 0.505 — the 0.50 quote plus curve slippage
    expect(result.avgPrice).toBeCloseTo(0.505, 2);
  });

  test('buy YES in skewed market (80/20): cheaper shares', () => {
    // Pool where YES is cheap (underdog): yesShares=8000, noShares=2000
    // YES price = 2000/10000 = 0.20, NO price = 0.80
    const result = PredictionPricing.calculateBuy(8000, 2000, 'yes', 100);
    // newNoShares = 2000 + 100 = 2100
    // newYesShares = 16_000_000 / 2100 ≈ 7619.05
    // sharesBought = 100 minted + (8000 - 7619.05) swapped ≈ 480.95
    expect(result.sharesBought).toBeCloseTo(480.95, 0);
    // avgPrice ≈ 100/480.95 ≈ 0.208 — the 0.20 quote plus curve slippage
    expect(result.avgPrice).toBeCloseTo(0.208, 2);
  });

  test('large buy moves price significantly', () => {
    // Buy $2500 YES in 5000/5000 pool (50% of one side)
    const result = PredictionPricing.calculateBuy(Y, N, 'yes', 2500);
    // newNoShares = 7500, newYesShares = 25_000_000/7500 ≈ 3333.33
    // YES price moves from 0.50 to 7500/10833.33 ≈ 0.692
    expect(result.newYesPrice).toBeCloseTo(0.692, 2);
    expect(result.newNoPrice).toBeCloseTo(0.308, 2);
    // sharesBought = 2500 minted + (5000 - 3333.33) swapped ≈ 4166.67
    expect(result.sharesBought).toBeCloseTo(4166.67, 0);
  });

  test('sell recovers exact buy cost (no-fee CPMM is reversible)', () => {
    // Buy then sell: without fees, CPMM is mathematically reversible
    // k is recalculated from current reserves each trade, so round-trip is exact
    const buy = PredictionPricing.calculateBuy(Y, N, 'yes', 100);
    const sell = PredictionPricing.calculateSell(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought
    );
    // Proceeds equal the $100 spent (perfect reversal without fees)
    expect(sell.totalCost).toBeCloseTo(100, 6);
  });

  test('round-trip WITH fees loses money', () => {
    // With 1% fee on both buy and sell, round-trip should cost ~2%
    const feeRate = 0.01;
    const buy = PredictionPricing.calculateBuyWithFees(
      Y,
      N,
      'yes',
      100,
      feeRate
    );
    const sell = PredictionPricing.calculateSellWithFees(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought,
      feeRate
    );
    // Net proceeds after fees should be less than $100
    expect(sell.netProceeds).toBeLessThan(100);
    // Lost ~2% to fees (1% each way)
    expect(sell.netProceeds).toBeGreaterThan(96);
  });
});

// ─── Fee Integration ─────────────────────────────────────────────────────────

describe('CPMM fee integration', () => {
  test('buyWithFees deducts fee before calculating shares', () => {
    const feeRate = 0.01; // 1%
    const result = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      100,
      feeRate
    );
    expect(result.fee).toBeCloseTo(1.0, 10); // 1% of 100
    expect(result.netAmount).toBeCloseTo(99, 10);
    // Shares should be based on $99 not $100
    const noFee = PredictionPricing.calculateBuy(5000, 5000, 'yes', 99);
    expect(result.sharesBought).toBeCloseTo(noFee.sharesBought, 6);
  });

  test('sellWithFees deducts fee from gross proceeds', () => {
    const feeRate = 0.01;
    const result = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      100,
      feeRate
    );
    const noFee = PredictionPricing.calculateSell(5000, 5000, 'yes', 100);
    // Canonical cent-rounded fee, matching FeeService.calculateFee: the
    // ledger records round(gross * rate) to the cent, so the sell charges
    // that fee rather than the raw gross * rate.
    expect(result.fee).toBeCloseTo(
      Math.round(noFee.totalCost * 0.01 * 100) / 100,
      6
    );
    expect(result.netProceeds).toBe(floorPoints(noFee.totalCost - result.fee));
    expect(result.roundingRemainder).toBeCloseTo(
      noFee.totalCost - result.fee - result.netProceeds!,
      10
    );
  });
});

// ─── Winning Share Redemption ──────────────────────────────────────────────

describe('winning share redemption (PRD D-14)', () => {
  test('the client preview and resolution helper pay one point per share', () => {
    expect(calculateExpectedPayout(10, 0.6)).toBe(10);
    expect(PredictionPricing.calculateExpectedPayout(10, 0.6)).toBe(10);
  });

  test('purchase cost and legacy pool context do not change redemption', () => {
    expect(PredictionPricing.calculateExpectedPayout(100, 1, 400, 100)).toBe(
      100
    );
    expect(PredictionPricing.calculateExpectedPayout(100, 0.5, 100, 400)).toBe(
      100
    );
    expect(PredictionPricing.calculateExpectedPayout(100, 0.8, 200, 0)).toBe(
      100
    );
  });

  test('fractional winning shares settle down to whole hundredths', () => {
    expect(calculateExpectedPayout(0.125, 0.8)).toBe(0.12);
  });

  test('zero winning shares redeem for zero', () => {
    expect(PredictionPricing.calculateExpectedPayout(0, 0.6, 100, 500)).toBe(0);
  });
});

// ─── Market Initialization ──────────────────────────────────────────────────

describe('initializeMarket', () => {
  test('default liquidity creates 50/50 market', () => {
    const market = PredictionPricing.initializeMarket();
    expect(market.yesShares).toBe(5000);
    expect(market.noShares).toBe(5000);
  });

  test('custom liquidity splits evenly', () => {
    const market = PredictionPricing.initializeMarket(20_000);
    expect(market.yesShares).toBe(10_000);
    expect(market.noShares).toBe(10_000);
  });

  test('initialized market has 50% price for both sides', () => {
    const market = PredictionPricing.initializeMarket(10_000);
    const yesPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    );
    const noPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'no'
    );
    expect(yesPrice).toBe(0.5);
    expect(noPrice).toBe(0.5);
  });

  test('supports explicit non-neutral initialization when requested', () => {
    const market = PredictionPricing.initializeMarket(10_000, 0.55);
    const yesPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'yes'
    );
    const noPrice = PredictionPricing.getCurrentPrice(
      market.yesShares,
      market.noShares,
      'no'
    );
    expect(yesPrice).toBeCloseTo(0.55, 10);
    expect(noPrice).toBeCloseTo(0.45, 10);
  });

  test('clamps extreme initialization probabilities into safe bounds', () => {
    const low = PredictionPricing.initializeMarket(10_000, 0.01);
    const high = PredictionPricing.initializeMarket(10_000, 0.99);

    expect(
      PredictionPricing.getCurrentPrice(low.yesShares, low.noShares, 'yes')
    ).toBeCloseTo(0.05, 10);
    expect(
      PredictionPricing.getCurrentPrice(high.yesShares, high.noShares, 'yes')
    ).toBeCloseTo(0.95, 10);
  });
});

// ─── getCurrentPrice ────────────────────────────────────────────────────────

describe('getCurrentPrice', () => {
  test('50/50 market: both sides at 0.5', () => {
    expect(PredictionPricing.getCurrentPrice(500, 500, 'yes')).toBe(0.5);
    expect(PredictionPricing.getCurrentPrice(500, 500, 'no')).toBe(0.5);
  });

  test('skewed 80/20: YES cheap at 0.20, NO expensive at 0.80', () => {
    // YES price = noShares / total = 2000 / 10000 = 0.20
    const yesPrice = PredictionPricing.getCurrentPrice(8000, 2000, 'yes');
    expect(yesPrice).toBe(0.2);
    const noPrice = PredictionPricing.getCurrentPrice(8000, 2000, 'no');
    expect(noPrice).toBe(0.8);
  });

  test('prices always sum to 1.0', () => {
    for (const [y, n] of [
      [100, 900],
      [500, 500],
      [1, 99999],
      [7777, 3333],
    ] as const) {
      const yes = PredictionPricing.getCurrentPrice(y, n, 'yes');
      const no = PredictionPricing.getCurrentPrice(y, n, 'no');
      expect(yes + no).toBeCloseTo(1.0, 10);
    }
  });

  test('zero total returns 0.5 (default)', () => {
    expect(PredictionPricing.getCurrentPrice(0, 0, 'yes')).toBe(0.5);
    expect(PredictionPricing.getCurrentPrice(0, 0, 'no')).toBe(0.5);
  });

  test('price after buy reflects CPMM state', () => {
    // Buy YES in 50/50 market, then check getCurrentPrice matches
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    const yesPrice = PredictionPricing.getCurrentPrice(
      result.newYesShares,
      result.newNoShares,
      'yes'
    );
    // Should match the newYesPrice from calculateBuy
    expect(yesPrice).toBeCloseTo(result.newYesPrice, 10);
  });
});
