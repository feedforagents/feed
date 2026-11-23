import { expect, it, mock, setSystemTime } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const shortCase =
  'filters questions and world events to the requested 24 hours';
const longCase = 'includes both event sources through the requested 30 days';
const defaultCase = 'keeps the seven-day default and explicit seven-day window';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  mock.module('server-only', () => ({}));
  const { db, questions, worldEvents } = await import('@feed/db');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/upcoming-events/route'
  );
  const dayMs = 24 * 60 * 60 * 1000;

  async function seedBoundary(now: Date, days: number) {
    const end = now.getTime() + days * dayMs;
    const exact = {
      time: new Date(end),
      questionId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
    };
    const rows = [
      exact,
      {
        time: new Date(end + 1),
        questionId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
      },
    ];
    await db.insert(questions).values(
      rows.map(({ time, questionId }, index) => ({
        id: questionId,
        questionNumber: 1_950_000_000 + days * 10 + index,
        text: 'A scheduled market fixture',
        scenarioId: 999_999,
        outcome: false,
        rank: 1,
        resolutionDate: time,
        status: 'active',
        updatedAt: now,
      }))
    );
    await db.insert(worldEvents).values(
      rows.map(({ time, eventId }) => ({
        id: eventId,
        eventType: 'scheduled_meeting',
        description: 'A scheduled world event fixture',
        timestamp: time,
        visibility: 'public',
      }))
    );
    return [exact.questionId, exact.eventId].sort();
  }

  async function readEventIds(now: Date, timeframe?: '24h' | '7d' | '30d') {
    const url = new URL('http://localhost/api/feed/widgets/upcoming-events');
    if (timeframe) url.searchParams.set('timeframe', timeframe);
    setSystemTime(now);
    try {
      const response = await GET(new NextRequest(url));
      expect(response.status).toBe(200);
      const { events }: { events: { id: string }[] } = await response.json();
      return events.map(({ id }) => id).sort();
    } finally {
      setSystemTime();
    }
  }

  it(shortCase, async () => {
    const now = new Date('2026-02-01T12:00:00.000Z');
    const expectedIds = await seedBoundary(now, 1);
    expect(await readEventIds(now, '24h')).toEqual(expectedIds);
  });

  it(longCase, async () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const expectedIds = await seedBoundary(now, 30);
    expect(await readEventIds(now, '30d')).toEqual(expectedIds);
  });

  it(defaultCase, async () => {
    const now = new Date('2026-10-01T12:00:00.000Z');
    const expectedIds = await seedBoundary(now, 7);
    expect(await readEventIds(now)).toEqual(expectedIds);
    expect(await readEventIds(now, '7d')).toEqual(expectedIds);
  });
} else {
  it('runs the upcoming-events timeframe cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'upcoming-events-timeframe',
      file: 'packages/testing/integration/upcoming-events-timeframe.integration.test.ts',
      cases: [shortCase, longCase, defaultCase],
    });
  }, 300_000);
}
