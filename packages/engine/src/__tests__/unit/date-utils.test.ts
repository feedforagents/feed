/**
 * Date Utilities Unit Tests
 *
 * Tests for date parsing and manipulation utilities.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  extractDayFromEvent,
  extractDayFromPost,
  extractDayFromTimestamp,
  getGameDayNumber,
  getGameHourOfDay,
  getTodayDateString,
  toDateString,
  toSafeDayNumber,
} from '../../utils/date-utils';

// Mock the logger to prevent actual logging during tests
mock.module('@feed/shared', () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

describe('Date Utilities', () => {
  describe('extractDayFromTimestamp', () => {
    test('extracts day from ISO format timestamp', () => {
      expect(extractDayFromTimestamp('2025-10-15T12:00:00Z')).toBe(15);
      expect(extractDayFromTimestamp('2025-10-01T00:00:00Z')).toBe(1);
      expect(extractDayFromTimestamp('2025-10-31T23:59:59Z')).toBe(31);
    });

    test('extracts day from generic date format', () => {
      expect(extractDayFromTimestamp('2024-05-20T10:30:00Z')).toBe(20);
    });

    test('returns 0 for invalid timestamp', () => {
      expect(extractDayFromTimestamp('invalid')).toBe(0);
      expect(extractDayFromTimestamp('')).toBe(0);
    });

    test('returns 0 for impossible calendar days', () => {
      expect(extractDayFromTimestamp('2025-02-30T00:00:00Z')).toBe(0);
      expect(extractDayFromTimestamp('2025-10-45T00:00:00Z')).toBe(0);
      expect(extractDayFromTimestamp('2025-13-01T00:00:00Z')).toBe(0);
    });

    test('accepts the last day of a leap-year February', () => {
      expect(extractDayFromTimestamp('2024-02-29T00:00:00Z')).toBe(29);
    });
  });

  describe('extractDayFromEvent', () => {
    test('returns event.day if present', () => {
      expect(extractDayFromEvent({ day: 5 })).toBe(5);
    });

    test('extracts day from timestamp string', () => {
      expect(extractDayFromEvent({ timestamp: '2025-10-15T12:00:00Z' })).toBe(
        15
      );
    });

    test('extracts day from Date object', () => {
      expect(
        extractDayFromEvent({ timestamp: new Date('2025-10-15T12:00:00Z') })
      ).toBe(15);
    });

    test('prefers day over timestamp', () => {
      expect(
        extractDayFromEvent({
          day: 7,
          timestamp: '2025-10-15T12:00:00Z',
        })
      ).toBe(7);
    });

    test('returns 0 when no date info available', () => {
      expect(extractDayFromEvent({})).toBe(0);
    });
  });

  describe('extractDayFromPost', () => {
    test('returns post.day if present', () => {
      expect(extractDayFromPost({ day: 3 })).toBe(3);
    });

    test('extracts day from createdAt string', () => {
      expect(extractDayFromPost({ createdAt: '2025-10-20T08:00:00Z' })).toBe(
        20
      );
    });

    test('extracts day from Date object', () => {
      expect(
        extractDayFromPost({ createdAt: new Date('2025-10-20T08:00:00Z') })
      ).toBe(20);
    });

    test('returns 0 when no date info available', () => {
      expect(extractDayFromPost({})).toBe(0);
    });
  });

  describe('getGameDayNumber', () => {
    const startedAt = new Date('2025-01-01T00:00:00Z');

    test('returns day 1 for same day', () => {
      const timestamp = new Date('2025-01-01T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(1);
    });

    test('returns day 2 for 24 hours later', () => {
      const timestamp = new Date('2025-01-02T00:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(2);
    });

    test('returns day 10 for 9 days later', () => {
      const timestamp = new Date('2025-01-10T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(10);
    });

    test('clamps to day 1 for timestamps before startedAt', () => {
      const timestamp = new Date('2024-12-31T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(1);
    });
  });

  describe('getGameHourOfDay', () => {
    test('counts hours from game start, including a non-midnight start', () => {
      const startedAt = new Date('2026-11-06T15:00:00.000Z');
      expect(
        getGameHourOfDay(
          startedAt,
          new Date(startedAt.getTime() + 90 * 60 * 1000)
        )
      ).toBe(1);
      expect(
        getGameHourOfDay(
          startedAt,
          new Date(startedAt.getTime() + (8 * 60 + 30) * 60 * 1000)
        )
      ).toBe(8);
    });

    test('agrees with getGameDayNumber at day boundaries', () => {
      const startedAt = new Date('2026-11-06T15:17:00.000Z');
      const justBeforeNextDay = new Date(
        startedAt.getTime() + 24 * 60 * 60 * 1000 - 1
      );
      const nextDay = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
      expect(getGameDayNumber(startedAt, justBeforeNextDay)).toBe(1);
      expect(getGameHourOfDay(startedAt, justBeforeNextDay)).toBe(23);
      expect(getGameDayNumber(startedAt, nextDay)).toBe(2);
      expect(getGameHourOfDay(startedAt, nextDay)).toBe(0);
    });

    test('clamps to hour 0 before the game starts', () => {
      const startedAt = new Date('2026-11-06T15:00:00.000Z');
      expect(
        getGameHourOfDay(startedAt, new Date(startedAt.getTime() - 60_000))
      ).toBe(0);
    });

    test('rejects invalid dates', () => {
      expect(() =>
        getGameHourOfDay(new Date('nope'), new Date('2026-11-06T15:00:00Z'))
      ).toThrow(RangeError);
    });
  });

  describe('toSafeDayNumber', () => {
    test('returns valid day numbers unchanged', () => {
      expect(toSafeDayNumber(1)).toBe(1);
      expect(toSafeDayNumber(100)).toBe(100);
      expect(toSafeDayNumber(365)).toBe(365);
    });

    test('returns undefined for zero or negative', () => {
      expect(toSafeDayNumber(0)).toBeUndefined();
      expect(toSafeDayNumber(-1)).toBeUndefined();
    });

    test('returns undefined for NaN and Infinity', () => {
      expect(toSafeDayNumber(NaN)).toBeUndefined();
      expect(toSafeDayNumber(Infinity)).toBeUndefined();
    });

    test('returns undefined for values exceeding INT max', () => {
      expect(toSafeDayNumber(2147483648)).toBeUndefined();
    });

    test('returns max INT value when at boundary', () => {
      expect(toSafeDayNumber(2147483647)).toBe(2147483647);
    });

    test('rejects fractional values (int column)', () => {
      expect(toSafeDayNumber(1.5)).toBeUndefined();
      expect(toSafeDayNumber(99.9)).toBeUndefined();
    });
  });

  describe('toDateString', () => {
    test('converts Date to YYYY-MM-DD format', () => {
      const date = new Date('2025-01-15T12:30:45.123Z');
      expect(toDateString(date)).toBe('2025-01-15');
    });

    test('converts ISO string to YYYY-MM-DD format', () => {
      expect(toDateString('2025-06-20T08:00:00Z')).toBe('2025-06-20');
    });

    test('handles end of month dates', () => {
      expect(toDateString(new Date('2025-01-31T23:59:59Z'))).toBe('2025-01-31');
    });
  });

  describe('getTodayDateString', () => {
    test('returns a valid date string format', () => {
      const result = getTodayDateString();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("returns today's date", () => {
      const today = new Date();
      const expected = today.toISOString().split('T')[0];
      expect(getTodayDateString()).toBe(expected);
    });
  });
});
