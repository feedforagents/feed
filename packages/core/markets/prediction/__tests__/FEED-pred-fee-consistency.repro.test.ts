/**
 * Prediction fee consistency: the fee a trader is charged must be the fee
 * the fee ledger records and splits.
 *
 * PredictionPricing.calculateBuyWithFees / calculateSellWithFees charge the
 * raw `amount * feeRate` (e.g. $0.001 on a $1 buy, $0.005 on a $5 buy),
 * while FeeService records and splits the canonical cent-rounded fee
 * (FeeService.calculateFee: integer cents, skipped below MIN_FEE_AMOUNT).
 * The perp open path was already fixed to charge that same canonical fee
 * (see packages/testing/unit/perp-open-fee-consistency.test.ts); the
 * prediction path still disagrees with the ledger on every sub-$100 trade
 * whose fee is not already a whole cent, so users.totalFeesPaid,
 * tradingFees and the stability-fund diversion under/over-record the fee
 * actually taken from the trader.
 */
import { describe, expect, it } from 'bun:test';
import { FeeService } from '@feed/engine';
import { PredictionPricing } from '../pricing';

const FEE_RATE = 0.001;
const MIN_FEE_AMOUNT = 0.01;

/** The fee FeeService.processTradingFee records for a trade amount. */
function recordedFee(amount: number): number {
  const calc = FeeService.calculateFee(amount);
  return calc.feeAmount >= MIN_FEE_AMOUNT ? calc.feeAmount : 0;
}

describe('prediction fee consistency (charged vs recorded)', () => {
  it.each([
    1, 4, 5, 14, 15, 25, 100, 1000,
  ])('charges the recorded fee on a $%s buy', (amount) => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      amount,
      FEE_RATE
    );
    expect(calc.fee).toBe(recordedFee(amount));
    expect(calc.netAmount).toBeCloseTo(amount - recordedFee(amount), 10);
  });

  it('charges the recorded fee on a sell', () => {
    const calc = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      10,
      FEE_RATE
    );
    expect(calc.fee).toBe(recordedFee(calc.totalCost));
  });

  it('charges the recorded fee on a sell at a larger size', () => {
    const calc = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'no',
      1000,
      FEE_RATE
    );
    expect(calc.fee).toBe(recordedFee(calc.totalCost));
  });
});
