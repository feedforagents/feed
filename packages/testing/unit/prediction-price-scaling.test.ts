import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction';

describe('Prediction market price scaling', () => {
  it('CPMM avgPrice stays below 1.0: a share redeems for at most 1 pt [D-14]', () => {
    // Market with 5000/5000 liquidity (10k initial)
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // avgPrice = usdAmount / sharesBought. Under [D-14] the CPMM price is
    // the cost per share, so even a large buy averages between the 0.50
    // quote and the post-trade quote — never above 1.0.
    expect(result.avgPrice).toBeGreaterThan(0.5);
    expect(result.avgPrice).toBeLessThan(1.0);
    expect(result.avgPrice).toBeLessThan(result.newYesPrice);
    // At ~0.58 per share, $2000 buys more shares than points spent
    expect(result.sharesBought).toBeGreaterThan(2000);
  });

  it('avgPrice should NOT be multiplied by 100 for storage', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // The raw avgPrice is the correct value for entryPrice storage
    // Multiplying by 100 would create values like 55 for a $0.55 cost-per-share
    const correctEntryPrice = result.avgPrice;
    const wrongEntryPrice = result.avgPrice * 100;

    // Correct entry price should be in a reasonable range (0.x to ~2.x)
    expect(correctEntryPrice).toBeLessThan(5);
    expect(correctEntryPrice).toBeGreaterThan(0);

    // Wrong entry price would be 100x too large
    expect(wrongEntryPrice).toBeGreaterThan(50);
  });

  it('market prices (yesPrice/noPrice) ARE 0-1 probabilities', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // newYesPrice and newNoPrice should sum to ~1.0
    expect(result.newYesPrice + result.newNoPrice).toBeCloseTo(1.0, 5);
    expect(result.newYesPrice).toBeGreaterThan(0);
    expect(result.newYesPrice).toBeLessThan(1);
    expect(result.newNoPrice).toBeGreaterThan(0);
    expect(result.newNoPrice).toBeLessThan(1);
  });

  it('small trades have avgPrice close to the quoted price', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 10);

    // avgPrice is the cost per share, and [D-14] makes the CPMM price that
    // cost: on a balanced market the quote is 0.50, so avgPrice ≈ 0.50
    expect(result.avgPrice).toBeCloseTo(0.5, 2);
  });

  it('large trades average between the pre- and post-trade quotes', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 4000);

    // A large trade moves along the curve: its average cost per share is
    // above the initial 0.50 quote but below the post-trade quote.
    expect(result.avgPrice).toBeGreaterThan(0.5);
    expect(result.avgPrice).toBeLessThan(result.newYesPrice);
  });

  it('calculateExpectedPayout redeems shares without pool context', () => {
    const shares = 100;
    const avgPrice = 0.6;

    const payout = PredictionPricing.calculateExpectedPayout(shares, avgPrice);
    expect(payout).toBe(shares);
  });

  it('calculateExpectedPayout is independent of loser deposits', () => {
    const shares = 100;
    const avgPrice = 0.6;
    const totalWinnerShares = 100;
    const totalLoserDeposits = 100;

    const payout = PredictionPricing.calculateExpectedPayout(
      shares,
      avgPrice,
      totalWinnerShares,
      totalLoserDeposits
    );
    expect(payout).toBe(shares);
  });
});

describe('Price storage conventions', () => {
  it('entryPrice should store raw avgPrice without * 100', () => {
    // Simulate what trade-execution-service does
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // CORRECT: store raw avgPrice (~0.58 for this trade)
    const correctEntryPrice = result.avgPrice;
    expect(correctEntryPrice).toBeGreaterThan(0);
    expect(correctEntryPrice).toBeLessThan(5);

    // WRONG (the old bug): store avgPrice * 100
    const wrongEntryPrice = result.avgPrice * 100;
    expect(wrongEntryPrice).toBeGreaterThan(50);
  });

  it('currentPrice should store raw market probability without * 100', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 2000);

    // Market prices ARE 0-1 probabilities
    const correctCurrentPrice = result.newYesPrice;
    expect(correctCurrentPrice).toBeGreaterThan(0);
    expect(correctCurrentPrice).toBeLessThan(1);

    // WRONG: * 100 would make it 50-99
    const wrongCurrentPrice = result.newYesPrice * 100;
    expect(wrongCurrentPrice).toBeGreaterThan(50);
  });

  it('sell avgPrice follows the same convention as buy', () => {
    // Set up: buy first to move the market
    const buyResult = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    // Then sell some shares
    const sellResult = PredictionPricing.calculateSell(
      buyResult.newYesShares,
      buyResult.newNoShares,
      'yes',
      500
    );

    // Sell avgPrice is proceeds/shares, same scale as buy avgPrice
    expect(sellResult.avgPrice).toBeGreaterThan(0);
    expect(sellResult.avgPrice).toBeLessThan(5);
  });

  it('entryPrice and currentPrice should be comparable in scale', () => {
    const result = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);

    const entryPrice = result.avgPrice; // cost per share (~0.55 here)
    const currentPrice = result.newYesPrice; // probability (0-1)

    // These are in different units but both < 5. The old bug made
    // entryPrice 100x larger, creating massive fake PnL
    expect(entryPrice).toBeLessThan(5);
    expect(currentPrice).toBeLessThan(1);

    // The ratio should be reasonable (not 100x different)
    expect(entryPrice / currentPrice).toBeLessThan(10);
  });
});
