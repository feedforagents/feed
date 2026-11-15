/**
 * The upcoming-events widget merges questions and world events into one list,
 * then "sorts by date/time" by re-parsing its own display strings — which carry
 * only month and day (`Dec 31`, `12:00 PM`). A missing year parses as 2001, so
 * across the New Year boundary every January event sorts before every December
 * one, and the slice to MAX_UPCOMING_EVENTS then shows the later event while
 * dropping the earlier one. Uses the real route and PostgreSQL with the clock
 * frozen inside one such boundary window. Only the server-only environment
 * marker is stubbed.
 *
 * Requirement: PRD §6.1 logged-out browse surface; MVP Phase 5 (website
 * experience). The route's own contract is "Sort by date/time and take top N".
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, questions } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/upcoming-events/route';

// Frozen inside the seven-day widget window that straddles New Year.
const frozenNow = new Date('2026-12-28T12:00:00.000Z');
const resolutionTimes = [
  '2026-12-29T12:00:00.000Z',
  '2026-12-30T12:00:00.000Z',
  '2026-12-31T12:00:00.000Z',
  '2027-01-02T12:00:00.000Z',
];
const expectedDates = ['Dec 29', 'Dec 30', 'Dec 31'];

const questionIds: string[] = [];

interface UpcomingEventsResponse {
  success: boolean;
  events?: Array<{ id: string; date: string; time?: string }>;
}

beforeAll(async () => {
  setSystemTime(frozenNow);

  const ids = await Promise.all(
    resolutionTimes.map(() => generateSnowflakeId())
  );
  const suffix = Number(ids[0]!.slice(-6));
  await db.insert(questions).values(
    ids.map((id, index) => ({
      id,
      questionNumber: 1_900_000_000 + suffix * 10 + index,
      text: `Cross-year ordering fixture ${index}`,
      scenarioId: 999_999,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(resolutionTimes[index]!),
      status: 'active',
      updatedAt: frozenNow,
    }))
  );
  questionIds.push(...ids);
});

afterAll(async () => {
  setSystemTime();
  if (questionIds.length) {
    await db.delete(questions).where(inArray(questions.id, questionIds));
  }
});

async function requestEvents(): Promise<{
  status: number;
  events: Array<{ id: string; date: string; time?: string }>;
}> {
  const response = await GET(
    new NextRequest('http://localhost/api/feed/widgets/upcoming-events')
  );
  const body = (await response.json()) as UpcomingEventsResponse;
  return { status: response.status, events: body.events ?? [] };
}

describe('Upcoming events widget orders by real date across the year boundary', () => {
  it('returns the three soonest events, December first', async () => {
    const { status, events } = await requestEvents();
    expect(status).toBe(200);
    // Only fixture questions fall inside the frozen window, and the widget
    // caps the merged list at MAX_UPCOMING_EVENTS (3).
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(questionIds).toContain(event.id);
    }
    // Base behavior parses "Jan 2 12:00 PM" as 2001-01-02 and "Dec 29 ..." as
    // 2001-12-29, so the January fixture sorts first and the Dec 31 fixture —
    // the third soonest — is evicted from the top three.
    expect(events.map((event) => event.date)).toEqual(expectedDates);
    expect(events.some((event) => event.id === questionIds[3])).toBe(false);
  });
});
