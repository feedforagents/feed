/**
 * Prediction Market Execution Price Tests — PRD §9.2 [D-14]
 *
 * [D-14]: "a winning share redeems for exactly 1 pt; CPMM price = cost per
 * share." The displayed CPMM price (getCurrentPrice) must be the cost of
 * one share: trades execute along the CPMM curve whose marginal price is
 * the quote, not at the raw odds ratio (noShares / yesShares).
 *
 * These tests pin the cash-in (complete-set mint/redeem) execution model:
 * - a marginal buy/sell executes at the quoted price;
 * - a larger buy executes at an average price between the pre-trade and
 *   post-trade quotes (it moves along the curve, never outside it);
 * - pool state and the price path are the plain CPMM invariant's;
 * - a buy followed by a sell of the same shares is exactly reversible.
 */
import { describe, expect, test } from 'bun:test';

import { PredictionPricing } from '../../core/markets/prediction/pricing';

describe('execution price equals the quoted CPMM price [D-14]', () => {
  test('buy quoted at 0.50 executes at 0.50 per share (marginal)', () => {
    const quote = PredictionPricing.getCurrentPrice(5000, 5000, 'yes');
    expect(quote).toBe(0.5);
    const buy = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1);
    expect(buy.avgPrice).toBeCloseTo(quote, 2);
    // shares received = points spent / quoted price
    expect(buy.sharesBought).toBeCloseTo(1 / quote, 1);
  });

  test('buy quoted at 0.80 executes at 0.80 per share (marginal)', () => {
    const quote = PredictionPricing.getCurrentPrice(2000, 8000, 'yes');
    expect(quote).toBe(0.8);
    const buy = PredictionPricing.calculateBuy(2000, 8000, 'yes', 1);
    expect(buy.avgPrice).toBeCloseTo(quote, 2);
    expect(buy.sharesBought).toBeCloseTo(1 / quote, 1);
  });

  test('NO side: buy quoted at 0.20 executes at 0.20 per share', () => {
    const quote = PredictionPricing.getCurrentPrice(2000, 8000, 'no');
    expect(quote).toBe(0.2);
    const buy = PredictionPricing.calculateBuy(2000, 8000, 'no', 1);
    expect(buy.avgPrice).toBeCloseTo(quote, 2);
    expect(buy.sharesBought).toBeCloseTo(1 / quote, 1);
  });

  test('sell quoted at 0.80 pays 0.80 per share (marginal)', () => {
    const quote = PredictionPricing.getCurrentPrice(2000, 8000, 'yes');
    const sell = PredictionPricing.calculateSell(2000, 8000, 'yes', 0.25);
    expect(sell.totalCost / 0.25).toBeCloseTo(quote, 2);
    expect(sell.avgPrice).toBeCloseTo(quote, 2);
  });

  test('larger buy averages between the pre- and post-trade quotes', () => {
    // 100 pts into a 5000/5000 pool moves the quote 0.50 -> ~0.51; the
    // execution price must sit on the curve between them (~0.505), not at
    // the odds ratio (~1.02 under the old swap model).
    const before = PredictionPricing.getCurrentPrice(5000, 5000, 'yes');
    const buy = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    expect(buy.avgPrice).toBeGreaterThan(before);
    expect(buy.avgPrice).toBeLessThan(buy.newYesPrice);
    expect(buy.avgPrice).toBeCloseTo(0.505, 2);
    // Shares are priced off the quote curve: more than the post-trade
    // price implies, fewer than the pre-trade price implies.
    expect(buy.sharesBought).toBeGreaterThan(100 / buy.newYesPrice);
    expect(buy.sharesBought).toBeLessThan(100 / before);
  });

  test('complete-set identity: shares = minted sets + invariant swap', () => {
    // Buying YES with A pts mints A complete sets (the buyer keeps the A
    // YES) and swaps the A minted NO along the invariant for the rest.
    const Y = 2000;
    const N = 8000;
    const A = 100;
    const k = Y * N;
    const swapComponent = Y - k / (N + A);
    const buy = PredictionPricing.calculateBuy(Y, N, 'yes', A);
    expect(buy.sharesBought).toBeCloseTo(A + swapComponent, 8);
    // Pool state is the plain CPMM state after the swap.
    expect(buy.newNoShares).toBe(N + A);
    expect(buy.newYesShares).toBeCloseTo(k / (N + A), 8);
    expect(buy.newYesShares * buy.newNoShares).toBeCloseTo(k, 0);
  });

  test('sell preserves the invariant and is the exact inverse of buy', () => {
    const buy = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    const sell = PredictionPricing.calculateSell(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought
    );
    expect(sell.totalCost).toBeCloseTo(100, 6);
    expect(sell.newYesShares).toBeCloseTo(5000, 4);
    expect(sell.newNoShares).toBeCloseTo(5000, 4);
    expect(sell.newYesShares * sell.newNoShares).toBeCloseTo(25_000_000, 0);
  });

  test('sell on the NO side mirrors the YES side', () => {
    const buy = PredictionPricing.calculateBuy(2000, 8000, 'no', 100);
    const sell = PredictionPricing.calculateSell(
      buy.newYesShares,
      buy.newNoShares,
      'no',
      buy.sharesBought
    );
    expect(sell.totalCost).toBeCloseTo(100, 6);
    expect(sell.newYesShares).toBeCloseTo(2000, 4);
    expect(sell.newNoShares).toBeCloseTo(8000, 4);
  });

  test('fees still apply to the net amount before execution', () => {
    const withFees = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      100,
      0.01
    );
    const netOnly = PredictionPricing.calculateBuy(5000, 5000, 'yes', 99);
    expect(withFees.sharesBought).toBeCloseTo(netOnly.sharesBought, 8);
    // The net 99 pts execute at the 0.50 quote curve, not at odds.
    expect(withFees.avgPrice).toBeCloseTo(0.505, 2);
  });
});
