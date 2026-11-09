/**
 * GET /api/posts?following=true against a real database: the Following
 * feed must apply its author exclusions before it cuts a page, the same
 * way every sibling feed does.
 *
 * Two exclusions are mishandled in the Following branch:
 *
 * - Test authors: the canonical `DatabaseService.getRecentPosts`
 *   excludes them in SQL before paginating with two conditions —
 *   `authorId NOT LIKE 'test-%'` and `NOT EXISTS (users.isTest)` — and
 *   the web favorites feed (#1670) drops both shapes from its candidate
 *   list up front. `getPostsForFollowing` only drops followed ids whose
 *   users row is flagged isTest (or a static test actor), so a followed
 *   author whose id starts with `test-` but whose users row is not
 *   flagged leaks onto the Following tab.
 *
 * - Muted authors: muting keeps the follow edge (blocking is what
 *   severs it), and the route computes the viewer's blocked/muted/
 *   blocked-by set — but it filters the page in memory *after*
 *   `getPostsForFollowing` has already spent the SQL `LIMIT` on the
 *   newest posts, which are the muted author's. The web Following tab
 *   fetches a single page (`limit=20&offset=0`) with no load-more, so
 *   visible posts behind a muted author's newest posts never reach
 *   the tab at all. #1712 makes the same before-paging fix for the
 *   main feed branches; the Following branch returns before that code.
 *
 * Fixture: the viewer follows a normal author (3 visible posts, plus
 * future-dated and soft-deleted controls), a `test-`-prefixed author
 * (users row present, isTest false), an isTest-flagged author, and a
 * muted author holding the three newest posts.
 *
 * The real route and database run against PostgreSQL with a
 * short-lived synthetic Steward JWT (the route's real session path).
 * Only the server-only environment marker is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  CACHE_KEYS,
  getCache,
  invalidateCache,
  invalidateCachePattern,
  resetRateLimit,
} from '@feed/api';
import {
  and,
  db,
  eq,
  follows,
  inArray,
  posts,
  userActorFollows,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type FollowingResponse = {
  success: boolean;
  posts: Array<{ id: string; timestamp: string }>;
  source?: string;
  nextCursor?: string | null;
};

let viewerId: string;
let normalId: string;
let prefixedId: string;
let flaggedId: string;
let mutedId: string;
let token: string;
const visibleIds: string[] = []; // normal author's posts, newest first
const hiddenIds: string[] = []; // must never appear on any page
const mutedPostIds: string[] = [];
type OwnedRows = { postIds: string[]; userIds: string[] };
const owned: OwnedRows = { postIds: [], userIds: [] };
const allPostIds = owned.postIds;
let clientIp: string;

async function signToken(userId: string) {
  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  return new SignJWT({ userId: `f102-${userId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

async function createViewer(scope = owned) {
  const userId = await generateSnowflakeId();
  await insertOwnedUsers(
    [
      {
        id: userId,
        username: `f102-${userId}`,
        displayName: 'Following control',
        stewardId: `f102-${userId}`,
        updatedAt: new Date(),
      },
    ],
    scope
  );
  return { userId, token: await signToken(userId) };
}

async function follow(viewer: string, author: string) {
  await db.insert(follows).values({
    id: await generateSnowflakeId(),
    followerId: viewer,
    followingId: author,
    createdAt: new Date(),
  });
}

async function moderate(
  kind: 'mute' | 'block',
  caller: { token: string },
  target: string,
  action: 'mute' | 'unmute' | 'block' | 'unblock'
) {
  const route =
    kind === 'mute'
      ? await import('../../../apps/web/src/app/api/users/[userId]/mute/route')
      : await import(
          '../../../apps/web/src/app/api/users/[userId]/block/route'
        );
  const response = await route.POST(
    new NextRequest(`http://localhost/api/users/${target}/${kind}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${caller.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ userId: target }) }
  );
  expect(response.status).toBe(200);
}

async function insertOwnedUsers(
  values: (typeof users.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  scope.userIds.push(...rows.map(({ id }) => id));
}

async function insertOwnedPost(
  value: typeof posts.$inferInsert,
  scope = owned
) {
  const [row] = await db
    .insert(posts)
    .values(value)
    .returning({ id: posts.id });
  if (!row) throw new Error('Post insert returned no ownership');
  scope.postIds.push(row.id);
  return row.id;
}

async function cleanup(scope: OwnedRows) {
  if (scope.userIds.length > 0) {
    // Owner-wide relation cleanup is guarded by successful User ownership.
    await db.delete(userMutes).where(inArray(userMutes.muterId, scope.userIds));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, scope.userIds));
    await db.delete(follows).where(inArray(follows.followerId, scope.userIds));
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.userId, scope.userIds));
    for (const id of scope.userIds) {
      await invalidateCache(`follows:${id}`, { namespace: 'user:follows' });
      await invalidateCachePattern(`${id}:*`, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      });
      await invalidateCachePattern(`${id}:*`, {
        namespace: CACHE_KEYS.POSTS_BY_ACTOR,
      });
      await resetRateLimit(id, 'public_read_authed');
    }
  }
  if (scope.postIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, scope.postIds));
    expect(
      await db
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, scope.postIds))
    ).toHaveLength(0);
  }
  if (scope.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, scope.userIds));
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, scope.userIds))
    ).toHaveLength(0);
  }
  if (scope === owned && scope.userIds.includes(viewerId) && clientIp) {
    await resetRateLimit(clientIp, 'public_read');
  }
}

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/route';

async function fetchFollowingPage(
  limit: number,
  cursor?: string,
  caller = { userId: viewerId, token },
  requestedUserId = caller.userId,
  actorId?: string
) {
  const params = new URLSearchParams({
    following: 'true',
    userId: requestedUserId,
    limit: String(limit),
  });
  if (cursor !== undefined) params.set('cursor', cursor);
  if (actorId) params.set('actorId', actorId);
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?${params.toString()}`, {
      headers: {
        ...(caller.token ? { authorization: `Bearer ${caller.token}` } : {}),
        'x-forwarded-for': clientIp,
      },
    })
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FollowingResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body: body as FollowingResponse };
}

/**
 * Page through the feed the way a client does: resume with the
 * response's nextCursor when present, otherwise the last post's
 * timestamp. Returns every post id seen, in page order.
 */
async function traverseFollowingFeed(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { status, body } = await fetchFollowingPage(limit, cursor);
    expect(status).toBe(200);
    const posts = body.posts ?? [];
    seen.push(...posts.map((p) => p.id));
    if (posts.length < limit) break;
    const last = posts[posts.length - 1];
    if (!last) break;
    cursor = body.nextCursor ?? last.timestamp;
  }
  return seen;
}

async function followingIds(caller = { userId: viewerId, token }, limit = 2) {
  const { status, body } = await fetchFollowingPage(limit, undefined, caller);
  expect(status).toBe(200);
  expect(body.source).toBe('following');
  return body.posts.map(({ id }) => id);
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  viewerId = await generateSnowflakeId();
  normalId = await generateSnowflakeId();
  prefixedId = `test-f102-${await generateSnowflakeId()}`;
  flaggedId = await generateSnowflakeId();
  mutedId = await generateSnowflakeId();

  token = await signToken(viewerId);

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  const stamp = new Date(now);

  await insertOwnedUsers([
    {
      id: viewerId,
      username: `f102v-${viewerId}`,
      displayName: 'Following Visibility Viewer',
      stewardId: `f102-${viewerId}`,
      updatedAt: stamp,
    },
    {
      id: normalId,
      username: `f102n-${normalId}`,
      displayName: 'Following Visibility Normal Author',
      updatedAt: stamp,
    },
    {
      // The #1670 'prefixed' shape: a real users row whose id starts
      // with 'test-' but that is NOT flagged isTest.
      id: prefixedId,
      username: `f102p-${prefixedId}`,
      displayName: 'Following Visibility Prefixed Author',
      isTest: false,
      updatedAt: stamp,
    },
    {
      id: flaggedId,
      username: `f102f-${flaggedId}`,
      displayName: 'Following Visibility Flagged Author',
      isTest: true,
      updatedAt: stamp,
    },
    {
      id: mutedId,
      username: `f102m-${mutedId}`,
      displayName: 'Following Visibility Muted Author',
      updatedAt: stamp,
    },
  ]);
  clientIp = `2001:db8:${viewerId.slice(-8, -4)}:${viewerId.slice(-4)}::f102`;

  await db.insert(follows).values(
    await Promise.all(
      [normalId, prefixedId, flaggedId, mutedId].map(async (followingId) => ({
        id: await generateSnowflakeId(),
        followerId: viewerId,
        followingId,
        createdAt: at(120),
      }))
    )
  );

  // Muting keeps the follow edge; the muted author's posts must be
  // excluded when the page is cut, not after.
  await db.insert(userMutes).values({
    id: await generateSnowflakeId(),
    muterId: viewerId,
    mutedId,
  });

  const defs: Array<{
    author: string;
    minAgo: number;
    visible: boolean;
    deleted?: boolean;
  }> = [
    { author: mutedId, minAgo: 5, visible: false },
    { author: mutedId, minAgo: 8, visible: false },
    { author: prefixedId, minAgo: 10, visible: false },
    { author: mutedId, minAgo: 12, visible: false },
    { author: flaggedId, minAgo: 15, visible: false },
    { author: normalId, minAgo: -10, visible: false }, // future control
    { author: normalId, minAgo: 20, visible: false, deleted: true },
    { author: normalId, minAgo: 50, visible: true },
    { author: normalId, minAgo: 60, visible: true },
    { author: normalId, minAgo: 70, visible: true },
  ];
  for (const def of defs) {
    const id = await generateSnowflakeId();
    await insertOwnedPost({
      id,
      content: `following visibility fixture ${id}`,
      authorId: def.author,
      type: 'post',
      timestamp: at(def.minAgo),
      createdAt: at(def.minAgo),
      deletedAt: def.deleted ? at(1) : null,
    });
    if (def.visible) visibleIds.push(id);
    else hiddenIds.push(id);
    if (def.author === mutedId) mutedPostIds.push(id);
  }
});

afterAll(() => cleanup(owned));

describe('GET /api/posts?following=true author exclusions', () => {
  it('shows only the normal author on a full page: no test-prefixed, flagged, muted, future or deleted posts', async () => {
    const { status, body } = await fetchFollowingPage(10);
    expect(status).toBe(200);
    expect(body.source).toBe('following');
    expect(body.posts.map((p) => p.id)).toEqual(visibleIds);
  });

  it('fills the first page with visible posts when a muted author holds the newest posts', async () => {
    const { status, body } = await fetchFollowingPage(2);
    expect(status).toBe(200);
    expect(body.posts.map((p) => p.id)).toEqual(visibleIds.slice(0, 2));
  });

  it('reaches every visible post exactly once when paged to the end', async () => {
    const seen = await traverseFollowingFeed(2);
    expect(seen).toEqual(visibleIds);
  });

  it('guard: future, deleted and isTest-flagged posts stay hidden', async () => {
    const { status, body } = await fetchFollowingPage(10);
    expect(status).toBe(200);
    const ids = body.posts.map((p) => p.id);
    // Controls that already pass on the base: the isTest-flagged,
    // future-dated and soft-deleted posts, and the muted author's
    // newest post (removed by the route's post-page filter when the
    // page is large enough to reach past it).
    expect(ids).not.toContain(allPostIds[4]!); // flagged
    expect(ids).not.toContain(allPostIds[5]!); // future
    expect(ids).not.toContain(allPostIds[6]!); // deleted
    expect(ids).not.toContain(allPostIds[0]!); // muted newest
  });

  it('changes a warm page on actual unmute/mute requests without changing another viewer', async () => {
    const observer = await createViewer();
    await follow(observer.userId, normalId);
    await follow(observer.userId, mutedId);
    expect(await followingIds()).toEqual(visibleIds.slice(0, 2));
    expect(await followingIds(observer)).toEqual(mutedPostIds.slice(0, 2));
    try {
      await moderate('mute', { token }, mutedId, 'unmute');
      expect(await followingIds()).toEqual(mutedPostIds.slice(0, 2));
      await moderate('mute', { token }, mutedId, 'mute');
      expect(await followingIds()).toEqual(visibleIds.slice(0, 2));
      expect(await followingIds(observer)).toEqual(mutedPostIds.slice(0, 2));
    } finally {
      const rows = await db
        .select({ id: userMutes.id })
        .from(userMutes)
        .where(
          and(eq(userMutes.muterId, viewerId), eq(userMutes.mutedId, mutedId))
        );
      if (rows.length === 0) await moderate('mute', { token }, mutedId, 'mute');
    }
  });

  for (const reverse of [false, true]) {
    it(`fills a warm page after an actual ${reverse ? 'reverse' : 'outgoing'} block`, async () => {
      const reader = await createViewer();
      const author = await createViewer();
      const fallback = await createViewer();
      const observer = await createViewer();
      for (const caller of [reader, observer]) {
        await follow(caller.userId, author.userId);
        await follow(caller.userId, fallback.userId);
      }
      const ids: string[] = [];
      const now = Date.now();
      for (const [index, authorId] of [
        author.userId,
        author.userId,
        fallback.userId,
        fallback.userId,
      ].entries()) {
        ids.push(
          await insertOwnedPost({
            id: await generateSnowflakeId(),
            authorId,
            content: 'block transition fixture',
            timestamp: new Date(now - (index + 1) * 60_000),
            type: 'post',
          })
        );
      }
      expect(await followingIds(reader)).toEqual(ids.slice(0, 2));
      expect(await followingIds(observer)).toEqual(ids.slice(0, 2));
      await moderate(
        'block',
        reverse ? author : reader,
        reverse ? reader.userId : author.userId,
        'block'
      );
      expect(await followingIds(reader)).toEqual(ids.slice(2));
      expect(await followingIds(observer)).toEqual(ids.slice(0, 2));
    });
  }

  it('keeps a real registry NPC and handles empty and all-excluded follow sets', async () => {
    const actor = StaticDataRegistry.getAllActors().find(
      (item) => !item.isTest && !item.id.startsWith('test-')
    );
    if (!actor) throw new Error('No retained registry NPC is available');
    const npcViewer = await createViewer();
    await db.insert(userActorFollows).values({
      id: await generateSnowflakeId(),
      userId: npcViewer.userId,
      actorId: actor.id,
    });
    const npcPost = await insertOwnedPost({
      id: await generateSnowflakeId(),
      authorId: actor.id,
      content: 'retained NPC following control',
      timestamp: new Date(Date.now() - 1000),
      type: 'post',
    });
    expect(await followingIds(npcViewer)).toEqual([npcPost]);
    const empty = await createViewer();
    expect(await followingIds(empty)).toEqual([]);
    const excluded = await createViewer();
    await follow(excluded.userId, prefixedId);
    await follow(excluded.userId, flaggedId);
    expect(await followingIds(excluded)).toEqual([]);
  });

  it('keeps the existing public fallback for missing/invalid credentials and a mismatched viewer', async () => {
    const other = await createViewer();
    for (const caller of [
      { userId: viewerId, token: '' },
      { userId: viewerId, token: 'invalid-token' },
      other,
    ]) {
      // An owned author scopes the public fallback's cache, avoiding shared
      // global-feed keys. This asserts the existing fallback, not a new 401.
      const { status, body } = await fetchFollowingPage(
        2,
        undefined,
        caller,
        viewerId,
        normalId
      );
      expect(status).toBe(200);
      expect(body.source).not.toBe('following');
    }
  });

  it('preserves a colliding sentinel and its cache after partial setup cleanup', async () => {
    const existing: OwnedRows = { postIds: [], userIds: [] };
    const attempted: OwnedRows = { postIds: [], userIds: [] };
    try {
      const sentinel = await createViewer(existing);
      const postId = await insertOwnedPost(
        {
          id: await generateSnowflakeId(),
          authorId: sentinel.userId,
          content: 'collision sentinel',
          timestamp: new Date(Date.now() - 1000),
          type: 'post',
        },
        existing
      );
      await follow(sentinel.userId, normalId);
      await db.insert(userMutes).values({
        id: await generateSnowflakeId(),
        muterId: sentinel.userId,
        mutedId,
      });
      expect(await followingIds(sentinel)).toEqual(visibleIds.slice(0, 2));
      const cacheKey = `${sentinel.userId}:2:offset:0:excl:${mutedId}`;
      const cached = await getCache<Array<{ id: string }>>(cacheKey, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      });
      expect(cached).not.toBeNull();
      const readSentinel = async () => ({
        users: await db
          .select()
          .from(users)
          .where(eq(users.id, sentinel.userId)),
        posts: await db.select().from(posts).where(eq(posts.id, postId)),
        follows: await db
          .select()
          .from(follows)
          .where(eq(follows.followerId, sentinel.userId)),
        mutes: await db
          .select()
          .from(userMutes)
          .where(eq(userMutes.muterId, sentinel.userId)),
      });
      const before = await readSentinel();
      await expect(
        insertOwnedUsers(
          [
            {
              id: sentinel.userId,
              username: `collision-${sentinel.userId}`,
              updatedAt: new Date(),
            },
          ],
          attempted
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      const partial = await createViewer(attempted);
      await insertOwnedPost(
        {
          id: await generateSnowflakeId(),
          authorId: partial.userId,
          content: 'partial fixture',
          timestamp: new Date(),
        },
        attempted
      );
      await expect(
        insertOwnedPost(
          {
            id: postId,
            authorId: partial.userId,
            content: 'collision',
            timestamp: new Date(),
          },
          attempted
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await cleanup(attempted);
      expect(await readSentinel()).toEqual(before);
      expect(
        await getCache<Array<{ id: string }>>(cacheKey, {
          namespace: CACHE_KEYS.POSTS_FOLLOWING,
        })
      ).toEqual(cached);
    } finally {
      await cleanup(attempted);
      await cleanup(existing);
    }
  });
});
