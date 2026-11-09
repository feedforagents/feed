/**
 * Actor profile post list (GET /api/posts?actorId=...) against a real
 * database and a real Redis cache: a post the author deletes, or an admin
 * hides through the moderation content queue, must disappear from the
 * author's profile list immediately. Sibling mutations (create, share)
 * invalidate the posts:actor cache; the profile list is served from that
 * cache with a 180s TTL.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

// The route modules import the `server-only` marker package, which throws
// outside a Server Component; stub it like the sibling route suites do.
// The cache layer only initializes Redis outside NODE_ENV=test, so flip to
// development before the route modules load (the dev auth bypass and every
// code path exercised here behave the same in both modes).
mock.module('server-only', () => ({}));

let authorA: string;
let authorB: string;
let adminId: string;
const userIds: string[] = [];
const postIds: string[] = [];

let aOld: string;
let aMid: string;
let aNew: string;
let bOld: string;
let bNew: string;
let aFuture: string;
let aDeleted: string;

type PostsResponse = { posts?: Array<{ id: string }> };

let listGET: typeof import('../../../apps/web/src/app/api/posts/route').GET;
let postDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/route').DELETE;
let queuePOST: typeof import('../../../apps/web/src/app/api/admin/content-queue/[contentId]/route').POST;

async function fetchActorPostIds(actorId: string): Promise<string[]> {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?actorId=${actorId}&limit=100`)
  );
  const response = await listGET(request);
  const body = (await response
    .json()
    .catch(() => null)) as PostsResponse | null;
  return (body?.posts ?? []).map((p) => p.id);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'development';
  const { ensureRedisReady, isRedisAvailable } = await import('@feed/api');
  ({ GET: listGET } = await import(
    '../../../apps/web/src/app/api/posts/route'
  ));
  await ensureRedisReady();
  if (!isRedisAvailable()) {
    throw new Error('Redis must be available for the cache freshness suite');
  }
  ({ DELETE: postDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));
  ({ POST: queuePOST } = await import(
    '../../../apps/web/src/app/api/admin/content-queue/[contentId]/route'
  ));

  [authorA, authorB, adminId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  userIds.push(authorA, authorB, adminId);
  await db.insert(users).values([
    {
      id: authorA,
      username: `f118a_${authorA.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    },
    {
      id: authorB,
      username: `f118b_${authorB.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    },
    {
      id: adminId,
      username: `f118adm_${adminId.slice(-10)}`,
      isActor: false,
      isAdmin: true,
      updatedAt: new Date(),
    },
  ]);

  [aOld, aMid, aNew, bOld, bNew, aFuture, aDeleted] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  postIds.push(aOld, aMid, aNew, bOld, bNew, aFuture, aDeleted);

  const now = Date.now();
  const insert = (
    id: string,
    authorId: string,
    offsetMs: number,
    deletedAt: Date | null = null
  ) =>
    db.insert(posts).values({
      id,
      content: `f118 post ${id}`,
      authorId,
      timestamp: new Date(now + offsetMs),
      deletedAt,
    });

  await insert(aOld, authorA, -180_000);
  await insert(aMid, authorA, -120_000);
  await insert(aNew, authorA, -60_000);
  await insert(aFuture, authorA, 3_600_000);
  await insert(aDeleted, authorA, -30_000, new Date());
  await insert(bOld, authorB, -120_000);
  await insert(bNew, authorB, -60_000);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('actor profile post list moderation freshness (real database + cache)', () => {
  it('serves the visible posts newest first (guard)', async () => {
    const ids = await fetchActorPostIds(authorA);
    expect(ids).toEqual([aNew, aMid, aOld]);
  });

  it('removes an author-deleted post from the profile list at once', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/posts/${aMid}`, { method: 'DELETE' }),
      { headers: { 'x-dev-user-id': authorA } }
    );
    const response = await postDELETE(request, {
      params: Promise.resolve({ id: aMid }),
    });
    expect(response.status).toBe(200);

    const ids = await fetchActorPostIds(authorA);
    expect(ids).toEqual([aNew, aOld]);
  });

  it('removes an admin-hidden post from the profile list at once', async () => {
    const warm = await fetchActorPostIds(authorB);
    expect(warm).toEqual([bNew, bOld]);

    const request = new NextRequest(
      new Request(`http://localhost/api/admin/content-queue/${bOld}`, {
        method: 'POST',
        headers: { 'x-dev-user-id': adminId },
        body: JSON.stringify({ action: 'hide', contentType: 'post' }),
      })
    );
    const response = await queuePOST(request, {
      params: Promise.resolve({ contentId: bOld }),
    });
    expect(response.status).toBe(200);

    const ids = await fetchActorPostIds(authorB);
    expect(ids).toEqual([bNew]);
  });
});
