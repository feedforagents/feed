/**
 * Post-list cards must count the same reachable comments as post detail.
 * Merged precedent #1994 made GET /api/posts/[id] (and the thread routes)
 * count only comments the viewer can actually reach — excluded authors and
 * replies under a soft-deleted parent are omitted. GET /api/posts still
 * reports the raw non-deleted row count on every card, so a list card can
 * promise comments the detail screen never shows.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

// Test-only signing secret shared by the fixture token and the route auth
// in this process (same convention as profile-replies-viewer-moderation).
const STEWARD_SECRET = 'dev-jwt-secret-change-in-prod';
process.env.STEWARD_JWT_SECRET ||= STEWARD_SECRET;

const latestOrphanCase =
  'anonymous latest list omits an orphaned reply the detail omits';
const followingOrphanCase =
  'following list omits an orphaned reply the detail omits';
const followingBlockedCase =
  "following list omits a blocked author's comment the detail omits";
const latestBlockedCase =
  "signed latest list omits a blocked author's comment the detail omits";

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs post-list count cases in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-list-comment-count',
      file: 'packages/testing/integration/post-list-comment-count.integration.test.ts',
      cases: [
        latestOrphanCase,
        followingOrphanCase,
        followingBlockedCase,
        latestBlockedCase,
      ],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { comments, db, follows, posts, userBlocks, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: getList } = await import(
    '../../../apps/web/src/app/api/posts/route'
  );
  const { GET: getPost } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );

  let viewerId: string;
  let authorId: string;
  let blockedId: string;
  let orphanPostId: string;
  let blockedPostId: string;
  let controlPostId: string;
  let token: string;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const [, api, resource, id, ...rest] = url.pathname.split('/');
      if (request.method !== 'GET' || api !== 'api' || rest.length) {
        return new Response(null, { status: 404 });
      }
      if (resource === 'posts' && id === undefined) {
        return getList(new NextRequest(request));
      }
      if (resource === 'posts' && id !== undefined) {
        return getPost(new NextRequest(request), {
          params: Promise.resolve({ id }),
        });
      }
      return new Response(null, { status: 404 });
    },
  });

  type ListResponse = {
    posts?: Array<{ id: string; commentCount: number }>;
  };
  type DetailResponse = {
    data?: { commentCount: number };
  };

  async function readListCount(
    targetPost: string,
    signed: boolean,
    following: boolean
  ) {
    const path = following
      ? `/api/posts?following=true&userId=${viewerId}&limit=50`
      : '/api/posts?limit=50';
    const headers = new Headers({ 'x-request-id': crypto.randomUUID() });
    if (signed) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(new URL(path, server.url), { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListResponse;
    const row = body.posts?.find((post) => post.id === targetPost);
    expect(row).toBeDefined();
    return row?.commentCount;
  }

  async function readDetailCount(targetPost: string, signed: boolean) {
    const headers = new Headers({ 'x-request-id': crypto.randomUUID() });
    if (signed) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(
      new URL(`/api/posts/${targetPost}`, server.url),
      {
        headers,
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DetailResponse;
    return body.data?.commentCount;
  }

  beforeAll(async () => {
    viewerId = await generateSnowflakeId();
    authorId = await generateSnowflakeId();
    blockedId = await generateSnowflakeId();
    const stewardId = `list-count-${viewerId}`;
    const now = new Date();
    const earlier = new Date(now.getTime() - 1000);
    await db.insert(users).values(
      [viewerId, authorId, blockedId].map((id) => ({
        id,
        username: `list-count-${id}`,
        stewardId: id === viewerId ? stewardId : null,
        updatedAt: now,
      }))
    );
    token = await createStewardTestToken(stewardId);
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: viewerId,
      followingId: authorId,
    });
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId,
    });
    orphanPostId = await generateSnowflakeId();
    blockedPostId = await generateSnowflakeId();
    controlPostId = await generateSnowflakeId();
    await db.insert(posts).values(
      [orphanPostId, blockedPostId, controlPostId].map((id) => ({
        id,
        authorId,
        content: 'List count fixture',
        createdAt: earlier,
        timestamp: earlier,
      }))
    );

    async function addComment(
      targetPostId: string,
      author: string,
      parentCommentId: string | null,
      deletedAt: Date | null = null
    ) {
      const id = await generateSnowflakeId();
      await db.insert(comments).values({
        id,
        postId: targetPostId,
        authorId: author,
        parentCommentId,
        content: 'List count fixture comment',
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt,
      });
      return id;
    }

    // Orphaned branch: the parent is soft-deleted, so its two surviving
    // replies are unreachable from the post. Raw count is 2, reachable 0.
    const orphanParent = await addComment(orphanPostId, authorId, null, now);
    const orphanChild = await addComment(orphanPostId, authorId, orphanParent);
    await addComment(orphanPostId, authorId, orphanChild);
    // Blocked author: one root comment by an author the viewer blocked.
    await addComment(blockedPostId, blockedId, null);
    // Control: one ordinary root comment, visible everywhere.
    await addComment(controlPostId, authorId, null);
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test(latestOrphanCase, async () => {
    expect(await readListCount(orphanPostId, false, false)).toBe(0);
    expect(await readDetailCount(orphanPostId, false)).toBe(0);
    expect(await readListCount(controlPostId, false, false)).toBe(1);
    expect(await readDetailCount(controlPostId, false)).toBe(1);
    // Anonymous sees the unmoderated tree: the blocked author's comment
    // counts on both surfaces.
    expect(await readListCount(blockedPostId, false, false)).toBe(1);
    expect(await readDetailCount(blockedPostId, false)).toBe(1);
  });

  test(followingOrphanCase, async () => {
    expect(await readListCount(orphanPostId, true, true)).toBe(0);
    expect(await readDetailCount(orphanPostId, true)).toBe(0);
    expect(await readListCount(controlPostId, true, true)).toBe(1);
    expect(await readDetailCount(controlPostId, true)).toBe(1);
  });

  test(followingBlockedCase, async () => {
    expect(await readListCount(blockedPostId, true, true)).toBe(0);
    expect(await readDetailCount(blockedPostId, true)).toBe(0);
  });

  test(latestBlockedCase, async () => {
    expect(await readListCount(blockedPostId, true, false)).toBe(0);
    expect(await readDetailCount(blockedPostId, true)).toBe(0);
  });
}
