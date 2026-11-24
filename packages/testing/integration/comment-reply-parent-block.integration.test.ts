/**
 * Dedicated reply route parent-author blocks. PRD §12, MVP Phase 5.
 *
 * #1944 added the bilateral post-author block check to
 * POST /api/comments/[id]/replies, deliberately leaving the parent comment
 * author out ("the top-level route has no such rule"). Open #1976 adds the
 * same bidirectional parent-author check to the top-level route
 * (POST /api/posts/[id]/comments with parentCommentId) — but the dedicated
 * replies route is a second entry point for the identical action and still
 * has no parent-author check. A reply under a comment whose author blocked
 * the replier (or vice versa) is created with 201 and visible to every
 * reader of the thread, even though the sibling route refuses it.
 *
 * Mute is deliberately NOT covered: mute is read-side only across the
 * codebase (no creation path checks mute).
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=<redacted>
 *   DIRECT_DATABASE_URL=<redacted>
 *   TZ=UTC bun test integration/comment-reply-parent-block.integration.test.ts
 *   --preload ./integration/preload.ts
 */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  parentAuthorBlock:
    'refuses dedicated-route replies when the parent comment author blocked the replier',
  replierBlock:
    'refuses dedicated-route replies when the replier blocked the parent comment author',
  thirdPartySees:
    'keeps a blocked-parent reply out of the thread a third-party reader sees',
  allowed: 'allows unblocked replies through the dedicated route',
  postAuthorBlock:
    'still refuses replies when the post author blocked the replier',
  replierBlockedAuthor:
    'still refuses replies when the replier blocked the post author',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the dedicated reply parent-author block policy on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'comment-reply-parent-block-policy',
      file: 'packages/testing/integration/comment-reply-parent-block.integration.test.ts',
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
  const { GET: threadGet } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();

  async function user() {
    const id = await generateSnowflakeId();
    const stewardId = `reply-parent-block-${id}`;
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
    const reader = await user();
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
    return { postAuthor, commentAuthor, replier, reader, postId, parentId };
  }

  async function block(blockerId: string, blockedId: string) {
    await dbWrite.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId,
      blockedId,
    });
  }

  type Thread = Awaited<ReturnType<typeof thread>>;

  async function reply(fixture: Thread) {
    const request = new NextRequest(
      `http://localhost/api/comments/${fixture.parentId}/replies`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await createStewardTestToken(fixture.replier.stewardId)}`,
        },
        body: JSON.stringify({ content: 'Signed fixture reply' }),
      }
    );
    return commentReply(request, {
      params: Promise.resolve({ id: fixture.parentId }),
    });
  }

  function storedReplies(fixture: Thread) {
    return dbWrite
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.parentCommentId, fixture.parentId));
  }

  type ThreadItem = {
    id: string;
    userId: string;
    replies?: ThreadItem[];
  };

  function flattenThread(
    items: ThreadItem[],
    out: ThreadItem[] = []
  ): ThreadItem[] {
    for (const item of items) {
      out.push(item);
      if (item.replies) flattenThread(item.replies, out);
    }
    return out;
  }

  async function threadAuthorIds(fixture: Thread) {
    const request = new NextRequest(
      `http://localhost/api/posts/${fixture.postId}/comments`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${await createStewardTestToken(fixture.reader.stewardId)}`,
        },
      }
    );
    const response = await threadGet(request, {
      params: Promise.resolve({ id: fixture.postId }),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: { comments?: ThreadItem[] };
    } | null;
    return flattenThread(body?.data?.comments ?? []).map((c) => c.userId);
  }

  async function expectParentBlocked(fixture: Thread) {
    const response = await reply(fixture);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Cannot comment on this post',
    });
    expect(await storedReplies(fixture)).toEqual([]);
  }

  test(cases.parentAuthorBlock, async () => {
    const fixture = await thread();
    await block(fixture.commentAuthor.id, fixture.replier.id);
    await expectParentBlocked(fixture);
  });

  test(cases.replierBlock, async () => {
    const fixture = await thread();
    await block(fixture.replier.id, fixture.commentAuthor.id);
    await expectParentBlocked(fixture);
  });

  test(cases.thirdPartySees, async () => {
    const fixture = await thread();
    await block(fixture.commentAuthor.id, fixture.replier.id);
    await block(fixture.replier.id, fixture.commentAuthor.id);
    const response = await reply(fixture);
    expect(response.status).toBe(400);
    expect(await storedReplies(fixture)).toEqual([]);
    expect(await threadAuthorIds(fixture)).not.toContain(fixture.replier.id);
  });

  test(cases.allowed, async () => {
    const fixture = await thread();
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
  });

  test(cases.postAuthorBlock, async () => {
    const fixture = await thread();
    await block(fixture.postAuthor.id, fixture.replier.id);
    await expectParentBlocked(fixture);
  });

  test(cases.replierBlockedAuthor, async () => {
    const fixture = await thread();
    await block(fixture.replier.id, fixture.postAuthor.id);
    await expectParentBlocked(fixture);
  });
}
