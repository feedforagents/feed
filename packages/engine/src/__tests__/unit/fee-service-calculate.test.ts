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

  it('charges the canonical fee: settled amount first, fee rounded up', () => {
    // PRD §9.1: the fee is computed on the cent-settled (floored) amount
    // and rounded UP to whole cents, so any positive settled amount pays
    // at least one cent. Per-leg settlement dust can lower total split fees;
    // the required invariant compares the points credited to the trader.
    expect(FeeService.calculateFee(4).feeAmount).toBe(0.01);
    expect(FeeService.calculateFee(14).feeAmount).toBe(0.02);
    expect(FeeService.calculateFee(15).feeAmount).toBe(0.02);
    // Unrounded trade amounts (a sell's gross proceeds) settle first:
    // 14.9823 settles to 14.98, whose fee ceilings to 0.02, and the net
    // is the settled amount minus the fee — not the raw amount minus it.
    const sell = FeeService.calculateFee(14.9823);
    expect(sell.feeAmount).toBe(0.02);
    expect(sell.netAmount).toBe(14.96);
    // Sub-cent dust settles to zero and pays no fee.
    const dust = FeeService.calculateFee(0.005);
    expect(dust.feeAmount).toBe(0);
    expect(dust.netAmount).toBe(0);
  });

  it('rejects negative and non-finite trade amounts', () => {
    expect(() => FeeService.calculateFee(-1)).toThrow();
    expect(() => FeeService.calculateFee(Number.NaN)).toThrow();
    expect(() => FeeService.calculateFee(Number.POSITIVE_INFINITY)).toThrow();
  });
});
