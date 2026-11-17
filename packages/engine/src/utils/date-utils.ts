/**
 * Date Utilities
 * Shared date parsing and extraction utilities for the game engine.
 */

import { logger } from '@feed/shared';

/**
 * Extract the calendar day-of-month from an ISO-like timestamp string
 * ("YYYY-MM-DDTHH:MM:SSZ"). Returns 0 when no valid calendar date is present
 * (including impossible dates such as 2025-02-30).
 */
export function extractDayFromTimestamp(timestamp: string): number {
  const match = timestamp.match(/(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return 0;

  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isValidCalendarDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return isValidCalendarDate ? day : 0;
}

/**
 * Extract day number from an event object (handles different formats)
 */
export function extractDayFromEvent(event: {
  day?: number;
  timestamp?: Date | string;
}): number {
  if (event.day) return event.day;
  if (event.timestamp) {
    return extractDayFromTimestamp(
      typeof event.timestamp === 'string'
        ? event.timestamp
        : event.timestamp.toISOString()
    );
  }
  return 0;
}

/**
 * Extract day number from a post object
 */
export function extractDayFromPost(post: {
  day?: number;
  createdAt?: Date | string;
}): number {
  if (post.day) return post.day;
  if (post.createdAt) {
    return extractDayFromTimestamp(
      typeof post.createdAt === 'string'
        ? post.createdAt
        : post.createdAt.toISOString()
    );
  }
  return 0;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Compute a game-relative day number (1-indexed) from a game start time.
 * Day 1 = first 24 hours from startedAt
 * Day 2 = hours 24-48, etc.
 *
 * @param startedAt - The continuous game's start timestamp
 * @param timestamp - The content/event timestamp
 * @returns 1-indexed day number since startedAt (Day 1 is first day)
 */
export function getGameDayNumber(startedAt: Date, timestamp: Date): number {
  const daysElapsed = Math.floor(
    (timestamp.getTime() - startedAt.getTime()) / MS_PER_DAY
  );
  // Clamp to minimum of 1 to handle timestamps before startedAt
  const result = Math.max(daysElapsed + 1, 1); // 1-indexed: Day 1 is first day

  // Log diagnostic warning when timestamp is before startedAt (clock drift or test data issue)
  if (timestamp.getTime() < startedAt.getTime()) {
    logger.warn(
      'getGameDayNumber: timestamp is before startedAt, clamping to day 1',
      {
        startedAt: startedAt.toISOString(),
        timestamp: timestamp.toISOString(),
        daysElapsed,
        result,
      },
      'DateUtils'
    );
  }

  return result;
}

/**
 * Hour within the current game day, 0-23.
 *
 * Uses the same epoch as `getGameDayNumber`: hour 0 is `startedAt`, and each
 * later game day starts 24 hours after that, not at local midnight. A
 * timestamp before `startedAt` is hour 0 of the clamped day 1.
 */
export function getGameHourOfDay(startedAt: Date, timestamp: Date): number {
  const elapsed = timestamp.getTime() - startedAt.getTime();
  if (!Number.isFinite(elapsed)) {
    throw new RangeError(
      'getGameHourOfDay: startedAt and timestamp must be valid dates'
    );
  }
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / MS_PER_HOUR) % 24;
}

/**
 * Validate a dayNumber for storage in Post/WorldEvent int columns.
 * Days are 1-indexed (Day 1 is the first day of the game).
 * Returns undefined for invalid day numbers (non-integers included) to
 * prevent DB errors.
 */
export function toSafeDayNumber(dayNumber: number): number | undefined {
  return Number.isInteger(dayNumber) &&
    dayNumber >= 1 &&
    dayNumber <= 2147483647
    ? dayNumber
    : undefined;
}

/**
 * Extract the date portion (YYYY-MM-DD) from a Date object.
 * Avoids the duplicate pattern: `.toISOString().split('T')[0]`
 *
 * @param date - Date object or ISO string
 * @returns Date string in YYYY-MM-DD format
 *
 * @example
 * ```typescript
 * const today = toDateString(new Date()); // "2025-01-25"
 * ```
 */
export function toDateString(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().split('T')[0] ?? '';
}

/**
 * Get today's date as YYYY-MM-DD string.
 * Convenience wrapper for common pattern.
 *
 * @returns Today's date in YYYY-MM-DD format
 */
export function getTodayDateString(): string {
  return toDateString(new Date());
}
