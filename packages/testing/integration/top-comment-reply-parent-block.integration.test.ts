/** Parent-author moderation in post comments. PRD §12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  incoming: 'refuses a reply when the parent author blocked the replier',
  outgoing: 'refuses a reply when the replier blocked the parent author',
  allowed: 'publishes a reply to an unblocked parent for another reader',
  topLevel: 'preserves the post author rule for top-level comments',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks parent-author moderation on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'top-comment-reply-parent-block',
      file: 'packages/testing/integration/top-comment-reply-parent-block.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { and, comments, dbWrite, eq, posts, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET, POST } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );

  const now = new Date();
  async function createUser(role: string) {
    const id = await generateSnowflakeId();
    const stewardId = `comment-block-${role}`;
    await dbWrite.insert(users).values({
      id,
      username: stewardId,
      stewardId,
      updatedAt: now,
    });
    return { id, stewardId };
  }

  const owner = await createUser('owner');
  const replier = await createUser('replier');
  const blocking = await createUser('blocking');
  const blocked = await createUser('blocked');
  const muted = await createUser('muted');
  const reader = await createUser('reader');
  const postId = await generateSnowflakeId();
  const blockedPostId = await generateSnowflakeId();
  const parents = {
    incoming: await generateSnowflakeId(),
    outgoing: await generateSnowflakeId(),
    allowed: await generateSnowflakeId(),
  };
  await dbWrite.transaction(async (tx) => {
    await tx.insert(posts).values([
      {
        id: postId,
        authorId: owner.id,
        content: 'Post with comment thread',
        timestamp: now,
      },
      {
        id: blockedPostId,
        authorId: blocking.id,
        content: 'Post by the blocking author',
        timestamp: now,
      },
    ]);
    await tx.insert(comments).values(
      [
        { id: parents.incoming, authorId: blocking.id },
        { id: parents.outgoing, authorId: blocked.id },
        { id: parents.allowed, authorId: muted.id },
      ].map((parent) => ({
        ...parent,
        content: 'Parent comment',
        postId,
        createdAt: now,
        updatedAt: now,
      }))
    );
    await tx.insert(userBlocks).values([
      { id: 'incoming', blockerId: blocking.id, blockedId: replier.id },
      { id: 'outgoing', blockerId: replier.id, blockedId: blocked.id },
    ]);
    await tx.insert(userMutes).values({
      id: 'mute',
      muterId: replier.id,
      mutedId: muted.id,
    });
  });

  async function createComment(
    id: string,
    content: string,
    parentCommentId?: string
  ) {
    const token = await createStewardTestToken(replier.stewardId);
    const request = new NextRequest(
      `http://localhost/api/posts/${id}/comments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content, parentCommentId }),
      }
    );
    return POST(request, { params: Promise.resolve({ id }) });
  }

  for (const direction of ['incoming', 'outgoing'] as const) {
    test(cases[direction], async () => {
      const parentId = parents[direction];
      const response = await createComment(
        postId,
        `${direction} reply`,
        parentId
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Cannot comment on this post',
      });
      expect(
        await dbWrite
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              eq(comments.authorId, replier.id),
              eq(comments.parentCommentId, parentId)
            )
          )
      ).toEqual([]);
    });
  }

  test(cases.allowed, async () => {
    const response = await createComment(
      postId,
      'Reply to muted parent',
      parents.allowed
    );
    expect(response.status).toBe(201);
    const reply: { id: string } = await response.json();
    const token = await createStewardTestToken(reader.stewardId);
    const request = new NextRequest(
      `http://localhost/api/posts/${postId}/comments`,
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    const thread = await GET(request, {
      params: Promise.resolve({ id: postId }),
    });
    expect(thread.status).toBe(200);
    expect(await thread.json()).toMatchObject({
      data: {
        comments: expect.arrayContaining([
          expect.objectContaining({
            id: parents.allowed,
            replies: [
              expect.objectContaining({ id: reply.id, userId: replier.id }),
            ],
          }),
        ]),
      },
    });
  });

  test(cases.topLevel, async () => {
    const denied = await createComment(
      blockedPostId,
      'Comment on blocked post'
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({
      error: 'Cannot comment on this post',
    });
    const allowed = await createComment(
      postId,
      'Top-level comment on neutral post'
    );
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toMatchObject({
      postId,
      parentCommentId: null,
    });
  });
}
