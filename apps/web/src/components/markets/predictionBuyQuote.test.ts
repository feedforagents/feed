import { describe, expect, test } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction/client';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { calculatePredictionBuyQuote } from './predictionBuyQuote';

describe('calculatePredictionBuyQuote', () => {
  test('deducts the configured trading fee before the CPMM swap', () => {
    const quote = calculatePredictionBuyQuote(500, 500, 'yes', 100);

    expect(quote.fee).toBeCloseTo(100 * FEE_CONFIG.TRADING_FEE_RATE, 10);
    expect(quote.netAmount).toBeCloseTo(
      100 - 100 * FEE_CONFIG.TRADING_FEE_RATE,
      10
    );

    // Shares are the ones execution credits: the swap of the net amount.
    const netSwap = PredictionPricing.calculateBuy(
      500,
      500,
      'yes',
      quote.netAmount
    );
    expect(quote.sharesBought).toBeCloseTo(netSwap.sharesBought, 10);
    expect(quote.avgPrice).toBeCloseTo(netSwap.avgPrice, 10);
  });

  test('never quotes the fee-free share count', () => {
    const feeFree = PredictionPricing.calculateBuy(500, 500, 'yes', 100);
    const quote = calculatePredictionBuyQuote(500, 500, 'yes', 100);
    expect(quote.sharesBought).toBeLessThan(feeFree.sharesBought);
  });

  test('applies the same fee treatment to NO buys and the minimum amount', () => {
    const noQuote = calculatePredictionBuyQuote(500, 500, 'no', 10);
    expect(noQuote.fee).toBeCloseTo(10 * FEE_CONFIG.TRADING_FEE_RATE, 10);
    expect(noQuote.sharesBought).toBeGreaterThan(0);

    const minQuote = calculatePredictionBuyQuote(500, 500, 'yes', 1);
    expect(minQuote.netAmount).toBeCloseTo(1 - FEE_CONFIG.TRADING_FEE_RATE, 10);
    expect(minQuote.sharesBought).toBeGreaterThan(0);
  });
});
