/**
 * The breaking-news widget documents a `limit` query parameter (OpenAPI
 * default 5, max 20) and the public RSS consumer at /feed/breaking-news/rss
 * asks for 20 items, but the route discarded the validated value and always
 * returned the configured three-item cap. Uses the real route and PostgreSQL.
 * Only the server-only environment marker is stubbed.
 *
 * Fixture isolation: the handler merges the global public world events, price
 * updates and actor posts, sorts that combined result and limits it, so a
 * pre-existing or concurrently inserted announcement newer than the fixture
 * could displace it and fail these assertions even with a correct route. This
 * suite therefore requires a positively verified disposable database
 * (same allowlist as widget-markets-expiry), refuses to run while any row the
 * handler reads already exists, and publishes ownership only from successful
 * INSERT ... RETURNING rows. Two extra boundary rows (a non-public event
 * newer than every fixture and a future public event) prove the unchanged
 * visibility/time boundary on both the anonymous and signed branches.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { optionalAuth } from '@feed/api';
import {
  db,
  inArray,
  lte,
  posts,
  stockPrices,
  users,
  worldEvents,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/breaking-news/route';
import { createStewardTestToken } from './helpers/steward-auth';

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
  throw new Error('Breaking-news fixture requires one disposable primary');

// Published only after the matching INSERT returns the row.
const ownedEventIds: string[] = [];
const ownedUserIds: string[] = [];
let newestEventId: string;
let nonPublicEventId: string;
let futureEventId: string;
let stewardUserId: string;
let stewardToken: string;

interface BreakingNewsResponse {
  success: boolean;
  news?: Array<{ id: string; title: string; timestamp: string }>;
}

beforeAll(async () => {
  const now = new Date();
  const [existingEvents, existingPrices, existingPosts] = await Promise.all([
    db
      .select({ id: worldEvents.id })
      .from(worldEvents)
      .where(lte(worldEvents.timestamp, now))
      .limit(1),
    db
      .select({ id: stockPrices.id })
      .from(stockPrices)
      .where(lte(stockPrices.timestamp, now))
      .limit(1),
    db
      .select({ id: posts.id })
      .from(posts)
      .where(lte(posts.timestamp, now))
      .limit(1),
  ]);
  if (
    existingEvents.length > 0 ||
    existingPrices.length > 0 ||
    existingPosts.length > 0
  ) {
    throw new Error(
      'Breaking-news fixture requires an isolated population: the handler reads global public events, price updates and actor posts at or before now. Dispose or lease the database instead of deleting foreign rows.'
    );
  }

  // Five newsworthy public events, newest first. `announcement` matches the
  // helper's newsworthy patterns.
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => generateSnowflakeId())
  );
  const boundaryIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const userId = await generateSnowflakeId();
  const stewardClaim = `steward-bn-${userId}`;
  const token = await createStewardTestToken(stewardClaim);
  const nowMs = Date.now();

  const insertedEvents = await db
    .insert(worldEvents)
    .values([
      ...ids.map((id, index) => ({
        id,
        eventType: 'announcement',
        description: `Breaking news limit fixture ${index}`,
        visibility: 'public',
        gameId: 'continuous',
        timestamp: new Date(nowMs - index * 1000),
        createdAt: new Date(nowMs - index * 1000),
      })),
      {
        // Newer than every fixture: leaks into slot one if the visibility
        // filter ever stops being applied.
        id: boundaryIds[0]!,
        eventType: 'announcement',
        description: 'Non-public boundary fixture',
        visibility: 'private',
        gameId: 'continuous',
        timestamp: new Date(nowMs + 1000),
        createdAt: new Date(nowMs + 1000),
      },
      {
        // Outside the `timestamp <= now` window: leaks into slot one if the
        // handler ever admits future items.
        id: boundaryIds[1]!,
        eventType: 'announcement',
        description: 'Future boundary fixture',
        visibility: 'public',
        gameId: 'continuous',
        timestamp: new Date(nowMs + 86_400_000),
        createdAt: new Date(nowMs + 86_400_000),
      },
    ])
    .returning({ id: worldEvents.id });
  if (insertedEvents.length !== 7) {
    throw new Error(
      `Breaking-news fixture setup refused: expected 7 returned events, received ${insertedEvents.length}`
    );
  }
  ownedEventIds.push(...insertedEvents.map((row) => row.id));
  newestEventId = ids[0]!;
  nonPublicEventId = boundaryIds[0]!;
  futureEventId = boundaryIds[1]!;

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: userId,
        privyId: `did:privy:test-bn-${userId}`,
        username: `test-bn-${userId}`,
        displayName: 'Breaking News Fixture Reporter',
        stewardId: stewardClaim,
        virtualBalance: '1000',
        totalDeposited: '1000',
        totalWithdrawn: '0',
        lifetimePnL: '0.00',
        reputationPoints: 0,
        isActor: false,
        isAgent: false,
        profileComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    .returning({ id: users.id });
  if (insertedUsers.length !== 1) {
    throw new Error(
      `Breaking-news fixture setup refused: expected 1 returned user, received ${insertedUsers.length}`
    );
  }
  ownedUserIds.push(userId);
  stewardUserId = userId;
  stewardToken = token;
});

afterAll(async () => {
  if (ownedEventIds.length > 0) {
    const removed = await db
      .delete(worldEvents)
      .where(inArray(worldEvents.id, ownedEventIds))
      .returning({ id: worldEvents.id });
    if (removed.length !== ownedEventIds.length) {
      throw new Error(
        `Breaking-news fixture cleanup refused: expected ${ownedEventIds.length} events, removed ${removed.length}`
      );
    }
    ownedEventIds.length = 0;
  }
  if (ownedUserIds.length > 0) {
    const removed = await db
      .delete(users)
      .where(inArray(users.id, ownedUserIds))
      .returning({ id: users.id });
    if (removed.length !== ownedUserIds.length) {
      throw new Error(
        `Breaking-news fixture cleanup refused: expected ${ownedUserIds.length} users, removed ${removed.length}`
      );
    }
    ownedUserIds.length = 0;
  }
});

function buildRequest(query = '', signed = false): NextRequest {
  return new NextRequest(
    `http://localhost/api/feed/widgets/breaking-news${query}`,
    signed
      ? { headers: { Authorization: `Bearer ${stewardToken}` } }
      : undefined
  );
}

async function requestNews(
  query = '',
  signed = false
): Promise<{
  status: number;
  news: Array<{ id: string; title: string; timestamp: string }>;
}> {
  const response = await GET(buildRequest(query, signed));
  const body = (await response.json()) as BreakingNewsResponse;
  return { status: response.status, news: body.news ?? [] };
}

for (const signed of [false, true]) {
  describe(
    signed
      ? 'Breaking news widget honors the documented limit (signed)'
      : 'Breaking news widget honors the documented limit',
    () => {
      if (signed) {
        it('resolves the signed session to the fixture user', async () => {
          const identity = await optionalAuth(buildRequest('', true)).catch(
            () => null
          );
          expect(identity?.userId).toBe(stewardUserId);
        });
      }

      it('keeps the configured three-item cap when no limit is passed', async () => {
        const { status, news } = await requestNews('', signed);
        expect(status).toBe(200);
        expect(news).toHaveLength(3);
        expect(news[0]?.id).toBeDefined();
        expect(ownedEventIds).toContain(news[0]!.id);
      });

      it('returns more than the widget cap when a larger limit is requested', async () => {
        const { status, news } = await requestNews('?limit=10', signed);
        expect(status).toBe(200);
        // The base implementation always slices to three, so the fixture's five
        // events can never all appear until the validated limit is applied.
        expect(news.length).toBeGreaterThanOrEqual(5);
        for (const id of ownedEventIds.slice(0, 5)) {
          expect(news.some((item) => item.id === id)).toBe(true);
        }
      });

      it('returns a single item when limit=1', async () => {
        const { status, news } = await requestNews('?limit=1', signed);
        expect(status).toBe(200);
        expect(news).toHaveLength(1);
        expect(news[0]?.id).toBe(newestEventId);
      });

      it('still rejects an out-of-range limit', async () => {
        const { status } = await requestNews('?limit=99', signed);
        expect(status).toBe(400);
      });

      it('keeps non-public and future events out of the response', async () => {
        const { status, news } = await requestNews('?limit=10', signed);
        expect(status).toBe(200);
        const returnedIds = news.map((item) => item.id);
        expect(returnedIds).not.toContain(nonPublicEventId);
        expect(returnedIds).not.toContain(futureEventId);
      });
    }
  );
}
