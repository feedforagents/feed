import Decimal from 'decimal.js-light';

/** The existing points ledger stores hundredths; share quantities are separate. */
export function isPointsAmount(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    new Decimal(value).decimalPlaces() <= 2
  );
}

/** Settle non-negative proceeds without creating points through rounding up. */
export function floorPoints(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Points must be a finite non-negative amount');
  }
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_FLOOR).toNumber();
}

/**
 * The one canonical trading fee (PRD §9.1 settlement precision).
 *
 * The fee is computed on the cent-settled amount — the trade amount floored
 * to two decimal places, exactly the amount that settles — and rounded UP
 * to whole cents, in decimal arithmetic. Execution, previews and the fee
 * ledger all charge/record this same value, so the books always agree.
 *
 * Rounding the fee up (never to nearest or down) is what makes the fee
 * partition-safe: a trade split into legs settles no more in total than
 * the same trade executed whole (each leg's settled amount floors, and
 * per-leg ceiling fees sum to at least the whole trade's fee), so
 * splitting can never increase the points a trader is credited.
 *
 * Returns 0 for non-positive amounts or rates.
 */
export function canonicalTradingFee(amount: number, feeRate: number): number {
  if (
    !Number.isFinite(amount) ||
    !Number.isFinite(feeRate) ||
    amount <= 0 ||
    feeRate <= 0
  ) {
    return 0;
  }
  const settled = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
  if (settled.isZero()) return 0;
  return settled
    .times(feeRate)
    .toDecimalPlaces(2, Decimal.ROUND_CEIL)
    .toNumber();
}
