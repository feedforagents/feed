/**
 * Daily Login Service - Comprehensive Unit Tests
 *
 * Exercises the exported pure helpers of daily-login-service.ts directly.
 *
 * Covers:
 * - Boundary conditions at exact timing thresholds
 * - Invalid/edge case inputs
 * - Numeric overflow and extreme values
 * - State transition correctness
 */

import { describe, expect, test } from 'bun:test';
import { DAILY_LOGIN, POINTS } from '@feed/shared';
import { getClaimStatus as serviceGetClaimStatus } from '../../api/src/services/daily-login-service';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const MINUTE = 60_000;
const SECOND = 1_000;

const MILESTONES = [
  { days: 7, bonus: POINTS.DAILY_LOGIN_MILESTONE_7D },
  { days: 14, bonus: POINTS.DAILY_LOGIN_MILESTONE_14D },
  { days: 30, bonus: POINTS.DAILY_LOGIN_MILESTONE_30D },
  { days: 60, bonus: POINTS.DAILY_LOGIN_MILESTONE_60D },
  { days: 90, bonus: POINTS.DAILY_LOGIN_MILESTONE_90D },
] as const;

/** Adapter: these tests express the last claim as epoch milliseconds. */
function getClaimStatus(lastClaimMs: number | null, now: number = Date.now()) {
  return serviceGetClaimStatus(
    lastClaimMs === null ? null : new Date(lastClaimMs),
    now
  );
}

// ─── Constants Tests ─────────────────────────────────────────────────────────

describe('Daily Login - Constants Validation', () => {
  test('timing constants are positive and correctly ordered', () => {
    expect(DAILY_LOGIN.MIN_CLAIM_INTERVAL_MS).toBe(24 * HOUR);
    expect(DAILY_LOGIN.GRACE_PERIOD_MS).toBe(36 * HOUR);
    expect(DAILY_LOGIN.GRACE_PERIOD_MS).toBeGreaterThan(
      DAILY_LOGIN.MIN_CLAIM_INTERVAL_MS
    );
    expect(DAILY_LOGIN.CYCLE_LENGTH).toBe(7);
  });

  test('reward values are all positive integers', () => {
    for (let i = 1; i <= 7; i++) {
      const key = `DAILY_LOGIN_DAY_${i}` as keyof typeof POINTS;
      expect(POINTS[key]).toBeGreaterThan(0);
      expect(Number.isInteger(POINTS[key])).toBe(true);
    }
  });

  test('rewards strictly increase each day', () => {
    for (let i = 1; i < 7; i++) {
      const curr = `DAILY_LOGIN_DAY_${i}` as keyof typeof POINTS;
      const next = `DAILY_LOGIN_DAY_${i + 1}` as keyof typeof POINTS;
      expect(POINTS[next]).toBeGreaterThan(POINTS[curr]);
    }
  });

  test('milestones are in ascending order with increasing bonuses', () => {
    for (let i = 0; i < MILESTONES.length - 1; i++) {
      const current = MILESTONES[i];
      const next = MILESTONES[i + 1];
      if (current && next) {
        expect(next.days).toBeGreaterThan(current.days);
        expect(next.bonus).toBeGreaterThan(current.bonus);
      }
    }
  });
});

// ─── getClaimStatus Tests ────────────────────────────────────────────────────

describe('Daily Login - getClaimStatus', () => {
  // Use a fixed timestamp for deterministic tests
  const NOW = 1700000000000; // Fixed "now" for all tests

  describe('first-time user (null lastClaim)', () => {
    test('can claim immediately with no reset', () => {
      const status = getClaimStatus(null, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilClaim).toBe(0);
      expect(status.timeUntilReset).toBe(0);
    });
  });

  describe('within 24h window (cannot claim)', () => {
    test('1 second ago - cannot claim', () => {
      const status = getClaimStatus(NOW - SECOND, NOW);
      expect(status.canClaim).toBe(false);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilClaim).toBe(24 * HOUR - SECOND);
    });

    test('1 hour ago - cannot claim', () => {
      const status = getClaimStatus(NOW - HOUR, NOW);
      expect(status.canClaim).toBe(false);
      expect(status.timeUntilClaim).toBe(23 * HOUR);
    });

    test('23 hours 59 minutes ago - still cannot claim', () => {
      const status = getClaimStatus(NOW - (24 * HOUR - MINUTE), NOW);
      expect(status.canClaim).toBe(false);
      expect(status.timeUntilClaim).toBe(MINUTE);
    });
  });

  describe('exact 24h boundary', () => {
    test('exactly 24h ago - can claim, streak continues', () => {
      const status = getClaimStatus(NOW - 24 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilClaim).toBe(0);
      expect(status.timeUntilReset).toBe(12 * HOUR);
    });

    test('24h + 1ms ago - can claim, streak continues', () => {
      const status = getClaimStatus(NOW - (24 * HOUR + 1), NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
    });
  });

  describe('grace period (24-36h) - can claim, streak continues', () => {
    test('25 hours ago', () => {
      const status = getClaimStatus(NOW - 25 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilReset).toBe(11 * HOUR);
    });

    test('30 hours ago', () => {
      const status = getClaimStatus(NOW - 30 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilReset).toBe(6 * HOUR);
    });

    test('35 hours 59 minutes ago - barely within grace', () => {
      const status = getClaimStatus(NOW - (36 * HOUR - MINUTE), NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(false);
      expect(status.timeUntilReset).toBe(MINUTE);
    });
  });

  describe('exact 36h boundary (grace period expires)', () => {
    test('exactly 36h ago - streak resets', () => {
      const status = getClaimStatus(NOW - 36 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
      expect(status.timeUntilReset).toBe(0);
    });

    test('36h + 1ms ago - streak resets', () => {
      const status = getClaimStatus(NOW - (36 * HOUR + 1), NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
    });
  });

  describe('long absence - streak resets', () => {
    test('48 hours ago', () => {
      const status = getClaimStatus(NOW - 48 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
    });

    test('1 week ago', () => {
      const status = getClaimStatus(NOW - 7 * 24 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
    });

    test('1 year ago', () => {
      const status = getClaimStatus(NOW - 365 * 24 * HOUR, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('future lastClaim (clock skew) - elapsed clamped to 0, cannot claim', () => {
      // With elapsed clamped to 0, this means timeUntilClaim = 24h
      const status = getClaimStatus(NOW + HOUR, NOW);
      expect(status.canClaim).toBe(false);
      expect(status.timeUntilClaim).toBe(24 * HOUR);
    });

    test('lastClaim at epoch (very old) - streak resets', () => {
      const status = getClaimStatus(0, NOW);
      expect(status.canClaim).toBe(true);
      expect(status.shouldResetStreak).toBe(true);
    });
  });
});

// ─── Streak State Transitions ────────────────────────────────────────────────

describe('Daily Login - Invariants', () => {
  test('claim status time values are non-negative', () => {
    const NOW = 1700000000000;
    const testTimes = [null, NOW, NOW - HOUR, NOW - 25 * HOUR, NOW - 48 * HOUR];
    for (const time of testTimes) {
      const status = getClaimStatus(time, NOW);
      expect(status.timeUntilClaim).toBeGreaterThanOrEqual(0);
      expect(status.timeUntilReset).toBeGreaterThanOrEqual(0);
    }
  });
});
