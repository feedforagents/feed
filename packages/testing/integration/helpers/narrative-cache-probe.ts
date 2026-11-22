// Isolated real-service/DB fixture. Only invoked by
// narrative-general-post-duplication.integration.test.ts via Bun.spawn.
//
// WHY a child process: the narrative route caches its payload under the
// FIXED key 'feed:narrative:v2' (namespace 'feed', 120s TTL). The test
// process must never invalidate that key — it is a shared, process-global
// key, and deleting it could remove another test's snapshot in the same
// process. This helper runs in its OWN process with its OWN in-memory
// cache instance, so its invalidations cannot touch the parent process.
// The route code, cache service and TTL are unchanged.
//
// Usage: bun helpers/narrative-cache-probe.ts <scenario> <authorId>
//   <questionNumber> <oneHourAgoIso>
//   scenario 'cache': cold/hit check — a probe post inserted after the
//     first fetch must stay invisible until the key is invalidated,
//     then appear exactly once as its own standalone card.
//   scenario 'flood': candidate-window check — 499 question posts newer
//     than the fixtures fill the route's 500-post window, so the route
//     must emit no general standalone cards and the newest-500 window
//     must contain no general posts.
// Prints one line `PROBE_RESULT {...}` to stdout and exits 0 on success,
// 1 on any failure. Owns and deletes every row it inserts.
import { mock } from 'bun:test';

mock.module('server-only', () => ({}));

import assert from 'node:assert/strict';
import {
  and,
  closeDatabase,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  posts,
  reactions,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const FEED_CACHE_KEY = 'feed:narrative:v2';
const FEED_CACHE_NAMESPACE = 'feed';
const MAX_CANDIDATE_POSTS = 500;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const PROBE_LIKES = 100;
const FLOOD_COUNT = 499;

type NarrativeStoryShape = {
  storyKey: string;
  posts: Array<{ id: string }>;
};

type NarrativeResponse = {
  success: boolean;
  stories: NarrativeStoryShape[];
};

const [scenario, authorId, questionNumber, oneHourAgo] = z
  .tuple([
    z.enum(['cache', 'flood']),
    z.string().min(1),
    z.coerce.number().int().positive(),
    z.coerce.date(),
  ])
  .parse(process.argv.slice(2));

let GET: (request: NextRequest) => Promise<Response>;

async function fetchNarrative(): Promise<NarrativeResponse> {
  const request = new NextRequest(
    new Request('http://localhost/api/feed/narrative')
  );
  const response = await GET(request);
  assert.equal(response.status, 200);
  const body = (await response.json().catch(() => null)) as
    | NarrativeResponse
    | { data?: NarrativeResponse }
    | null;
  const payload = body && 'stories' in body ? body : (body?.data ?? null);
  assert.ok(payload, 'empty narrative payload');
  return payload;
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

async function runCacheScenario(): Promise<Record<string, unknown>> {
  // Cold fetch #1: populates THIS process's cache with the pre-probe payload.
  await fetchNarrative();

  // A probe post that would rank first if the feed recomputed.
  const probeId = await generateSnowflakeId();
  const probeReactionValues: Array<{
    id: string;
    postId: string;
    userId: string;
    type: string;
  }> = [];
  for (let r = 0; r < PROBE_LIKES; r++) {
    probeReactionValues.push({
      id: await generateSnowflakeId(),
      postId: probeId,
      userId: await generateSnowflakeId(),
      type: 'like',
    });
  }
  const probeReactionRows = await db.transaction(async (tx) => {
    await tx.insert(posts).values({
      id: probeId,
      content: 'f83 cache probe post',
      authorId,
      timestamp: oneHourAgo,
      createdAt: oneHourAgo,
      relatedQuestion: null,
    });
    return tx
      .insert(reactions)
      .values(probeReactionValues)
      .returning({ id: reactions.id });
  });
  try {
    // Hit: no invalidation, so the cached payload must not contain the probe.
    const cached = await fetchNarrative();
    const cachedIds = new Set(
      cached.stories.flatMap((s) => s.posts.map((p) => p.id))
    );
    const hitProbeAbsent = !cachedIds.has(probeId);
    assert.equal(hitProbeAbsent, true, 'probe leaked into cached payload');

    // Cold again: invalidate exactly the key — inside THIS process only —
    // and the probe must appear exactly once as its own standalone card.
    const { invalidateCache } = await import('@feed/api');
    await invalidateCache(FEED_CACHE_KEY, {
      namespace: FEED_CACHE_NAMESPACE,
    });
    const fresh = await fetchNarrative();
    const freshAppearances = countAppearances(fresh.stories);
    const coldProbeOnce = freshAppearances.get(probeId) === 1;
    assert.equal(
      coldProbeOnce,
      true,
      'probe did not appear once after cold fetch'
    );
    const probeStory = fresh.stories.find(
      (s) => s.storyKey === `post:${probeId}`
    );
    assert.ok(probeStory, 'probe has no standalone card after cold fetch');
    return { scenario, hitProbeAbsent, coldProbeOnce, coldProbePresent: true };
  } finally {
    if (probeReactionRows.length > 0) {
      await db.delete(reactions).where(
        inArray(
          reactions.id,
          probeReactionRows.map((r) => r.id)
        )
      );
    }
    await db.delete(posts).where(eq(posts.id, probeId));
  }
}

async function runFloodScenario(): Promise<Record<string, unknown>> {
  // Cold fetch #1: populates THIS process's cache with the fixture payload.
  await fetchNarrative();

  // 499 question posts NEWER than the fixtures: together with the owned
  // question post they fill the route's 500-post candidate window.
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const floodPostIds: string[] = [];
  for (let i = 0; i < FLOOD_COUNT; i++) {
    floodPostIds.push(await generateSnowflakeId());
  }
  const floodRows = await db
    .insert(posts)
    .values(
      floodPostIds.map((id, i) => ({
        id,
        content: `f83 flood post ${i + 1}`,
        authorId,
        timestamp: new Date(fiveMinAgo.getTime() - i * 1000),
        createdAt: new Date(fiveMinAgo.getTime() - i * 1000),
        relatedQuestion: questionNumber,
      }))
    )
    .returning({ id: posts.id });
  try {
    assert.equal(floodRows.length, FLOOD_COUNT);
    // Cold again: invalidate inside THIS process only, then fetch.
    const { invalidateCache } = await import('@feed/api');
    await invalidateCache(FEED_CACHE_KEY, {
      namespace: FEED_CACHE_NAMESPACE,
    });
    const fresh = await fetchNarrative();
    const standaloneIds = new Set(
      fresh.stories
        .filter((s) => s.storyKey.startsWith('post:'))
        .flatMap((s) => s.posts.map((p) => p.id))
    );
    // The window is full of question posts: no general standalone cards.
    assert.equal(
      standaloneIds.size,
      0,
      `expected no standalone cards with a full question window, got ${standaloneIds.size}`
    );
    // The flood question story itself occupies the window.
    const questionStory = fresh.stories.find(
      (s) => s.storyKey === String(questionNumber)
    );
    assert.ok(questionStory, 'flood question story missing');

    // Window-first check: the newest 500 eligible posts (both kinds)
    // contain no general post at all.
    const cutoff = new Date(now.getTime() - TWELVE_HOURS_MS);
    const windowRows = await db
      .select({ id: posts.id, relatedQuestion: posts.relatedQuestion })
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
    const windowGeneral = windowRows.filter(
      (r) => r.relatedQuestion === null
    ).length;
    assert.equal(
      windowGeneral,
      0,
      `window still holds ${windowGeneral} general posts`
    );
    return {
      scenario,
      routeStandalone: standaloneIds.size,
      windowGeneral,
      questionStoryPresent: true,
    };
  } finally {
    await db.delete(posts).where(
      inArray(
        posts.id,
        floodRows.map(({ id }) => id)
      )
    );
  }
}

try {
  ({ GET } = await import(
    '../../../../apps/web/src/app/api/feed/narrative/route'
  ));
  const result =
    scenario === 'cache' ? await runCacheScenario() : await runFloodScenario();
  console.log(`PROBE_RESULT ${JSON.stringify(result)}`);
} catch (error) {
  console.error(`cache probe ${scenario} failed:`, error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
process.exit(process.exitCode ?? 0);
