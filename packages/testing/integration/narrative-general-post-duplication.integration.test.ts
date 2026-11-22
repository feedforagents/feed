/**
 * Home stories (narrative) list composition, against a real database.
 *
 * GET /api/feed/narrative groups question-less ("general") posts into a
 * bucket that the route is supposed to dissolve into individual standalone
 * cards: at most MAX_STANDALONE_POSTS (20) of them, each competing on its
 * own score, and only those at or above MIN_STANDALONE_SCORE. Both sibling
 * pipelines that share this design — apps/web/src/app/api/feed/stories/
 * pipeline.ts and apps/web/src/app/api/feed/for-you/pipeline.ts — skip the
 * bucket in their story loop with the comment "General posts are emitted
 * below as standalone cards; grouping them into a 'General' mega-story as
 * well duplicated every one of them."
 *
 * The narrative route's story loop does not skip the bucket, so the payload
 * carries a '__general__' mega-story containing every general post AND the
 * standalone cards for the top 20 — every surfaced general post appears
 * twice, and the five posts that miss the standalone cut still appear
 * inside the mega-story, defeating the cap the dissolve was built to apply.
 *
 * The only stub is the `server-only` marker package; the route handler,
 * the cache layer and the database all run for real. The request is
 * anonymous, so no per-user enrichment is involved.
 *
 * Hardening:
 * 1. Cleanup is ownership-tracked: every INSERT records the rows its
 *    RETURNING clause confirms, per table, and cleanup deletes exactly
 *    those ids — never a pattern, never a prefix. A partial setup (an
 *    insert failing halfway) is cleaned with whatever was recorded, and a
 *    pre-existing row that merely looks like a fixture survives cleanup.
 * 2. The fixture question number is allocated, not hard-coded:
 *    questions.questionNumber is UNIQUE, so a populated database may
 *    already hold any fixed number. Allocation retries on a unique
 *    violation. The expected standalone set is computed from live database
 *    state (all recent general posts and their engagement, scored with the
 *    route's own calculateStoryScore) instead of assuming the fixture
 *    posts are the only posts in the feed.
 * 3. The route caches the whole feed under 'feed:narrative:v2' in the
 *    'feed' namespace for 120s. This test process NEVER invalidates that
 *    key: it is a shared, process-global key, and deleting it could
 *    remove another test's snapshot in the same process. The cold/hit
 *    checks run in an owned child process instead (helpers/
 *    narrative-cache-probe.ts via Bun.spawn), which has its own
 *    in-memory cache instance — its invalidation cannot touch the
 *    parent process. The 120s route TTL itself is honoured, not
 *    shortened: the hit check proves the feed stays cached inside the
 *    TTL, and expiry is proven on the same backend with a 1s TTL
 *    instead of waiting out 120s. That 1s probe establishes backend
 *    expiry behavior only, not natural expiry of the route's 120s
 *    payload.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { resolve } from 'node:path';

mock.module('server-only', () => ({}));

import { getCache, isRedisAvailable, setCache } from '@feed/api';
import {
  and,
  comments,
  count,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  posts,
  questions,
  reactions,
  shares,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { calculateStoryScore } from '../../../apps/web/src/app/api/feed/narrative/scoring';

type NarrativeStoryShape = {
  storyKey: string;
  questionNumber: number | null;
  posts: Array<{ id: string }>;
};

type NarrativeResponse = {
  success: boolean;
  stories: NarrativeStoryShape[];
};

/** Cache namespace for the run-scoped expiry probe below. */
const FEED_CACHE_NAMESPACE = 'feed';

const GENERAL_COUNT = 25;
const STANDALONE_CAP = 20;
/** Mirrors route.ts MIN_STANDALONE_SCORE (not exported); see route.ts:75. */
const MIN_STANDALONE_SCORE = 0.05;
/** Mirrors the route's candidate window and limit (route.ts:62-64). */
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const MAX_CANDIDATE_POSTS = 500;
/** Attempts to allocate a question number before giving up. */
const QUESTION_NUMBER_ATTEMPTS = 10;

type OwnedRows = {
  userIds: string[];
  questionIds: string[];
  postIds: string[];
  reactionIds: string[];
};

/** Ids of rows this test created and therefore owns (per table). */
const owned: OwnedRows = {
  userIds: [],
  questionIds: [],
  postIds: [],
  reactionIds: [],
};

let authorId: string;
let questionId: string;
let questionPostId: string;
let questionNumber: number;
/** generalPostIds[i] receives i + 1 likes, so standalone rank is deterministic. */
const generalPostIds: string[] = [];
const reactorIds: string[] = [];
let oneHourAgo: Date;
let thirtyMinAgo: Date;

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/feed/narrative/route';

async function fetchNarrative() {
  const request = new NextRequest(
    new Request('http://localhost/api/feed/narrative')
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | NarrativeResponse
    | { data?: NarrativeResponse }
    | null;
  const payload = body && 'stories' in body ? body : (body?.data ?? null);
  return { status: response.status, payload };
}

/** Delete exactly the rows in `o` (by id, per table) and forget them. */
async function cleanupOwned(o: OwnedRows): Promise<void> {
  if (o.reactionIds.length > 0) {
    await db.delete(reactions).where(inArray(reactions.id, o.reactionIds));
    o.reactionIds.length = 0;
  }
  if (o.postIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, o.postIds));
    o.postIds.length = 0;
  }
  if (o.questionIds.length > 0) {
    await db.delete(questions).where(inArray(questions.id, o.questionIds));
    o.questionIds.length = 0;
  }
  if (o.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, o.userIds));
    o.userIds.length = 0;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate key');
}

/**
 * Insert the fixture question under a number no other row holds.
 * questions.questionNumber is UNIQUE, so a fixed number can already exist
 * in a populated database; retry with a fresh random number instead.
 */
async function insertQuestionWithUniqueNumber(
  now: Date,
  threeDaysAgo: Date
): Promise<number> {
  for (let attempt = 0; attempt < QUESTION_NUMBER_ATTEMPTS; attempt++) {
    const candidate = 100000 + Math.floor(Math.random() * 900000);
    try {
      const rows = await db
        .insert(questions)
        .values({
          id: questionId,
          questionNumber: candidate,
          text: 'F83 fixture question',
          scenarioId: 1,
          outcome: false,
          rank: 1,
          resolutionDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
          status: 'active',
          createdAt: threeDaysAgo,
          updatedAt: now,
        })
        .returning({ id: questions.id });
      owned.questionIds.push(rows[0]!.id);
      return candidate;
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error(
    `could not allocate a unique questionNumber after ${QUESTION_NUMBER_ATTEMPTS} attempts`
  );
}

async function setupFixtures(): Promise<void> {
  const now = new Date();
  oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  authorId = await generateSnowflakeId();
  questionId = await generateSnowflakeId();
  questionPostId = await generateSnowflakeId();
  for (let i = 0; i < GENERAL_COUNT; i++) {
    generalPostIds.push(await generateSnowflakeId());
    reactorIds.push(await generateSnowflakeId());
  }

  const userRows = await db
    .insert(users)
    .values({
      id: authorId,
      username: `f83-author-${authorId}`,
      displayName: 'F83 Narrative Author',
      updatedAt: now,
    })
    .returning({ id: users.id });
  owned.userIds.push(userRows[0]!.id);

  questionNumber = await insertQuestionWithUniqueNumber(now, threeDaysAgo);

  const questionPostRows = await db
    .insert(posts)
    .values({
      id: questionPostId,
      content: 'f83 question-linked post',
      authorId,
      timestamp: thirtyMinAgo,
      createdAt: thirtyMinAgo,
      relatedQuestion: questionNumber,
    })
    .returning({ id: posts.id });
  owned.postIds.push(questionPostRows[0]!.id);

  const generalPostRows = await db
    .insert(posts)
    .values(
      generalPostIds.map((id, i) => ({
        id,
        content: `f83 general post ${i + 1}`,
        authorId,
        timestamp: oneHourAgo,
        createdAt: oneHourAgo,
        relatedQuestion: null,
      }))
    )
    .returning({ id: posts.id });
  owned.postIds.push(...generalPostRows.map((r) => r.id));

  // Likes: generalPostIds[i] gets i + 1 likes from distinct reactors, so
  // standalone scores rank strictly by index (same timestamp for all).
  const reactionValues: Array<{
    id: string;
    postId: string;
    userId: string;
    type: string;
  }> = [];
  for (let i = 0; i < GENERAL_COUNT; i++) {
    for (let r = 0; r <= i; r++) {
      reactionValues.push({
        id: await generateSnowflakeId(),
        postId: generalPostIds[i]!,
        userId: reactorIds[r]!,
        type: 'like',
      });
    }
  }
  const reactionRows = await db
    .insert(reactions)
    .values(reactionValues)
    .returning({ id: reactions.id });
  owned.reactionIds.push(...reactionRows.map((r) => r.id));
}

/**
 * The standalone set the route should emit, computed from live database
 * state — mirroring the route's own candidate window: the newest 500
 * eligible posts of BOTH kinds first, and only then the general posts
 * among them, scored with the route's own function, top 20, at or above
 * the minimum score. Filtering to general posts BEFORE the limit would
 * select a different population than production: on a populated feed,
 * 499 newer question posts can fill the window, leaving production with
 * no general candidates while a pre-filtered helper still expects the
 * older general fixtures. The test never assumes the fixture posts are
 * the only posts in the feed.
 */
async function expectedStandalone(): Promise<{
  ids: Set<string>;
  poolSize: number;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - TWELVE_HOURS_MS);
  const candidates = await db
    .select({
      id: posts.id,
      timestamp: posts.timestamp,
      relatedQuestion: posts.relatedQuestion,
    })
    .from(posts)
    .where(
      and(
        isNull(posts.deletedAt),
        gte(posts.timestamp, cutoff),
        lte(posts.timestamp, now),
        isNull(posts.commentOnPostId),
        isNull(posts.parentCommentId)
      )
    )
    .orderBy(desc(posts.timestamp))
    .limit(MAX_CANDIDATE_POSTS);
  // Partition AFTER the window, exactly like the route: only the general
  // posts that made the newest-500 cut can become standalone cards.
  const general = candidates.filter((c) => c.relatedQuestion === null);
  if (general.length === 0) return { ids: new Set(), poolSize: 0 };

  const ids = general.map((c) => c.id);
  const [likeRows, commentRows, shareRows] = await Promise.all([
    db
      .select({ postId: reactions.postId, n: count() })
      .from(reactions)
      .where(and(eq(reactions.type, 'like'), inArray(reactions.postId, ids)))
      .groupBy(reactions.postId),
    db
      .select({ postId: comments.postId, n: count() })
      .from(comments)
      .where(and(isNull(comments.deletedAt), inArray(comments.postId, ids)))
      .groupBy(comments.postId),
    db
      .select({ postId: shares.postId, n: count() })
      .from(shares)
      .where(inArray(shares.postId, ids))
      .groupBy(shares.postId),
  ]);
  const byId = (
    rows: Array<{ postId: string | null; n: number | string }>
  ): Map<string, number> => {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.postId) map.set(row.postId, Number(row.n));
    }
    return map;
  };
  const likes = byId(likeRows);
  const commentCounts = byId(commentRows);
  const shareCounts = byId(shareRows);

  const scored = general
    .map((c) => ({
      id: c.id,
      score: calculateStoryScore(
        likes.get(c.id) ?? 0,
        commentCounts.get(c.id) ?? 0,
        shareCounts.get(c.id) ?? 0,
        1,
        new Date(c.timestamp)
      ),
    }))
    .sort((a, b) => b.score - a.score);
  const eligible = scored.filter((s) => s.score >= MIN_STANDALONE_SCORE);
  return {
    ids: new Set(eligible.slice(0, STANDALONE_CAP).map((s) => s.id)),
    poolSize: eligible.length,
  };
}

function countAppearances(stories: NarrativeStoryShape[]): Map<string, number> {
  const appearances = new Map<string, number>();
  for (const story of stories) {
    for (const post of story.posts) {
      appearances.set(post.id, (appearances.get(post.id) ?? 0) + 1);
    }
  }
  return appearances;
}

beforeAll(async () => {
  if (isRedisAvailable()) {
    throw new Error('Narrative fixtures require a process-local cache');
  }
  ({ GET } = await import(routePath));

  try {
    await setupFixtures();
  } catch (error) {
    // Partial setup: remove whatever was recorded, then surface the failure.
    await cleanupOwned(owned);
    throw error;
  }
  // No cache invalidation here: the first fetch in this process is cold
  // (fresh process, empty in-memory cache) and computes from the database
  // including the fixtures. The route's fixed key is never invalidated in
  // this process; cold/hit checks run in an owned child process instead.
});

afterAll(async () => {
  await cleanupOwned(owned);
});

/**
 * Run one cache-probe scenario in an owned child process (helpers/
 * narrative-cache-probe.ts) and return its JSON result. The child has
 * its own in-memory cache instance, so its key invalidation cannot
 * touch this process.
 */
async function runCacheProbe(
  scenario: 'cache' | 'flood'
): Promise<Record<string, unknown>> {
  const helperPath = resolve(
    import.meta.dir,
    'helpers/narrative-cache-probe.ts'
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      helperPath,
      scenario,
      authorId,
      String(questionNumber),
      oneHourAgo.toISOString(),
    ],
    {
      env: { ...process.env, FEED_DISABLE_REDIS: '1', REDIS_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(
        `cache probe ${scenario} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`
      );
    }
    const line = stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) {
      throw new Error(
        `cache probe ${scenario} printed no result\nstdout: ${stdout}\nstderr: ${stderr}`
      );
    }
    return JSON.parse(line.slice('PROBE_RESULT '.length)) as Record<
      string,
      unknown
    >;
  } finally {
    clearTimeout(timeout);
  }
}

describe('GET /api/feed/narrative — general post composition', () => {
  it('emits each general post at most once, as a standalone card, capped at 20', async () => {
    // Cold fetch: the cache was invalidated after setup, so the route
    // computes this payload from the database.
    const { status, payload } = await fetchNarrative();
    expect(status).toBe(200);
    expect(payload).not.toBeNull();
    const stories = payload!.stories;

    // No mega-story grouping the general bucket a second time.
    expect(stories.map((s) => s.storyKey)).not.toContain('__general__');

    // Count every appearance of every fixture post across all stories.
    const appearances = countAppearances(stories);

    // The question-linked post rides its question story exactly once.
    expect(appearances.get(questionPostId)).toBe(1);
    const questionStory = stories.find(
      (s) => s.storyKey === String(questionNumber)
    );
    expect(questionStory).toBeDefined();
    expect(questionStory!.posts.map((p) => p.id)).toEqual([questionPostId]);

    // Baseline-aware expectation: the standalone cards must be exactly the
    // top-20 general posts by score in the live database, fixture or not.
    const expected = await expectedStandalone();
    const standaloneIds = new Set(
      stories
        .filter((s) => s.storyKey.startsWith('post:'))
        .flatMap((s) => s.posts.map((p) => p.id))
    );
    expect([...standaloneIds].sort()).toEqual([...expected.ids].sort());
    // The cap fires whenever the eligible pool exceeds it.
    expect(standaloneIds.size).toBe(
      Math.min(STANDALONE_CAP, expected.poolSize)
    );

    // Cap control on the fixture itself: 25 ranked general posts, the top
    // 20 expected once, the bottom 5 absent — as a prefix of the fixture
    // ranking, whatever else the database holds.
    for (let i = 0; i < GENERAL_COUNT; i++) {
      const expectedCount = expected.ids.has(generalPostIds[i]!) ? 1 : 0;
      expect(appearances.get(generalPostIds[i]!) ?? 0).toBe(expectedCount);
    }
    const rankedFixture = [...generalPostIds]
      .map((id, i) => ({ id, likes: i + 1 }))
      .sort((a, b) => b.likes - a.likes);
    let seenAbsent = false;
    for (const { id } of rankedFixture) {
      if (expected.ids.has(id)) {
        expect(seenAbsent).toBe(false);
      } else {
        seenAbsent = true;
      }
    }
  });

  it('serves the cached feed inside the TTL and recomputes after the exact key is invalidated', async () => {
    // The cold/hit sequence runs in an owned child process (its own
    // in-memory cache instance): a probe post inserted after the child's
    // first fetch stays invisible until the child invalidates the key,
    // then appears exactly once as its own standalone card. This
    // process never touches the route's fixed key.
    const result = await runCacheProbe('cache');
    expect(result).toEqual({
      scenario: 'cache',
      hitProbeAbsent: true,
      coldProbeOnce: true,
      coldProbePresent: true,
    });
  });

  it('emits no general standalone cards when newer question posts fill the candidate window', async () => {
    // The reviewer's concrete case: 499 question posts newer than the
    // fixtures plus the owned question post fill the route's newest-500
    // window, so production has no general candidates. Runs in the
    // owned child process so its invalidation stays out of this process.
    const result = await runCacheProbe('flood');
    expect(result).toEqual({
      scenario: 'flood',
      routeStandalone: 0,
      windowGeneral: 0,
      questionStoryPresent: true,
    });
  });

  it('the cache backend expires entries after their TTL', async () => {
    const probeKey = `f83-expiry-probe:${await generateSnowflakeId()}`;
    // Cold: a key that was never set is a miss.
    expect(
      await getCache(probeKey, { namespace: FEED_CACHE_NAMESPACE })
    ).toBeNull();
    await setCache(
      probeKey,
      { marker: probeKey },
      { namespace: FEED_CACHE_NAMESPACE, ttl: 1 }
    );
    // Hit: set with a 1s TTL reads back inside the TTL.
    expect(
      await getCache<{ marker: string }>(probeKey, {
        namespace: FEED_CACHE_NAMESPACE,
      })
    ).toEqual({ marker: probeKey });
    // Expired: past the TTL the same key is a miss again.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(
      await getCache(probeKey, { namespace: FEED_CACHE_NAMESPACE })
    ).toBeNull();
  });

  it('cleanup deletes only rows this test owns; pre-existing rows survive', async () => {
    // Sentinel rows that look like fixtures but are NOT in `owned`.
    const sentinelUserId = await generateSnowflakeId();
    const sentinelPostId = await generateSnowflakeId();
    const sentinelReactionId = await generateSnowflakeId();
    await db.insert(users).values({
      id: sentinelUserId,
      username: `f83-sentinel-${sentinelUserId}`,
      displayName: 'F83 Sentinel',
      updatedAt: new Date(),
    });
    await db.insert(posts).values({
      id: sentinelPostId,
      content: 'f83 sentinel post',
      authorId: sentinelUserId,
      timestamp: oneHourAgo,
      createdAt: oneHourAgo,
      relatedQuestion: null,
    });
    await db.insert(reactions).values({
      id: sentinelReactionId,
      postId: sentinelPostId,
      userId: sentinelUserId,
      type: 'like',
    });

    // A partial setup: a throwaway user recorded, its post not recorded.
    const partialUserId = await generateSnowflakeId();
    const partialPostId = await generateSnowflakeId();
    await db.insert(users).values({
      id: partialUserId,
      username: `f83-partial-${partialUserId}`,
      displayName: 'F83 Partial',
      updatedAt: new Date(),
    });
    await db.insert(posts).values({
      id: partialPostId,
      content: 'f83 partial post',
      authorId: partialUserId,
      timestamp: oneHourAgo,
      createdAt: oneHourAgo,
      relatedQuestion: null,
    });
    const partialOwned: OwnedRows = {
      userIds: [partialUserId],
      questionIds: [],
      postIds: [],
      reactionIds: [],
    };

    try {
      // The real afterAll path, plus the partial-setup path.
      await cleanupOwned(owned);
      await cleanupOwned(partialOwned);

      // Sentinels survive both cleanups.
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, sentinelUserId))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, sentinelPostId))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: reactions.id })
          .from(reactions)
          .where(eq(reactions.id, sentinelReactionId))
      ).toHaveLength(1);

      // Partial cleanup removed the recorded user, not its unrecorded post.
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, partialUserId))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, partialPostId))
      ).toHaveLength(1);

      // The fixture rows themselves are gone (they were owned).
      expect(
        await db
          .select({ id: posts.id })
          .from(posts)
          .where(eq(posts.id, questionPostId))
      ).toHaveLength(0);
    } finally {
      await db.delete(reactions).where(eq(reactions.id, sentinelReactionId));
      await db
        .delete(posts)
        .where(inArray(posts.id, [sentinelPostId, partialPostId]));
      await db
        .delete(users)
        .where(inArray(users.id, [sentinelUserId, partialUserId]));
    }
  });
});
