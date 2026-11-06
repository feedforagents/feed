import { describe, expect, it } from 'bun:test';
import { floorPoints, isPointsAmount } from '@feed/shared';

describe('approved hundredth-point settlement', () => {
  it('accepts representable cash inputs and rejects finer amounts', () => {
    for (const amount of [0, 0.01, 0.29, 1, 1.23, 10000.99])
      expect(isPointsAmount(amount)).toBe(true);
    for (const amount of [
      1.0049,
      0.001,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
      expect(isPointsAmount(amount)).toBe(false);
  });

  it('rounds proceeds down without losing an already representable cent', () => {
    expect(floorPoints(0.29)).toBe(0.29);
    expect(floorPoints(9.98001)).toBe(9.98);
    expect(floorPoints(0.00999)).toBe(0);
    expect(floorPoints(12.345678)).toBe(12.34);
    expect(floorPoints(1e-8)).toBe(0);
    expect(floorPoints(1000000000.99)).toBe(1000000000.99);
  });

  it('never makes split credits larger than their combined credit', () => {
    const pieces = [0.00765, 0.02557, 0.02557, 0.02557, 0.94556];
    expect(
      pieces.reduce((sum, piece) => sum + floorPoints(piece), 0)
    ).toBeLessThanOrEqual(
      floorPoints(pieces.reduce((sum, piece) => sum + piece, 0))
    );
    expect(() => floorPoints(-0.01)).toThrow(RangeError);
    expect(() => floorPoints(Number.NaN)).toThrow(RangeError);
  });
});
