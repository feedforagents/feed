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
