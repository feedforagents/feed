import { describe, expect, it } from 'bun:test';
import { usdToBalanceUnits } from '@feed/api';

describe('usdToBalanceUnits', () => {
  it('credits exactly one balance unit per Stripe cent', () => {
    // Stripe webhooks pass amount / 100; 113 / 100 * 100 === 112.99999999999999.
    expect(usdToBalanceUnits(113 / 100)).toBe(113);
    expect(usdToBalanceUnits(2007 / 100)).toBe(2007);
    for (let cents = 0; cents <= 100_000; cents++) {
      expect(usdToBalanceUnits(cents / 100)).toBe(cents);
    }
  });
});
