/** Bilateral post-author blocks apply to both reply routes. PRD §12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  authorBlock: 'rejects replies when the post author blocked the replier',
  replierBlock: 'rejects replies when the replier blocked the post author',
  allowed: 'allows nonblocked replies and preserves the post-author-only rule',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the reply block policy on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'comment-reply-block-policy',
      file: 'packages/testing/integration/comment-reply-block-bypass.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { comments, dbWrite, eq, posts, userBlocks, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { POST: commentReply } = await import(
    '../../../apps/web/src/app/api/comments/[id]/replies/route'
  );
  const { POST: postComment } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();

  async function user() {
    const id = await generateSnowflakeId();
    const stewardId = `reply-block-${id}`;
    await dbWrite.insert(users).values({
      id,
      stewardId,
      username: stewardId,
      updatedAt: now,
    });
    return { id, stewardId };
  }

  async function thread() {
    const postAuthor = await user();
    const commentAuthor = await user();
    const replier = await user();
    const postId = await generateSnowflakeId();
    const parentId = await generateSnowflakeId();
    await dbWrite.transaction(async (tx) => {
      await tx.insert(posts).values({
        id: postId,
        authorId: postAuthor.id,
        content: 'Disposable reply fixture',
        timestamp: new Date(now.getTime() - 1000),
      });
      await tx.insert(comments).values({
        id: parentId,
        postId,
        authorId: commentAuthor.id,
        content: 'Fixture parent comment',
        updatedAt: now,
      });
    });
    return { postAuthor, commentAuthor, replier, postId, parentId };
  }

  async function block(blockerId: string, blockedId: string) {
    await dbWrite.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId,
      blockedId,
    });
  }

  type Thread = Awaited<ReturnType<typeof thread>>;

  async function request(path: string, fixture: Thread, body: object) {
    return new NextRequest(`http://localhost/api/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await createStewardTestToken(fixture.replier.stewardId)}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function reply(fixture: Thread) {
    return commentReply(
      await request(`comments/${fixture.parentId}/replies`, fixture, {
        content: 'Signed fixture reply',
      }),
      { params: Promise.resolve({ id: fixture.parentId }) }
    );
  }

  function storedReplies(fixture: Thread) {
    return dbWrite
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.parentCommentId, fixture.parentId));
  }

  async function expectBlocked(fixture: Thread) {
    const responses = [
      await reply(fixture),
      await postComment(
        await request(`posts/${fixture.postId}/comments`, fixture, {
          content: 'Signed fixture reply through the post route',
          parentCommentId: fixture.parentId,
        }),
        { params: Promise.resolve({ id: fixture.postId }) }
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Cannot comment on this post',
      });
    }
    expect(await storedReplies(fixture)).toEqual([]);
  }

  test(cases.authorBlock, async () => {
    const fixture = await thread();
    await block(fixture.postAuthor.id, fixture.replier.id);
    await expectBlocked(fixture);
  });

  test(cases.replierBlock, async () => {
    const fixture = await thread();
    await block(fixture.replier.id, fixture.postAuthor.id);
    await expectBlocked(fixture);
  });

  test(cases.allowed, async () => {
    const unblocked = await thread();
    const parentOnly = await thread();
    await block(parentOnly.commentAuthor.id, parentOnly.replier.id);
    await block(parentOnly.replier.id, parentOnly.commentAuthor.id);
    for (const fixture of [unblocked, parentOnly]) {
      const response = await reply(fixture);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        postId: fixture.postId,
        parentCommentId: fixture.parentId,
        authorId: fixture.replier.id,
      });
      expect(await storedReplies(fixture)).toEqual([
        { authorId: fixture.replier.id },
      ]);
    }
  });
}
