/**
 * GET /api/feed/narrative (home Stories feed) against a real database:
 * when the author of a post deletes it after someone quoted/reposted it,
 * the deleted post's content must not keep circulating inside the quote.
 *
 * Every sibling read path enforces this. The For You pipeline and the
 * stories pipeline fetch repost originals with isNull(posts.deletedAt)
 * under the comment "Deleted originals must not be rendered inside
 * reposts"; the post detail route filters the same way; the post list
 * and profile posts routes keep the quote but drop the deleted embed
 * (PostCard then renders its "This post has been deleted" tombstone).
 * The narrative route's original fetch had no such filter, so the full
 * text of a deleted post was embedded in the home-feed response.
 *
 * The route handler is exercised unmodified and anonymously; deletion
 * goes through the real DELETE /api/posts/[id] handler (dev-bypass auth,
 * same as production soft delete).
 *
 * Cache handling: the route caches under key 'feed:narrative:v2' with
 * namespace 'feed', so the stored entry is 'feed:feed:narrative:v2'.
 * Invalidation must pass the same namespace — invalidating the bare key
 * deletes a different, never-populated entry and leaves the warm cache
 * serving stale stories. The setup below proves the cache is really
 * warm (a control call returns the pre-fixture stories unchanged after
 * the fixtures are inserted) before it invalidates exactly that one
 * namespaced entry. No shared cache is flushed.
 *
 * Fixture ownership: user and post IDs are registered only from
 * successful INSERT ... RETURNING results, cleanup deletes only those
 * owned rows, and a collision control proves a failed insert registers
 * nothing and cleanup leaves the pre-existing row untouched.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// The only stub: the `server-only` marker package (an empty environment
// guard that throws outside a Server Component); every database and cache
// dependency runs for real. Same pattern as favorites-post-count.
mock.module('server-only', () => ({}));

import { invalidateCache } from '@feed/api';
import { db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const DELETED_BODY = 'F66 deleted original body';
const LIVE_BODY = 'F66 live original body';

// The narrative route's cache key and namespace; the stored entry is
// `${namespace}:${key}` = 'feed:feed:narrative:v2'.
const NARRATIVE_CACHE_KEY = 'feed:narrative:v2';
const NARRATIVE_CACHE_NAMESPACE = 'feed';

async function invalidateNarrativeCache(): Promise<void> {
  await invalidateCache(NARRATIVE_CACHE_KEY, {
    namespace: NARRATIVE_CACHE_NAMESPACE,
  });
}

type FeedPost = {
  id: string;
  content: string;
  isRepost?: boolean;
  isQuote?: boolean;
  originalPostId?: string | null;
  originalPost?: { id: string; content: string; authorId: string } | null;
};
type NarrativeBody = {
  success: boolean;
  stories: Array<{ storyKey: string; posts: FeedPost[] }>;
};

let authorA: string; // original author
let authorB: string; // quoter / reposter
let deletedOriginalId: string;
let quoteOfDeletedId: string;
let repostOfDeletedId: string;
let liveOriginalId: string;
let quoteOfLiveId: string;

// Rows this fixture provably owns: IDs are added only from successful
// INSERT ... RETURNING results and are the only rows cleanup deletes.
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];

let warmBody: NarrativeBody;
let controlBody: NarrativeBody;
let body: NarrativeBody;
let flatPosts: FeedPost[];

let narrativeGET: typeof import('../../../apps/web/src/app/api/feed/narrative/route').GET;
let postDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/route').DELETE;

function findPost(id: string): FeedPost | undefined {
  return flatPosts.find((p) => p.id === id);
}

async function callNarrative(): Promise<NarrativeBody> {
  const request = new NextRequest(
    new Request('http://localhost/api/feed/narrative')
  );
  const response = await narrativeGET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as NarrativeBody;
}

/**
 * Delete only the rows registered as owned, then clear the one cache
 * entry this test owns. Idempotent: the registries are emptied, so a
 * second call (from afterAll after the collision control already ran
 * it) is a no-op besides the cache clear.
 */
async function cleanupOwnedFixtures(): Promise<void> {
  if (ownedPostIds.length > 0) {
    const ids = ownedPostIds.splice(0, ownedPostIds.length);
    await db.delete(posts).where(inArray(posts.id, ids));
  }
  if (ownedUserIds.length > 0) {
    const ids = ownedUserIds.splice(0, ownedUserIds.length);
    await db.delete(users).where(inArray(users.id, ids));
  }
  await invalidateNarrativeCache();
}

beforeAll(async () => {
  ({ GET: narrativeGET } = await import(
    '../../../apps/web/src/app/api/feed/narrative/route'
  ));
  ({ DELETE: postDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  // Warm the narrative cache with the pre-fixture state of the database,
  // so the control call below can prove the cache is really being served.
  warmBody = await callNarrative();

  [authorA, authorB] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  [
    deletedOriginalId,
    quoteOfDeletedId,
    repostOfDeletedId,
    liveOriginalId,
    quoteOfLiveId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  const [createdA] = await db
    .insert(users)
    .values({
      id: authorA,
      username: `test-f66-a-${authorA}`,
      displayName: 'F66 Original Author',
      updatedAt: new Date(now),
    })
    .returning({ id: users.id });
  if (!createdA) {
    throw new Error('Fixture author A insert returned no row');
  }
  ownedUserIds.push(createdA.id);
  authorA = createdA.id;

  const [createdB] = await db
    .insert(users)
    .values({
      id: authorB,
      username: `test-f66-b-${authorB}`,
      displayName: 'F66 Quoter',
      updatedAt: new Date(now),
    })
    .returning({ id: users.id });
  if (!createdB) {
    throw new Error('Fixture author B insert returned no row');
  }
  ownedUserIds.push(createdB.id);
  authorB = createdB.id;

  // Two originals by A; B quotes both and plainly reposts the first.
  // Narrative window is 12h, so all timestamps are a few hours old.
  const createdPosts = await db
    .insert(posts)
    .values([
      {
        id: deletedOriginalId,
        content: DELETED_BODY,
        authorId: authorA,
        timestamp: at(180),
        createdAt: at(180),
      },
      {
        id: liveOriginalId,
        content: LIVE_BODY,
        authorId: authorA,
        timestamp: at(170),
        createdAt: at(170),
      },
      {
        id: quoteOfDeletedId,
        content: 'F66 quote commentary',
        authorId: authorB,
        type: 'repost',
        originalPostId: deletedOriginalId,
        timestamp: at(120),
        createdAt: at(120),
      },
      {
        id: repostOfDeletedId,
        content: '',
        authorId: authorB,
        type: 'repost',
        originalPostId: deletedOriginalId,
        timestamp: at(60),
        createdAt: at(60),
      },
      {
        id: quoteOfLiveId,
        content: 'F66 live quote commentary',
        authorId: authorB,
        type: 'repost',
        originalPostId: liveOriginalId,
        timestamp: at(90),
        createdAt: at(90),
      },
    ])
    .returning({ id: posts.id });
  if (createdPosts.length !== 5) {
    throw new Error('Fixture post insert returned an incomplete set');
  }
  for (const row of createdPosts) {
    ownedPostIds.push(row.id);
  }

  // Warm-cache control: with the fixtures in the database but the cache
  // untouched, the route must still serve the pre-fixture stories. The
  // main assertions below are only meaningful if this holds.
  controlBody = await callNarrative();

  // The original author deletes their post through the real route.
  const deleteRequest = new NextRequest(
    new Request(`http://localhost/api/posts/${deletedOriginalId}`, {
      method: 'DELETE',
      headers: { 'x-dev-user-id': authorA },
    })
  );
  const deleteResponse = await postDELETE(deleteRequest, {
    params: Promise.resolve({ id: deletedOriginalId }),
  });
  expect(deleteResponse.status).toBe(200);
  const [deletedRow] = await db
    .select({ deletedAt: posts.deletedAt })
    .from(posts)
    .where(eq(posts.id, deletedOriginalId));
  expect(deletedRow?.deletedAt).not.toBeNull();

  // Drop exactly the one namespaced entry this test owns, so the handler
  // recomputes from the database as it would after expiry.
  await invalidateNarrativeCache();

  body = await callNarrative();
  flatPosts = body.stories.flatMap((story) => story.posts);
});

afterAll(async () => {
  await cleanupOwnedFixtures();
});

describe('narrative feed quote embeds vs deleted originals', () => {
  it('warm-cache control: the pre-invalidation call serves the pre-fixture stories', () => {
    expect(controlBody.stories).toEqual(warmBody.stories);
    const controlIds = controlBody.stories
      .flatMap((story) => story.posts)
      .map((p) => p.id);
    expect(controlIds).not.toContain(quoteOfDeletedId);
    expect(controlIds).not.toContain(quoteOfLiveId);
  });

  it('keeps the quote post itself in the feed', () => {
    const quote = findPost(quoteOfDeletedId);
    expect(quote).toBeDefined();
    expect(quote?.content).toBe('F66 quote commentary');
  });

  it('does not embed a deleted original inside a quote post', () => {
    const quote = findPost(quoteOfDeletedId);
    expect(quote?.originalPost).toBeNull();
  });

  it('does not embed a deleted original inside a simple repost', () => {
    const repost = findPost(repostOfDeletedId);
    expect(repost).toBeDefined();
    expect(repost?.originalPost).toBeNull();
  });

  it('never leaks the deleted post body anywhere in the response', () => {
    expect(JSON.stringify(body)).not.toContain(DELETED_BODY);
  });

  it('does not list the deleted original as a top-level post', () => {
    expect(findPost(deletedOriginalId)).toBeUndefined();
  });

  it('still embeds a live original inside its quote post', () => {
    const quote = findPost(quoteOfLiveId);
    expect(quote).toBeDefined();
    expect(quote?.originalPost?.id).toBe(liveOriginalId);
    expect(quote?.originalPost?.content).toBe(LIVE_BODY);
  });

  it('fixture ownership: a colliding insert registers nothing and cleanup leaves pre-existing rows untouched', async () => {
    // A pre-existing author and post the fixture does not own (stand-ins
    // for another suite's or canonical data).
    const victimAuthorId = await generateSnowflakeId();
    await db.insert(users).values({
      id: victimAuthorId,
      username: `test-f66-victim-${victimAuthorId}`,
      displayName: 'F66 Pre-existing Author',
      updatedAt: new Date(),
    });
    const [victim] = await db
      .insert(posts)
      .values({
        id: await generateSnowflakeId(),
        content: 'F66 pre-existing post',
        authorId: victimAuthorId,
        timestamp: new Date(),
        createdAt: new Date(),
      })
      .returning({ id: posts.id });
    if (!victim) {
      throw new Error('Victim post insert returned no row');
    }

    // Setup candidate that reuses the victim's ID: the insert fails, so
    // the ID must never enter the owned registry.
    let collisionThrew = false;
    try {
      const [collided] = await db
        .insert(posts)
        .values({
          id: victim.id,
          content: 'F66 colliding candidate',
          authorId: authorB,
          timestamp: new Date(),
          createdAt: new Date(),
        })
        .returning({ id: posts.id });
      if (collided) {
        ownedPostIds.push(collided.id);
      }
    } catch {
      collisionThrew = true;
    }
    expect(collisionThrew).toBe(true);
    expect(ownedPostIds).not.toContain(victim.id);

    await cleanupOwnedFixtures();

    // The pre-existing post survives; the fixture's own posts are gone.
    const [survivor] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, victim.id));
    expect(survivor?.id).toBe(victim.id);
    const remainingOwned = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.id, [deletedOriginalId, liveOriginalId]));
    expect(remainingOwned).toHaveLength(0);

    // Remove the stand-ins themselves; they were never part of the fixture.
    await db.delete(posts).where(eq(posts.id, victim.id));
    await db.delete(users).where(eq(users.id, victimAuthorId));
  });
});
