/** Grandparent-author moderation in post comments. PRD §12, MVP Phase 5.
 * #1976 applied the bilateral block rule to the immediate parent author
 * only: a reply nested under a depth-1 reply (parentCommentId pointing at a
 * reply) is never checked against the grandparent author, so a replier a
 * thread ancestor blocked can still nest a reply inside that thread. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  incoming:
    'refuses a nested reply when the grandparent author blocked the replier',
  outgoing:
    'refuses a nested reply when the replier blocked the grandparent author',
  allowed:
    'publishes a nested reply under an unblocked grandparent for another reader',
  depthOne:
    'preserves the immediate-parent rule for a direct reply to a blocking author',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks grandparent-author moderation on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'top-comment-reply-grandparent-block',
      file: 'packages/testing/integration/top-comment-reply-grandparent-block.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { and, comments, dbWrite, eq, posts, userBlocks, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET, POST } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );

  const now = new Date();
  async function createUser(role: string) {
    const id = await generateSnowflakeId();
    const stewardId = `comment-grandparent-${role}`;
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
  const middleIncoming = await createUser('middle-incoming');
  const middleOutgoing = await createUser('middle-outgoing');
  const neutralGrandparent = await createUser('neutral-grandparent');
  const neutralMiddle = await createUser('neutral-middle');
  const reader = await createUser('reader');
  const postId = await generateSnowflakeId();
  const grandparents = {
    incoming: await generateSnowflakeId(),
    outgoing: await generateSnowflakeId(),
    allowed: await generateSnowflakeId(),
  };
  const middles = {
    incoming: await generateSnowflakeId(),
    outgoing: await generateSnowflakeId(),
    allowed: await generateSnowflakeId(),
  };
  await dbWrite.transaction(async (tx) => {
    await tx.insert(posts).values([
      {
        id: postId,
        authorId: owner.id,
        content: 'Post with nested comment thread',
        timestamp: now,
      },
    ]);
    await tx.insert(comments).values([
      {
        id: grandparents.incoming,
        authorId: blocking.id,
        content: 'Grandparent comment',
        postId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: middles.incoming,
        authorId: middleIncoming.id,
        content: 'Depth-1 reply',
        postId,
        parentCommentId: grandparents.incoming,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: grandparents.outgoing,
        authorId: blocked.id,
        content: 'Grandparent comment',
        postId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: middles.outgoing,
        authorId: middleOutgoing.id,
        content: 'Depth-1 reply',
        postId,
        parentCommentId: grandparents.outgoing,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: grandparents.allowed,
        authorId: neutralGrandparent.id,
        content: 'Grandparent comment',
        postId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: middles.allowed,
        authorId: neutralMiddle.id,
        content: 'Depth-1 reply',
        postId,
        parentCommentId: grandparents.allowed,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await tx.insert(userBlocks).values([
      { id: 'incoming', blockerId: blocking.id, blockedId: replier.id },
      { id: 'outgoing', blockerId: replier.id, blockedId: blocked.id },
    ]);
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
      const middleId = middles[direction];
      const response = await createComment(
        postId,
        `${direction} nested reply`,
        middleId
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
              eq(comments.parentCommentId, middleId)
            )
          )
      ).toEqual([]);
    });
  }

  test(cases.allowed, async () => {
    const response = await createComment(
      postId,
      'Nested reply under unblocked grandparent',
      middles.allowed
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
            id: grandparents.allowed,
            replies: [
              expect.objectContaining({
                id: middles.allowed,
                replies: [
                  expect.objectContaining({
                    id: reply.id,
                    userId: replier.id,
                  }),
                ],
              }),
            ],
          }),
        ]),
      },
    });
  });

  test(cases.depthOne, async () => {
    const response = await createComment(
      postId,
      'Direct reply to blocking grandparent',
      grandparents.incoming
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Cannot comment on this post',
    });
  });
}
