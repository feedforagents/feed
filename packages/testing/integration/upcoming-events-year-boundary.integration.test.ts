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
 *
 * The frozen clock alone does not isolate the database: the route ranks a
 * global window (active questions resolving inside seven days plus public
 * world events timestamped inside it), so any pre-existing row in that window
 * legitimately occupies the top three and breaks the oracle. This suite runs
 * only against a positively verified disposable database (same allowlist as
 * widget-markets-expiry), verifies the window is empty before writing, and
 * never deletes or rewrites foreign rows to make the expectation true.
 * Ownership is published from the successful INSERT RETURNING rows only, and
 * teardown locks the acquired parents and refuses foreign cascade children
 * (QuestionArcPlan and ArcState reference Question with ON DELETE CASCADE).
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

import {
  and,
  arcStates,
  db,
  eq,
  gte,
  inArray,
  lte,
  questionArcPlans,
  questions,
  worldEvents,
} from '@feed/db';
import { FEED_WIDGET_CONFIG, generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/upcoming-events/route';

// Refuse unintended destinations before a lazy DB client runs a query.
function databaseTarget(value: string | undefined) {
  if (!value) throw new Error('Explicit disposable database required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !(
      (port === '55685' &&
        /^feed_pr\d+$/.test(name) &&
        url.username === 'symbiex') ||
      (port === '5432' && name === 'test_db' && process.env.CI === 'true')
    )
  )
    throw new Error('Disposable loopback database required');
  return `${port}/${name}/${url.username}`;
}
const primary = databaseTarget(process.env.DATABASE_URL);
if (
  process.env.DATABASE_READ_REPLICA_URL?.trim() ||
  (process.env.DIRECT_DATABASE_URL &&
    databaseTarget(process.env.DIRECT_DATABASE_URL) !== primary)
)
  throw new Error('Upcoming-events fixture requires one disposable primary');

// Frozen inside the seven-day widget window that straddles New Year.
const frozenNow = new Date('2026-12-28T12:00:00.000Z');
const resolutionTimes = [
  '2026-12-29T12:00:00.000Z',
  '2026-12-30T12:00:00.000Z',
  '2026-12-31T12:00:00.000Z',
  '2027-01-02T12:00:00.000Z',
];
const expectedDates = ['Dec 29', 'Dec 30', 'Dec 31'];

// Ownership receipts: published only from successful INSERT RETURNING rows.
const questionIds: string[] = [];

interface UpcomingEventsResponse {
  success: boolean;
  events?: Array<{ id: string; date: string; time?: string }>;
}

beforeAll(async () => {
  // Mint every fixture ID while the real clock is current: the snowflake
  // generator refuses IDs when the clock moves backwards, and afterAll
  // resets the freeze — later suites in the same process must still be able
  // to generate. Nothing inside the frozen window mints an ID.
  const ids = await Promise.all(
    resolutionTimes.map(() => generateSnowflakeId())
  );

  setSystemTime(frozenNow);

  // Mirror the route's window filters exactly. Any pre-existing row would
  // legitimately rank in the global top three, so refuse instead of deleting
  // foreign data to force the expectation.
  const windowEnd = new Date(
    frozenNow.getTime() +
      FEED_WIDGET_CONFIG.UPCOMING_EVENTS_DAYS * 24 * 60 * 60 * 1000
  );
  const [activeQuestions, publicWorldEvents] = await Promise.all([
    db
      .select({ id: questions.id })
      .from(questions)
      .where(
        and(
          eq(questions.status, 'active'),
          gte(questions.resolutionDate, frozenNow),
          lte(questions.resolutionDate, windowEnd)
        )
      )
      .limit(1),
    db
      .select({ id: worldEvents.id })
      .from(worldEvents)
      .where(
        and(
          eq(worldEvents.visibility, 'public'),
          gte(worldEvents.timestamp, frozenNow),
          lte(worldEvents.timestamp, windowEnd)
        )
      )
      .limit(1),
  ]);
  if (activeQuestions.length > 0 || publicWorldEvents.length > 0) {
    throw new Error(
      'Upcoming-events fixture requires an isolated window: active questions or public world events already exist in the frozen seven-day window (dispose or lease the database instead of deleting foreign rows)'
    );
  }

  const suffix = Number(ids[0]!.slice(-6));
  const inserted = await db
    .insert(questions)
    .values(
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
    )
    .returning({ id: questions.id });
  if (inserted.length !== ids.length) {
    throw new Error(
      `Upcoming-events fixture setup refused: inserted ${inserted.length} of ${ids.length} Question rows`
    );
  }
  questionIds.push(...inserted.map((row) => row.id));
});

async function deleteOwnedQuestions(): Promise<void> {
  if (questionIds.length === 0) return;
  const owned = [...questionIds];
  await db.transaction(async (tx) => {
    // Lock the acquired parents so a child acquired mid-run cannot slip in.
    const locked = await tx
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.id, owned))
      .for('update');
    if (locked.length !== owned.length) {
      throw new Error(
        `Upcoming-events cleanup refused: expected ${owned.length} owned Question rows, found ${locked.length}`
      );
    }
    // Deleting a parent cascades into QuestionArcPlan/ArcState rows this
    // fixture does not own; refuse foreign children atomically.
    const [plans, states] = await Promise.all([
      tx
        .select({ questionId: questionArcPlans.questionId })
        .from(questionArcPlans)
        .where(inArray(questionArcPlans.questionId, owned))
        .limit(1),
      tx
        .select({ questionId: arcStates.questionId })
        .from(arcStates)
        .where(inArray(arcStates.questionId, owned))
        .limit(1),
    ]);
    if (plans.length > 0 || states.length > 0) {
      throw new Error(
        'Upcoming-events cleanup refused foreign cascade children on QuestionArcPlan/ArcState'
      );
    }
    const removed = await tx
      .delete(questions)
      .where(inArray(questions.id, owned))
      .returning({ id: questions.id });
    if (removed.length !== owned.length) {
      throw new Error(
        `Upcoming-events cleanup refused: deleted ${removed.length} of ${owned.length} owned Question rows`
      );
    }
  });
  questionIds.length = 0;
}

afterAll(async () => {
  setSystemTime();
  await deleteOwnedQuestions();
});

async function requestEvents(limit?: number): Promise<{
  status: number;
  events: Array<{ id: string; date: string; time?: string }>;
}> {
  const url = new URL('http://localhost/api/feed/widgets/upcoming-events');
  if (limit !== undefined) url.searchParams.set('limit', String(limit));
  const response = await GET(new NextRequest(url));
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

  it('returns only the soonest event when limit is one', async () => {
    const { status, events } = await requestEvents(1);
    expect(status).toBe(200);
    expect(events.map((event) => event.date)).toEqual(['Dec 29']);
  });
});
