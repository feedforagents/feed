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
  comments,
  db,
  eq,
  follows,
  gameOnboarding,
  inArray,
  notInArray,
  npcMarketClues,
  or,
  posts,
  sql,
  userActorFollows,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { assertDisposableAgentFollowDatabase } from './helpers/agent-follow-database';

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
function ownedRows() {
  return {
    postIds: [] as string[],
    userIds: [] as string[],
    followIds: [] as string[],
    actorFollowIds: [] as string[],
    blockIds: [] as string[],
    muteIds: [] as string[],
  };
}
type OwnedRows = ReturnType<typeof ownedRows>;
const owned = ownedRows();
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

async function follow(viewer: string, author: string, scope = owned) {
  const rows = await db
    .insert(follows)
    .values({
      id: await generateSnowflakeId(),
      followerId: viewer,
      followingId: author,
      createdAt: new Date(),
    })
    .returning({ id: follows.id });
  scope.followIds.push(...rows.map(({ id }) => id));
}

async function insertMute(muterId: string, mutedId: string, scope = owned) {
  const rows = await db
    .insert(userMutes)
    .values({ id: await generateSnowflakeId(), muterId, mutedId })
    .returning({ id: userMutes.id });
  scope.muteIds.push(...rows.map(({ id }) => id));
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
  const result: { mute?: { id: string }; block?: { id: string } } =
    await response.json();
  if (result.mute) owned.muteIds.push(result.mute.id);
  if (result.block) owned.blockIds.push(result.block.id);
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
  // One guarded transaction: lock the owned parents and refuse on any
  // foreign dependant before deleting anything, so a refusal rolls the
  // whole cleanup back instead of committing a partial deletion.
  // Cache/rate-limit side effects stay outside the transaction: no
  // network calls inside db.transaction().
  await db.transaction(async (tx) => {
    if (scope.postIds.length > 0) {
      await tx
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, scope.postIds))
        .for('update');
      // This fixture owns no comments: any comment on an owned post is
      // foreign, and deleting the post would orphan it (no physical FK).
      const [foreignComment] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(inArray(comments.postId, scope.postIds))
        .limit(1);
      if (foreignComment) {
        throw new Error('cleanup refused: foreign comment on owned post');
      }
      // Localnet's manual clue migration adds a nullable post reference.
      const [clueTable] = await tx.execute<{ present: boolean }>(
        sql`SELECT pg_catalog.to_regclass('public."NpcMarketClue"') IS NOT NULL AS present`
      );
      if (clueTable?.present) {
        const [clue] = await tx
          .select({ questionId: npcMarketClues.questionId })
          .from(npcMarketClues)
          .where(inArray(npcMarketClues.postId, scope.postIds))
          .limit(1);
        if (clue) {
          throw new Error(
            'cleanup refused: foreign clue references owned post'
          );
        }
      }
    }
    if (scope.userIds.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, scope.userIds))
        .for('update');
      // Check both cascading and nullable foreign keys and any unowned
      // following or moderation edges before deleting the fixture users.
      const dependants = await Promise.all([
        tx
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, scope.userIds))
          .limit(1),
        tx
          .select({ id: userPnLSnapshots.id })
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.userId, scope.userIds))
          .limit(1),
        tx
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(
            or(
              inArray(whitelist.userId, scope.userIds),
              inArray(whitelist.grantedBy, scope.userIds)
            )
          )
          .limit(1),
        tx
          .select({ id: whitelistConfig.id })
          .from(whitelistConfig)
          .where(inArray(whitelistConfig.updatedBy, scope.userIds))
          .limit(1),
        tx
          .select({ id: follows.id })
          .from(follows)
          .where(
            and(
              or(
                inArray(follows.followerId, scope.userIds),
                inArray(follows.followingId, scope.userIds)
              ),
              notInArray(follows.id, scope.followIds)
            )
          )
          .limit(1),
        tx
          .select({ id: userActorFollows.id })
          .from(userActorFollows)
          .where(
            and(
              inArray(userActorFollows.userId, scope.userIds),
              notInArray(userActorFollows.id, scope.actorFollowIds)
            )
          )
          .limit(1),
        tx
          .select({ id: userMutes.id })
          .from(userMutes)
          .where(
            and(
              or(
                inArray(userMutes.muterId, scope.userIds),
                inArray(userMutes.mutedId, scope.userIds)
              ),
              notInArray(userMutes.id, scope.muteIds)
            )
          )
          .limit(1),
        tx
          .select({ id: userBlocks.id })
          .from(userBlocks)
          .where(
            and(
              or(
                inArray(userBlocks.blockerId, scope.userIds),
                inArray(userBlocks.blockedId, scope.userIds)
              ),
              notInArray(userBlocks.id, scope.blockIds)
            )
          )
          .limit(1),
      ]);
      if (dependants.some((rows) => rows.length > 0)) {
        throw new Error('cleanup refused: foreign row references owned user');
      }
    }
    await tx.delete(userMutes).where(inArray(userMutes.id, scope.muteIds));
    await tx.delete(userBlocks).where(inArray(userBlocks.id, scope.blockIds));
    await tx.delete(follows).where(inArray(follows.id, scope.followIds));
    await tx
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, scope.actorFollowIds));
    if (scope.postIds.length > 0) {
      await tx.delete(posts).where(inArray(posts.id, scope.postIds));
    }
    if (scope.userIds.length > 0) {
      await tx.delete(users).where(inArray(users.id, scope.userIds));
    }
  });
  if (scope.userIds.length > 0) {
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
    expect(
      await db
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, scope.postIds))
    ).toHaveLength(0);
  }
  if (scope.userIds.length > 0) {
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
  for (const ids of Object.values(scope)) ids.length = 0;
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
  await assertDisposableAgentFollowDatabase();
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

  for (const followingId of [normalId, prefixedId, flaggedId, mutedId]) {
    await follow(viewerId, followingId);
  }

  // Muting keeps the follow edge; the muted author's posts must be
  // excluded when the page is cut, not after.
  await insertMute(viewerId, mutedId);

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
    const rows = await db
      .insert(userActorFollows)
      .values({
        id: await generateSnowflakeId(),
        userId: npcViewer.userId,
        actorId: actor.id,
      })
      .returning({ id: userActorFollows.id });
    owned.actorFollowIds.push(...rows.map(({ id }) => id));
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
    const existing = ownedRows();
    const attempted = ownedRows();
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
      await follow(sentinel.userId, normalId, existing);
      await insertMute(sentinel.userId, mutedId, existing);
      expect(await followingIds(sentinel)).toEqual(visibleIds.slice(0, 2));
      const cacheKey = `${sentinel.userId}:2:offset:0:excl:v2:${mutedId}`;
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

  it('refuses cleanup when a separately acquired onboarding row references an owned user', async () => {
    const scope = ownedRows();
    let onboardingId: string | undefined;
    try {
      const user = await createViewer(scope);
      const postId = await insertOwnedPost(
        {
          id: await generateSnowflakeId(),
          authorId: user.userId,
          content: 'refusal control',
          timestamp: new Date(),
        },
        scope
      );
      // A GameOnboarding row acquired by a separate flow for the same
      // user: deleting the user would silently remove it via
      // ON DELETE CASCADE, so the guarded cleanup must refuse instead.
      const [onboarding] = await db
        .insert(gameOnboarding)
        .values({ id: await generateSnowflakeId(), userId: user.userId })
        .returning({ id: gameOnboarding.id });
      onboardingId = onboarding?.id;
      await expect(cleanup(scope)).rejects.toThrow('cleanup refused');
      expect(
        await db.select().from(users).where(eq(users.id, user.userId))
      ).toHaveLength(1);
      expect(
        await db.select().from(posts).where(eq(posts.id, postId))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(gameOnboarding)
          .where(eq(gameOnboarding.userId, user.userId))
      ).toHaveLength(1);
    } finally {
      // Remove the foreign row directly, then the guarded cleanup can run.
      if (onboardingId) {
        await db
          .delete(gameOnboarding)
          .where(eq(gameOnboarding.id, onboardingId));
      }
      await cleanup(scope);
    }
  });

  it('preserves separately acquired follow, grant and config references', async () => {
    const scope = ownedRows();
    const user = await createViewer(scope);
    const target = await createViewer();
    const external = ownedRows();
    let grantId: string | undefined;
    let configId: string | undefined;
    try {
      await follow(user.userId, target.userId, external);
      await expect(cleanup(scope)).rejects.toThrow('cleanup refused');
      expect(
        await db
          .select()
          .from(follows)
          .where(inArray(follows.id, external.followIds))
      ).toHaveLength(1);
      await cleanup(external);

      const [grant] = await db
        .insert(whitelist)
        .values({
          id: await generateSnowflakeId(),
          userId: target.userId,
          source: 'admin_manual',
          grantedBy: user.userId,
        })
        .returning({ id: whitelist.id });
      grantId = grant?.id;
      if (!grantId) throw new Error('Grant insert returned no ownership');
      await expect(cleanup(scope)).rejects.toThrow('cleanup refused');
      expect(
        await db
          .select({ grantedBy: whitelist.grantedBy })
          .from(whitelist)
          .where(eq(whitelist.id, grantId))
      ).toEqual([{ grantedBy: user.userId }]);
      await db.delete(whitelist).where(eq(whitelist.id, grantId));
      grantId = undefined;

      const [config] = await db
        .insert(whitelistConfig)
        .values({ id: await generateSnowflakeId(), updatedBy: user.userId })
        .returning({ id: whitelistConfig.id });
      configId = config?.id;
      if (!configId) throw new Error('Config insert returned no ownership');
      await expect(cleanup(scope)).rejects.toThrow('cleanup refused');
      expect(
        await db
          .select({ updatedBy: whitelistConfig.updatedBy })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.id, configId))
      ).toEqual([{ updatedBy: user.userId }]);
    } finally {
      if (grantId) await db.delete(whitelist).where(eq(whitelist.id, grantId));
      if (configId) {
        await db
          .delete(whitelistConfig)
          .where(eq(whitelistConfig.id, configId));
      }
      await cleanup(external);
      await cleanup(scope);
    }
  });
});
