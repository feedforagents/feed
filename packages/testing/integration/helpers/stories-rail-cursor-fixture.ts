// Invoked only in a fresh process by stories-rail-cursor.integration.test.ts.
//
// Premise: the stories pipeline sorts stories by score, then spreadNewMarkets
// pulls a lower-scored post story between two adjacent new-market cards.
// The list the route serves is therefore no longer monotonic in the cursor's
// (score, storyKey) order, while the route's findCursorIndex binary search
// assumes it is. This fixture builds exactly that shape through the real
// route and checks that cursor pagination delivers every story exactly once.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

mock.module('server-only', () => ({}));

const { closeDatabase, db, inArray, markets, posts, questions, users } =
  await import('@feed/db');
const { NextRequest } = await import('next/server');
const { GET } = await import(
  '../../../../apps/web/src/app/api/feed/stories/route'
);

const runId = crypto.randomUUID();
const minute = 60 * 1000;
const day = 24 * 60 * minute;
const now = new Date();

const authorId = crypto.randomUUID();
const marketId1 = crypto.randomUUID();
const marketId2 = crypto.randomUUID();
const questionId1 = crypto.randomUUID();
const questionId2 = crypto.randomUUID();
const q1 = 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 2_000_000_000);
const q2 = q1 + 1;
const postId = crypto.randomUUID();

const marketKey1 = `market:${q1}`;
const marketKey2 = `market:${q2}`;
const postKey = `post:${postId}`;

interface StoriesPage {
  stories: Array<{ storyKey: string }>;
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
}

async function fetchPage(
  cursor: string | null,
  limit: number
): Promise<StoriesPage> {
  const url = cursor
    ? `http://localhost/api/feed/stories?cursor=${encodeURIComponent(cursor)}&limit=${limit}`
    : `http://localhost/api/feed/stories?limit=${limit}`;
  const response = await GET(new NextRequest(url));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as StoriesPage;
}

async function traverse(limit: number): Promise<string[]> {
  const delivered: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const body = await fetchPage(cursor, limit);
    delivered.push(...body.stories.map((s) => s.storyKey));
    if (!body.hasMore) return delivered;
    assert.ok(body.nextCursor, 'hasMore must come with a nextCursor');
    cursor = body.nextCursor;
  }
  throw new Error(`traversal with limit=${limit} did not terminate`);
}

try {
  await db.insert(users).values([
    {
      id: authorId,
      username: `rail-${runId}`,
      isTest: false,
      updatedAt: now,
    },
  ]);
  await db.insert(markets).values([
    {
      id: marketId1,
      question: `Rail market one ${runId}`,
      liquidity: '1000',
      endDate: new Date(now.getTime() + 10 * day),
      updatedAt: now,
    },
    {
      id: marketId2,
      question: `Rail market two ${runId}`,
      liquidity: '1000',
      endDate: new Date(now.getTime() + 10 * day),
      updatedAt: now,
    },
  ]);
  await db.insert(questions).values([
    {
      id: questionId1,
      questionNumber: q1,
      marketId: marketId1,
      text: `Rail question one ${runId}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(now.getTime() + 10 * day),
      status: 'active',
      createdAt: new Date(now.getTime() - 5 * minute),
      updatedAt: now,
    },
    {
      id: questionId2,
      questionNumber: q2,
      marketId: marketId2,
      text: `Rail question two ${runId}`,
      scenarioId: 1,
      outcome: false,
      rank: 2,
      resolutionDate: new Date(now.getTime() + 10 * day),
      status: 'active',
      createdAt: new Date(now.getTime() - 10 * minute),
      updatedAt: now,
    },
  ]);
  await db.insert(posts).values([
    {
      id: postId,
      authorId,
      content: `Rail standalone post ${runId}`,
      timestamp: new Date(now.getTime() - 30 * minute),
      createdAt: now,
    },
  ]);

  // Ground truth: the full snapshot in served order. The premise of this
  // fixture is that spreadNewMarkets interleaved the low-scored post story
  // between the two high-scored market cards.
  const full = await fetchPage(null, 20);
  const fullKeys = full.stories.map((s) => s.storyKey);
  assert.deepEqual(
    fullKeys,
    [marketKey1, postKey, marketKey2],
    `premise order changed: ${JSON.stringify(fullKeys)}`
  );

  // The real client (usePaginatedStoryFeed) walks this feed by cursor.
  for (const limit of [1, 2]) {
    const delivered = await traverse(limit);
    assert.deepEqual(
      delivered,
      fullKeys,
      `cursor traversal with limit=${limit} must deliver every story exactly once`
    );
  }

  console.log('STORIES_RAIL_FIXTURE_OK rail');
} finally {
  await db.delete(posts).where(inArray(posts.id, [postId]));
  await db
    .delete(questions)
    .where(inArray(questions.id, [questionId1, questionId2]));
  await db.delete(markets).where(inArray(markets.id, [marketId1, marketId2]));
  await db.delete(users).where(inArray(users.id, [authorId]));
  await closeDatabase();
}

// The stories route import chain leaves the Bun event loop alive after the
// database is closed (the sibling stories-test-authors fixture exits the
// same way), so exit explicitly: without this the child never terminates,
// the test's 55 s watchdog kill (SIGTERM) does not stop it either, and the
// test times out at 60 s even though every assertion passed.
process.exit(0);
