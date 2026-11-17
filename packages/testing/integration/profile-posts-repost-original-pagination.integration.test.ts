/**
 * GET /api/users/[userId]/posts?type=posts must exclude simple reposts of
 * non-exposable originals in SQL, before the page is cut — not in an
 * in-memory filter after LIMIT/OFFSET.
 *
 * The F15 fix (d4f880e7b) filtered in memory: a page whose SQL rows
 * included hidden reposts came back short, so a client paging until a
 * short page would stop early and miss later visible posts (and `total`,
 * which is the page length, was wrong too). The deleted-original case
 * already excludes in SQL for exactly this reason ("otherwise they would
 * take up rows of a page"); this test pins the same behaviour for the
 * viewer-moderation case.
 *
 * Fixture (owner rows, newest first): V1 own, H1 hidden repost (blocked
 * original), V2 own, H2 hidden repost (blocked original), V3 own,
 * Q1 quote of blocked original (row kept, original null), V4 own,
 * R1 repost of a normal original. Viewer-visible order: V1, V2, V3,
 * Q1, V4, R1.
 *
 * Real DB, real route handler, no mocks.
 *
 * Run with: DISABLE_RATE_LIMITING=true STEWARD_JWT_SECRET=<any non-empty value>
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f15r2
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f15r2
 *   TZ=UTC bun test integration/profile-posts-repost-original-pagination.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDatabase, db, inArray, posts, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

let POSTS_GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

const webBearer = async (userId: string) =>
  `Bearer ${await createStewardTestToken(userId)}`;

const OWNER = 'f15pg-owner';
const VIEWER = 'f15pg-viewer';
const NORMAL = 'f15pg-normal';
const BLOCKED = 'f15pg-blocked';

const postIds: string[] = [];
const blockIds: string[] = [];

// Row ids, so tests can find their row by id instead of by position.
let V1 = '';
let H1 = '';
let V2 = '';
let H2 = '';
let V3 = '';
let Q1 = '';
let V4 = '';
let R1 = '';

type PostItem = {
  id: string;
  content: string;
  authorId: string;
  isRepost?: boolean;
  isQuote?: boolean;
  originalPostId?: string | null;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
  } | null;
};
type PostsResponse = { type: string; total: number; items: PostItem[] };

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    stewardId: id,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertPost(
  id: string,
  authorId: string,
  content: string,
  originalPostId: string | null,
  at: Date
) {
  await db.insert(posts).values({
    id,
    content,
    authorId,
    originalPostId,
    timestamp: at,
    createdAt: at,
  });
  postIds.push(id);
}

async function insertBlock(blockerId: string, blockedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
    createdAt: new Date(),
  });
  blockIds.push(id);
}

async function callPosts(
  viewerId: string | null,
  page: number,
  limit: number
): Promise<{ status: number; items: PostItem[]; total: number }> {
  const headers: Record<string, string> = {};
  if (viewerId) headers.authorization = await webBearer(viewerId);
  const request = new NextRequest(
    new Request(
      `http://localhost/api/users/${OWNER}/posts?type=posts&page=${page}&limit=${limit}`,
      { method: 'GET', headers }
    )
  );
  const response = await POSTS_GET(request, {
    params: Promise.resolve({ userId: OWNER }),
  });
  const payload = (await response.json().catch(() => null)) as
    | ({
        data?: PostsResponse;
      } & PostsResponse)
    | null;
  const data = payload?.data ?? payload;
  return {
    status: response.status,
    items: (data as PostsResponse)?.items ?? [],
    total: (data as PostsResponse)?.total ?? -1,
  };
}

describe('profile posts repost original pagination', () => {
  beforeAll(async () => {
    ({ GET: POSTS_GET } = await import(
      '../../../apps/web/src/app/api/users/[userId]/posts/route'
    ));
    for (const id of [OWNER, VIEWER, NORMAL, BLOCKED]) {
      await insertUser(id);
    }

    const now = new Date();
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
    const earlier = new Date(now.getTime() - 3_600_000);

    const [postNormal, postBlocked] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    await insertPost(
      postNormal,
      NORMAL,
      'f15pg original by normal',
      null,
      earlier
    );
    await insertPost(
      postBlocked,
      BLOCKED,
      'f15pg original by blocked',
      null,
      earlier
    );

    [V1, H1, V2, H2, V3, Q1, V4, R1] = await Promise.all(
      Array.from({ length: 8 }, () => generateSnowflakeId())
    );
    await insertPost(V1, OWNER, 'f15pg own post 1', null, at(-10));
    await insertPost(H1, OWNER, '', postBlocked, at(-20));
    await insertPost(V2, OWNER, 'f15pg own post 2', null, at(-30));
    await insertPost(H2, OWNER, '', postBlocked, at(-40));
    await insertPost(V3, OWNER, 'f15pg own post 3', null, at(-50));
    await insertPost(Q1, OWNER, 'f15pg quote of blocked', postBlocked, at(-60));
    await insertPost(V4, OWNER, 'f15pg own post 4', null, at(-70));
    await insertPost(R1, OWNER, '', postNormal, at(-80));

    // Viewer blocked BLOCKED.
    await insertBlock(VIEWER, BLOCKED);
  });

  afterAll(async () => {
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db
      .delete(users)
      .where(inArray(users.id, [OWNER, VIEWER, NORMAL, BLOCKED]));
    await closeDatabase();
  });

  it('viewer: hidden reposts do not consume page slots', async () => {
    const page1 = await callPosts(VIEWER, 1, 2);
    expect(page1.status).toEqual(200);
    expect(page1.items.map((row) => row.id)).toEqual([V1, V2]);
    expect(page1.total).toEqual(2);

    const page2 = await callPosts(VIEWER, 2, 2);
    expect(page2.items.map((row) => row.id)).toEqual([V3, Q1]);
    expect(page2.total).toEqual(2);

    const page3 = await callPosts(VIEWER, 3, 2);
    expect(page3.items.map((row) => row.id)).toEqual([V4, R1]);
    expect(page3.total).toEqual(2);

    const page4 = await callPosts(VIEWER, 4, 2);
    expect(page4.items).toEqual([]);
    expect(page4.total).toEqual(0);
  });

  it('viewer: paging through limit=1 visits every visible row exactly once', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 6; page++) {
      const { items } = await callPosts(VIEWER, page, 1);
      expect(items).toHaveLength(1);
      seen.push(items[0]!.id);
    }
    expect(seen).toEqual([V1, V2, V3, Q1, V4, R1]);
    const pastEnd = await callPosts(VIEWER, 7, 1);
    expect(pastEnd.items).toEqual([]);
  });

  it('viewer: quote of a blocked original keeps its row with a null original', async () => {
    const { items } = await callPosts(VIEWER, 2, 2);
    const quote = items.find((row) => row.id === Q1);
    expect(quote).toBeDefined();
    expect(quote!.isQuote).toBe(true);
    expect(quote!.originalPost).toBeNull();
  });

  it('anonymous: hidden reposts are listed and fill pages', async () => {
    const page1 = await callPosts(null, 1, 2);
    expect(page1.status).toEqual(200);
    expect(page1.items.map((row) => row.id)).toEqual([V1, H1]);
    expect(page1.total).toEqual(2);
  });
});
