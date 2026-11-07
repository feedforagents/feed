import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '../pricing';

/**
 * Repro: the prediction fee actually charged to the trader must equal the
 * fee the fee ledger records and splits.
 *
 * Production wiring (web buy/sell routes, MCP, A2A, agent actions) passes
 * the trade amount to FeeService.processTradingFee, whose calculateFee
 * works in integer cents from ONE canonical rounded fee:
 *   feeCents = Math.round(tradeAmount * FEE_CONFIG.TRADING_FEE_RATE * 100)
 * and skips processing entirely when that fee is below MIN_FEE_AMOUNT
 * (0.01). PerpMarketService.calculateFee was aligned to that canonical fee
 * in #1611 ("charge that same cent-rounded amount: an unrounded charge
 * would disagree with the fee ledger, the platform/referrer split and
 * users.totalFeesPaid"). The prediction pricing helpers still charge the
 * unrounded amount * rate, so the two disagree on ordinary amounts.
 */
const RATE = 0.001; // FEE_CONFIG.TRADING_FEE_RATE

/** FeeService.calculateFee + the below-minimum skip in processTradingFee. */
function ledgerFee(tradeAmount: number): number {
  const feeCents = Math.round(tradeAmount * RATE * 100);
  const feeAmount = feeCents / 100;
  return feeAmount < 0.01 ? 0 : feeAmount;
}

describe('prediction fee charged vs fee ledger (canonical cent fee)', () => {
  it('buy: charged fee equals the ledger fee on a 15 pt buy', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      15,
      RATE
    );
    // Base: charged 0.015, ledger records 0.02.
    expect(calc.fee).toBe(ledgerFee(15));
    expect(calc.netAmount).toBe(15 - ledgerFee(15));
  });

  it('buy: charged fee equals the ledger fee on a 25 pt buy', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      25,
      RATE
    );
    // Base: charged 0.025, ledger records 0.03.
    expect(calc.fee).toBe(ledgerFee(25));
  });

  it('buy: a 4 pt buy is not charged a fee the ledger never records', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      4,
      RATE
    );
    // Base: charged 0.004 in reduced shares; the ledger rounds to 0 and
    // processTradingFee skips, so the fee is collected but never recorded
    // or distributed.
    expect(calc.fee).toBe(ledgerFee(4));
    expect(calc.netAmount).toBe(4);
  });

  it('buy: control — a 100 pt buy already agrees', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      100,
      RATE
    );
    expect(calc.fee).toBe(0.1);
    expect(calc.fee).toBe(ledgerFee(100));
  });

  it('sell: charged fee equals the ledger fee on the gross proceeds', () => {
    const calc = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      30,
      RATE
    );
    // The sell fee processor is called with amount = calc.totalCost
    // (gross proceeds), so the ledger fee is computed on that amount.
    // Base: gross ≈ 14.98, charged ≈ 0.0150, ledger records 0.01.
    expect(calc.fee).toBe(ledgerFee(calc.totalCost));
    expect(calc.netProceeds).toBe(
      Math.floor((calc.totalCost - calc.fee) * 100) / 100
    );
  });
});
