/**
 * GET /api/posts (the Latest/home post list) against a real database:
 * paging to the end must reach every post the viewer is allowed to see.
 *
 * The route used to cut each page in SQL first and only then drop posts
 * the viewer must not see — authors they blocked, muted, or were blocked
 * by — and simple reposts whose original post was deleted. The response
 * derives `hasMore` from the shortened page, so one hidden post anywhere
 * in a page reported the end of the feed and stranded every older post:
 * with a blocked, muted, and blocking author holding the three newest
 * posts, the first page came back empty with `hasMore: false` and five
 * visible posts behind it were unreachable. The hot feed applies the
 * viewer's block/mute policy before paging for the same reason, and
 * getRecentPosts already excludes test authors in SQL "before paginating,
 * so pages are full". The visibility filters belong in the page query.
 *
 * The real route handler is called directly and pages are traversed with
 * the route's own cursors, the way the Latest tab's useFeedPosts hook
 * does. Only the server-only environment marker is stubbed; viewer auth
 * is a short-lived synthetic test JWT (the same Steward pattern the
 * following-feed suite uses).
 */

import { describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { cachedDb } from '@feed/api';
import { db, eq, inArray, posts, userBlocks, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type Page = {
  success: boolean;
  posts: Array<{ id: string }>;
  cursor: string | null;
  hasMore: boolean;
};

const routePath = '../../../apps/web/src/app/api/posts/route';
const clock = Math.floor(Date.now() / 1000) * 1000;
const at = (secAgo: number) => new Date(clock - secAgo * 1000);

class Fixture {
  userIds: string[] = [];
  postIds: string[] = [];
  async user(prefix: string): Promise<string> {
    const id = await generateSnowflakeId();
    this.userIds.push(id);
    await db.insert(users).values({
      id,
      username: `${prefix}-${id}`,
      displayName: `posts feed paging ${prefix}`,
      updatedAt: new Date(),
    });
    return id;
  }
  async post(
    authorId: string,
    secAgo: number,
    extra: object = {}
  ): Promise<string> {
    const id = await generateSnowflakeId();
    this.postIds.push(id);
    await db.insert(posts).values({
      id,
      content: `posts feed paging ${id}`,
      authorId,
      type: 'post',
      timestamp: at(secAgo),
      createdAt: at(secAgo),
      ...extra,
    });
    return id;
  }
  async cleanup(): Promise<void> {
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, this.userIds));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockedId, this.userIds));
    await db.delete(userMutes).where(inArray(userMutes.muterId, this.userIds));
    if (this.postIds.length)
      await db.delete(posts).where(inArray(posts.id, this.postIds));
    if (this.userIds.length)
      await db.delete(users).where(inArray(users.id, this.userIds));
  }
}

let GET: (request: NextRequest) => Promise<Response>;

async function makeToken(viewerId: string): Promise<string> {
  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  return await new SignJWT({ userId: `pfp-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

async function fetchPage(
  limit: number,
  cursor: string | null,
  token?: string
): Promise<Page> {
  if (!GET) ({ GET } = await import(routePath));
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set('cursor', cursor);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?${q}`, { headers })
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

/** Follows the route's cursors to the end, like the Latest tab does. */
async function traverse(limit: number, token?: string): Promise<string[]> {
  await cachedDb.invalidatePostsCache();
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 12; i++) {
    const page = await fetchPage(limit, cursor, token);
    ids.push(...page.posts.map((p) => p.id));
    if (!page.hasMore) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  return ids;
}

describe('GET /api/posts paging over posts hidden from the viewer', () => {
  it('reaches every visible post when hidden authors hold the first page', async () => {
    const fx = new Fixture();
    try {
      const viewer = await fx.user('pfpv');
      await db
        .update(users)
        .set({ stewardId: `pfp-${viewer}` })
        .where(eq(users.id, viewer));
      const blocked = await fx.user('pfpb');
      const muted = await fx.user('pfpm');
      const blocker = await fx.user('pfpk');
      const author = await fx.user('pfpa');
      await db.insert(userBlocks).values([
        {
          id: await generateSnowflakeId(),
          blockerId: viewer,
          blockedId: blocked,
        },
        {
          id: await generateSnowflakeId(),
          blockerId: blocker,
          blockedId: viewer,
        },
      ]);
      await db.insert(userMutes).values({
        id: await generateSnowflakeId(),
        muterId: viewer,
        mutedId: muted,
      });
      await fx.post(blocked, 10);
      await fx.post(muted, 20);
      await fx.post(blocker, 25);
      const visible: string[] = [];
      for (const s of [30, 40, 50, 60, 70])
        visible.push(await fx.post(author, s));

      const got = await traverse(3, await makeToken(viewer));
      expect(got).toEqual(visible);
    } finally {
      await fx.cleanup();
    }
  });

  it('reaches posts past a page shortened by a hidden author mid-feed', async () => {
    const fx = new Fixture();
    try {
      const viewer = await fx.user('pfqv');
      await db
        .update(users)
        .set({ stewardId: `pfp-${viewer}` })
        .where(eq(users.id, viewer));
      const blocked = await fx.user('pfqb');
      const author = await fx.user('pfqa');
      await db.insert(userBlocks).values({
        id: await generateSnowflakeId(),
        blockerId: viewer,
        blockedId: blocked,
      });
      const visible: string[] = [];
      visible.push(await fx.post(author, 10));
      visible.push(await fx.post(author, 20));
      await fx.post(blocked, 30);
      visible.push(await fx.post(author, 40));
      visible.push(await fx.post(author, 50));
      visible.push(await fx.post(author, 60));

      const got = await traverse(2, await makeToken(viewer));
      expect(got).toEqual(visible);
    } finally {
      await fx.cleanup();
    }
  });

  it('keeps paging past a simple repost whose original was deleted, and still shows quote reposts', async () => {
    const fx = new Fixture();
    try {
      const author = await fx.user('pfra');
      const original = await fx.post(author, 500, { deletedAt: at(400) });
      const deadRepost = await fx.post(author, 10, {
        content: '',
        originalPostId: original,
      });
      const quote = await fx.post(author, 15, {
        content: 'my take on this',
        originalPostId: original,
      });
      const visible: string[] = [quote];
      for (const s of [20, 30, 40, 50]) visible.push(await fx.post(author, s));

      const got = await traverse(2);
      expect(got).toEqual(visible);
      expect(got).not.toContain(deadRepost);
    } finally {
      await fx.cleanup();
    }
  });

  it('control: reaches every post exactly once when nothing is hidden', async () => {
    const fx = new Fixture();
    try {
      const author = await fx.user('pfca');
      const ids: string[] = [];
      for (const s of [300, 290, 280, 270, 260])
        ids.push(await fx.post(author, s));
      const got = await traverse(2);
      expect(got).toEqual([...ids].reverse());
    } finally {
      await fx.cleanup();
    }
  });
});
