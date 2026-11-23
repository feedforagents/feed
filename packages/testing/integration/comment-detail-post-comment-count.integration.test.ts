import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const anonymousCase = 'anonymous detail and list include the unmoderated tree';
const signedCase = 'signed detail and list omit excluded authors and branches';
const hiddenCase = 'anonymous detail and list omit a deleted parent branch';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs thread count cases in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'comment-detail-post-count',
      file: 'packages/testing/integration/comment-detail-post-comment-count.integration.test.ts',
      cases: [anonymousCase, signedCase, hiddenCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { comments, db, posts, userBlocks, userMutes, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: getThread } = await import(
    '../../../apps/web/src/app/api/comments/[id]/route'
  );
  const { GET: getPost } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );
  const { GET: getList } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );

  let postId: string;
  let mainCommentId: string;
  let hiddenPostId: string;
  let hiddenChildId: string;
  let token: string;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const [, api, resource, id, leaf, ...rest] = new URL(
        request.url
      ).pathname.split('/');
      if (request.method !== 'GET' || api !== 'api' || !id || rest.length) {
        return new Response(null, { status: 404 });
      }
      const context = { params: Promise.resolve({ id }) };
      if (resource === 'comments' && leaf === undefined) {
        return getThread(new NextRequest(request), context);
      }
      if (resource === 'posts' && leaf === undefined) {
        return getPost(new NextRequest(request), context);
      }
      if (resource === 'posts' && leaf === 'comments') {
        return getList(new NextRequest(request), context);
      }
      return new Response(null, { status: 404 });
    },
  });

  type CountsResponse = {
    post?: { commentCount: number };
    data?: { commentCount?: number; total?: number };
  };

  async function readCounts(
    targetPost: string,
    targetComment: string,
    signed: boolean
  ) {
    const read = async (path: string) => {
      const requestId = crypto.randomUUID();
      const headers = new Headers({ 'x-request-id': requestId });
      if (signed) headers.set('authorization', `Bearer ${token}`);
      const response = await fetch(new URL(path, server.url), { headers });
      expect(response.status).toBe(200);
      const body = (await response.json()) as CountsResponse;
      const count =
        body.post?.commentCount ?? body.data?.commentCount ?? body.data?.total;
      console.info('Comment count HTTP', {
        requestId,
        path,
        viewer: signed ? 'signed fixture viewer' : 'anonymous',
        status: response.status,
        count,
      });
      return count;
    };
    return Promise.all([
      read(`/api/comments/${targetComment}`),
      read(`/api/posts/${targetPost}`),
      read(`/api/posts/${targetPost}/comments`),
    ]);
  }

  beforeAll(async () => {
    const viewer = await generateSnowflakeId();
    const normal = await generateSnowflakeId();
    const blocked = await generateSnowflakeId();
    const muted = await generateSnowflakeId();
    const blocker = await generateSnowflakeId();
    const stewardId = `thread-count-${viewer}`;
    const now = new Date();
    const earlier = new Date(now.getTime() - 1000);
    await db.insert(users).values(
      [viewer, normal, blocked, muted, blocker].map((id) => ({
        id,
        username: `thread-count-${id}`,
        stewardId: id === viewer ? stewardId : null,
        updatedAt: now,
      }))
    );
    token = await createStewardTestToken(stewardId);
    postId = await generateSnowflakeId();
    hiddenPostId = await generateSnowflakeId();
    await db.insert(posts).values(
      [postId, hiddenPostId].map((id) => ({
        id,
        authorId: normal,
        content: 'Thread count fixture',
        createdAt: earlier,
        timestamp: earlier,
      }))
    );
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

    async function addComment(
      targetPostId: string,
      authorId: string,
      parentCommentId: string | null,
      deletedAt: Date | null = null
    ) {
      const id = await generateSnowflakeId();
      await db.insert(comments).values({
        id,
        postId: targetPostId,
        authorId,
        parentCommentId,
        content: 'Thread count fixture comment',
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt,
      });
      return id;
    }

    // Eight rows are publicly reachable. Only the root and its ordinary reply
    // remain reachable for the signed viewer.
    mainCommentId = await addComment(postId, normal, null);
    const visibleReply = await addComment(postId, normal, mainCommentId);
    const blockedReply = await addComment(postId, blocked, mainCommentId);
    await addComment(postId, blocked, visibleReply);
    await addComment(postId, normal, blockedReply);
    await addComment(postId, normal, blockedReply);
    await addComment(postId, muted, mainCommentId);
    await addComment(postId, blocker, mainCommentId);

    const hiddenParent = await addComment(hiddenPostId, normal, null, now);
    hiddenChildId = await addComment(hiddenPostId, normal, hiddenParent);
    await addComment(hiddenPostId, normal, hiddenChildId);
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test(anonymousCase, async () => {
    expect(await readCounts(postId, mainCommentId, false)).toEqual([8, 8, 8]);
  });
  test(signedCase, async () => {
    expect(await readCounts(postId, mainCommentId, true)).toEqual([2, 2, 2]);
  });
  test(hiddenCase, async () => {
    expect(await readCounts(hiddenPostId, hiddenChildId, false)).toEqual([
      0, 0, 0,
    ]);
  });
}
