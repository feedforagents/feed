import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '../pricing';

/**
 * Repro: the prediction fee actually charged to the trader must equal the
 * fee the fee ledger records and splits — and charging it must never make
 * a split trade settle better than the same trade executed whole.
 *
 * Production wiring (web buy/sell routes, MCP, A2A, agent actions) passes
 * the trade amount to FeeService.processTradingFee, whose calculateFee
 * derives ONE canonical fee (PRD §9.1): the fee on the cent-settled
 * amount (the trade amount floored to cents), rounded UP to whole cents,
 * in decimal arithmetic (`canonicalTradingFee` in @feed/shared).
 * PerpMarketService.calculateFee charges that same canonical fee (#1611).
 * The prediction pricing helpers must charge it too, or the charged fee
 * disagrees with the fee ledger, the platform/referrer split and
 * users.totalFeesPaid.
 *
 * The ceiling (not round-to-nearest) is load-bearing: with a rounded fee,
 * small split legs round down to a zero fee, so splitting a sell credited
 * MORE than the whole sale (4,269 cases in a brute-force sweep) and
 * splitting a buy received more shares (45,672 cases). Settling each leg
 * to cents and ceiling each leg's fee makes the split totals provably no
 * better than the whole trade.
 */
const RATE = 0.001; // FEE_CONFIG.TRADING_FEE_RATE

/**
 * Mirror of FeeService.calculateFee + the below-minimum skip in
 * processTradingFee (which records nothing when the canonical fee is 0 —
 * under the ceiling rule that only happens for a zero settled amount).
 */
function ledgerFee(tradeAmount: number): number {
  const settledCents = Math.floor(tradeAmount * 100 + 1e-9);
  const feeCents = Math.ceil(settledCents * RATE - 1e-9);
  const feeAmount = feeCents / 100;
  return feeAmount < 0.01 ? 0 : feeAmount;
}

describe('prediction fee charged vs fee ledger (canonical settled fee)', () => {
  it('buy: charged fee equals the ledger fee on a 15 pt buy', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      15,
      RATE
    );
    // Base (unrounded): charged 0.015, ledger recorded 0.02.
    expect(calc.fee).toBe(ledgerFee(15));
    expect(calc.fee).toBe(0.02);
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
    // Base (unrounded): charged 0.025, ledger recorded 0.03.
    expect(calc.fee).toBe(ledgerFee(25));
    expect(calc.fee).toBe(0.03);
  });

  it('buy: a 4 pt buy pays a one-cent fee and the ledger records it', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      4,
      RATE
    );
    // Under the old nearest-cent fee this buy was charged 0.004 in
    // reduced shares while the ledger rounded to 0 and
    // processTradingFee skipped, so the fee was collected but never
    // recorded or distributed. Under the ceiling rule the settled 4 pt
    // pays exactly one cent — an effective 0.25% on this size — and the
    // ledger records that same cent.
    expect(calc.fee).toBe(ledgerFee(4));
    expect(calc.fee).toBe(0.01);
    expect(calc.netAmount).toBe(3.99);
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
    // The gross settles to cents first; the fee is charged on the
    // settled amount and the seller is credited settled − fee.
    expect(calc.fee).toBe(ledgerFee(calc.totalCost));
    const settled = Math.floor(calc.totalCost * 100 + 1e-9) / 100;
    expect(calc.netProceeds).toBe(Number((settled - calc.fee).toFixed(2)));
  });

  it('sell: splitting never credits more than the whole sale', () => {
    // The review repro: selling 11 YES shares from a 5000/5000 pool in
    // 3 legs credited 5.49 under the rounded fee vs 5.48 whole.
    for (const [yes, no] of [
      [5000, 5000],
      [3000, 7000],
    ] as const) {
      for (const total of [5, 11, 13, 25, 30, 60, 100]) {
        const whole = PredictionPricing.calculateSellWithFees(
          yes,
          no,
          'yes',
          total,
          RATE
        ).netProceeds!;
        for (const legs of [2, 3, 5, 10]) {
          let y: number = yes;
          let n: number = no;
          let credited = 0;
          const per = total / legs;
          for (let i = 0; i < legs; i++) {
            const leg = PredictionPricing.calculateSellWithFees(
              y,
              n,
              'yes',
              per,
              RATE
            );
            credited += leg.netProceeds!;
            y = leg.newYesShares;
            n = leg.newNoShares;
          }
          expect(Math.round(credited * 100) / 100).toBeLessThanOrEqual(whole);
        }
      }
    }
  });

  it('sell: lower split fees do not imply extra trader credit', () => {
    // Settlement dust makes fee totals non-monotonic. The supported
    // invariant compares actual net credits, not fees in isolation.
    const firstShares = 20.03204008016032;
    const whole = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      firstShares + 0.01,
      RATE
    );
    const first = PredictionPricing.calculateSellWithFees(
      5000,
      5000,
      'yes',
      firstShares,
      RATE
    );
    const last = PredictionPricing.calculateSellWithFees(
      first.newYesShares,
      first.newNoShares,
      'yes',
      0.01,
      RATE
    );
    expect(whole.fee).toBe(0.02);
    expect(first.fee + last.fee).toBe(0.01);
    expect(whole.netProceeds).toBe(9.99);
    expect(
      Number(((first.netProceeds ?? 0) + (last.netProceeds ?? 0)).toFixed(2))
    ).toBe(9.99);
  });

  it('buy: splitting never receives more shares than the whole buy', () => {
    // The buy-side counterpart: a 5 pt buy split into legs received
    // 9.995 shares vs 9.975 whole under the rounded fee, because each
    // leg's fee rounded down. Ceiling fees sum to at least the whole
    // trade's fee, so the split's total net spend — and shares — can
    // only fall.
    for (const [yes, no] of [
      [5000, 5000],
      [3000, 7000],
    ] as const) {
      for (const total of [4, 5, 15, 25, 100]) {
        const whole = PredictionPricing.calculateBuyWithFees(
          yes,
          no,
          'yes',
          total,
          RATE
        ).sharesBought;
        for (const legs of [2, 4, 5, 10]) {
          if (total / legs < 1) continue;
          let y: number = yes;
          let n: number = no;
          let shares = 0;
          const per = total / legs;
          for (let i = 0; i < legs; i++) {
            const leg = PredictionPricing.calculateBuyWithFees(
              y,
              n,
              'yes',
              per,
              RATE
            );
            shares += leg.sharesBought;
            y = leg.newYesShares;
            n = leg.newNoShares;
          }
          expect(shares).toBeLessThanOrEqual(whole + 1e-9);
        }
      }
    }
  });
});
