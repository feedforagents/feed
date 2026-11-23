/**
 * GET /api/feed/stories against a real database: the comment count shown
 * on a Stories-tab card must count only comments the post detail screen
 * can actually show. A reply under a soft-deleted parent is unreachable —
 * GET /api/posts/[id] counts it out via the reachable comment tree
 * (countReachablePostComments) — but the Stories pipeline counts every
 * non-deleted row, so the card promises a comment that does not exist
 * when the user opens the post. This is the same #1994 rule #2100 applied
 * to GET /api/posts, #2115 applied to For You cards, and #2116 applied to
 * tag feed cards.
 *
 * The single engagement query in the Stories pipeline feeds both the
 * question-story posts and the standalone general-post cards (plus the
 * new-market anchor posts), so one reachable-only count fixes all three.
 *
 * Both directions are exercised through the real route handlers, with a
 * short-lived synthetic test JWT for the detail control. Only the
 * server-only environment marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { getRedisClient, invalidateCache } from '@feed/api';
import { comments, db, eq, inArray, posts, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

// createStewardTestToken requires the secret; the test server verifies
// with the same dev fallback, so default it like the other suites do.
process.env.STEWARD_JWT_SECRET ??= 'dev-jwt-secret-change-in-prod';

type StoriesResponse = {
  success: boolean;
  stories: Array<{
    storyKey: string;
    posts: Array<{ id: string; commentCount: number }>;
  }>;
  total?: number;
};

type PostDetailResponse = {
  data: { commentCount: number };
};

let viewerId: string;
let authorId: string;
let commenterId: string;
let postId: string;
let controlPostId: string;
let token: string;
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];

let getStories: (request: NextRequest) => Promise<Response>;
let getPostDetail: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

async function fetchStoriesPage(token: string | null, offset: number) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new NextRequest(
    new Request(`http://localhost/api/feed/stories?limit=20&offset=${offset}`, {
      headers,
    })
  );
  const response = await getStories(request);
  const body = (await response.json().catch(() => null)) as
    | StoriesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function findStoriesPost(targetId: string) {
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const { status, body } = await fetchStoriesPage(null, offset);
    expect(status).toBe(200);
    const stories = (body as StoriesResponse)?.stories ?? [];
    for (const story of stories) {
      const found = story.posts.find((p) => p.id === targetId);
      if (found) return found;
    }
    const total = (body as StoriesResponse)?.total ?? 0;
    offset += stories.length;
    if (stories.length === 0 || offset >= total) return undefined;
  }
  return undefined;
}

async function fetchPostDetail(token: string, targetId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  const response = await getPostDetail(request, {
    params: Promise.resolve({ id: targetId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function clearStoriesSnapshot() {
  if (getRedisClient()) {
    throw new Error('The Stories fixture requires an in-process cache');
  }
  await invalidateCache('feed:stories:v2:current');
}

beforeAll(async () => {
  ({ GET: getStories } = await import(
    '../../../apps/web/src/app/api/feed/stories/route'
  ));
  ({ GET: getPostDetail } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  [viewerId, authorId, commenterId, postId, controlPostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const commentIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  ownedCommentIds.push(...commentIds);
  const [
    visibleA,
    visibleB,
    visibleReply,
    deletedParent,
    orphanReply,
    controlComment,
  ] = commentIds as [string, string, string, string, string, string];

  // The detail control must sign in as the viewer row: the Steward auth
  // reads the userId claim as the steward id, so the token carries the
  // viewer's stewardId, not its raw id — otherwise the request
  // auto-creates a stray user the cleanup never deletes.
  token = await createStewardTestToken(`r6f1-${viewerId}`);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  const createdUsers = await db
    .insert(users)
    .values([
      {
        id: viewerId,
        username: `r6f1-v-${viewerId}`,
        displayName: 'Stories Count Fixture Viewer',
        stewardId: `r6f1-${viewerId}`,
        updatedAt: now,
      },
      {
        id: authorId,
        username: `r6f1-a-${authorId}`,
        displayName: 'Stories Count Fixture Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `r6f1-c-${commenterId}`,
        displayName: 'Stories Count Fixture Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  ownedUserIds.push(...createdUsers.map((row) => row.id));

  const createdPosts = await db
    .insert(posts)
    .values([
      {
        id: postId,
        content: 'fixture post for stories reachable comment counts',
        authorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: controlPostId,
        content: 'control post for stories reachable comment counts',
        authorId,
        timestamp: earlier,
        createdAt: earlier,
      },
    ])
    .returning({ id: posts.id });
  ownedPostIds.push(...createdPosts.map((row) => row.id));

  // Visible tree: two top-level comments + one reply to a visible parent.
  // Unreachable: a reply under a soft-deleted parent. The raw
  // deletedAt-only count is 4; the reachable count is 3.
  await db.insert(comments).values([
    {
      id: visibleA,
      content: 'visible comment a',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleB,
      content: 'visible comment b',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleReply,
      content: 'visible reply to a',
      postId,
      authorId: commenterId,
      parentCommentId: visibleA,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: deletedParent,
      content: 'soft-deleted parent comment',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: earlier,
    },
    {
      id: orphanReply,
      content: 'reply under the deleted parent',
      postId,
      authorId: commenterId,
      parentCommentId: deletedParent,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: controlComment,
      content: 'control comment',
      postId: controlPostId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
  ]);

  await clearStoriesSnapshot();
});

afterAll(async () => {
  if (ownedCommentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, ownedCommentIds));
  }
  if (ownedPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
  await clearStoriesSnapshot();

  if (ownedCommentIds.length > 0) {
    const [leftover] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(inArray(comments.id, ownedCommentIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
  if (ownedPostIds.length > 0) {
    const [leftover] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.id, ownedPostIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
  if (ownedUserIds.length > 0) {
    const [leftover] = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ownedUserIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
});

describe('Stories card comment counts', () => {
  it('counts only reachable comments on the card', async () => {
    const card = await findStoriesPost(postId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(3);
  });

  it('agrees with the post detail count (control)', async () => {
    const detail = await fetchPostDetail(token, postId);
    expect(detail.status).toBe(200);
    const body = detail.body as PostDetailResponse;
    expect(body.data.commentCount).toBe(3);
  });

  it('counts a fully visible thread exactly (control post)', async () => {
    const card = await findStoriesPost(controlPostId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(1);
    const detail = await fetchPostDetail(token, controlPostId);
    expect(detail.status).toBe(200);
    expect((detail.body as PostDetailResponse).data.commentCount).toBe(1);
  });
});

// A deep-chain timing case pins the per-post walk: with one 1000-deep
// chain on a full pool, a cache rebuild must stay fast. The old
// page-wide walk rescanned every eligible comment at each recursion
// level (~8-31s on this shape); the per-post walk takes ~1s.
describe('Stories card comment counts on a deep chain', () => {
  const deepChainPostCount = 100;
  const flatPerPost = 500;
  const chainDepth = 1000;
  let deepPostId: string;
  let deepChainAuthorId: string;
  const deepChainPostIds: string[] = [];

  beforeAll(async () => {
    deepChainAuthorId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(users).values({
      id: deepChainAuthorId,
      username: `r6f1-deep-${deepChainAuthorId}`,
      stewardId: null,
      updatedAt: now,
    });
    const earlier = new Date(now.getTime() - 60_000);
    for (let i = 0; i < deepChainPostCount; i += 1) {
      const id = await generateSnowflakeId();
      deepChainPostIds.push(id);
      if (i === 0) deepPostId = id;
    }
    await db.insert(posts).values(
      deepChainPostIds.map((id) => ({
        id,
        authorId: deepChainAuthorId,
        content: 'Deep chain fixture for stories reachable comment counts',
        timestamp: earlier,
        createdAt: earlier,
      }))
    );
    const postIdsArray = sql`ARRAY[${sql.join(
      deepChainPostIds.map((id) => sql`${id}`),
      sql`, `
    )}]::text[]`;
    const earlierIso = earlier.toISOString();
    await db.execute(sql`
      INSERT INTO "Comment" (id, content, "postId", "authorId", "parentCommentId", "createdAt", "updatedAt")
      SELECT 'deep2117-flat-' || p."postId" || '-' || g, 'Deep chain fixture', p."postId", ${deepChainAuthorId}, NULL, ${earlierIso}, ${earlierIso}
      FROM unnest(${postIdsArray}) AS p("postId")
      CROSS JOIN generate_series(1, ${flatPerPost}) g
    `);
    await db.execute(sql`
      INSERT INTO "Comment" (id, content, "postId", "authorId", "parentCommentId", "createdAt", "updatedAt")
      SELECT 'deep2117-chain-' || g, 'Deep chain fixture', ${deepPostId}, ${deepChainAuthorId},
        CASE WHEN g = 1 THEN NULL ELSE 'deep2117-chain-' || (g - 1) END, ${earlierIso}, ${earlierIso}
      FROM generate_series(1, ${chainDepth}) g
    `);
    await clearStoriesSnapshot();
  });

  afterAll(async () => {
    await db.delete(comments).where(inArray(comments.postId, deepChainPostIds));
    await db.delete(posts).where(inArray(posts.id, deepChainPostIds));
    await db.delete(users).where(eq(users.id, deepChainAuthorId));
    await clearStoriesSnapshot();
  });

  it('rebuilds a full pool with one 1000-deep chain quickly', async () => {
    // Warm run (plan + cache), then the timed rebuild.
    await clearStoriesSnapshot();
    const warm = await fetchStoriesPage(null, 0);
    expect(warm.status).toBe(200);
    await clearStoriesSnapshot();
    const startedAt = Date.now();
    const timed = await fetchStoriesPage(null, 0);
    const elapsedMs = Date.now() - startedAt;
    expect(timed.status).toBe(200);
    // The page-wide walk took ~8-31s on this shape; the per-post walk
    // takes ~1s. 5s leaves headroom for a slow host while still
    // failing the old shape by a wide margin.
    expect(elapsedMs).toBeLessThan(5000);
    const card = await findStoriesPost(deepPostId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(1500);
  }, 120_000);
});
