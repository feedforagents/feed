import { describe, expect, it } from 'bun:test';
import { FEE_CONFIG } from '../../config/fees';
import { FeeService } from '../../services/fee-service';

describe('FeeService.calculateFee', () => {
  it('conserves the fee across the platform/referrer split', () => {
    for (const amount of [10, 15, 25, 35, 999.99, 1000, 1234.56, 50_000]) {
      const calc = FeeService.calculateFee(amount);
      expect(Math.round((calc.platformShare + calc.referrerShare) * 100)).toBe(
        Math.round(calc.feeAmount * 100)
      );
    }
  });

  it('does not allocate a cent to both sides of a one-cent fee', () => {
    const calc = FeeService.calculateFee(10);
    expect(calc.feeAmount).toBe(0.01);
    expect(calc.platformShare).toBe(0.01);
    expect(calc.referrerShare).toBe(0);
  });

  it('keeps the trading fee with the platform and pays no referrer', () => {
    const calc = FeeService.calculateFee(1000);
    expect(calc).toEqual({
      feeAmount: 1,
      netAmount: 999,
      platformShare: 1,
      referrerShare: 0,
    });
  });

  it('keeps the configured fee rate', () => {
    const calc = FeeService.calculateFee(20_000);
    expect(calc.feeAmount).toBe(20_000 * FEE_CONFIG.TRADING_FEE_RATE);
  });

  it('rejects negative and non-finite trade amounts', () => {
    expect(() => FeeService.calculateFee(-1)).toThrow();
    expect(() => FeeService.calculateFee(Number.NaN)).toThrow();
    expect(() => FeeService.calculateFee(Number.POSITIVE_INFINITY)).toThrow();
  });
});
