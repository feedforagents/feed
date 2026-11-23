/**
 * Authorized comment pages follow the web's thread visibility before limiting
 * results. A verified disposable database owns every fixture row.
 */
import { beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = [
  'MCP omits accounts outside the viewer moderation policy',
  'MCP fills the page with the newest visible comments',
  'MCP retains the visible thread for a viewer with no moderation',
  'A2A omits accounts outside the viewer moderation policy',
  'A2A fills the page with the oldest visible comments',
  'A2A retains the visible thread for a viewer with no moderation',
  'Anonymous A2A retains every reachable non-deleted comment',
  'Agent reads omit descendants of a hidden author or deleted parent',
  'MCP refreshes thread visibility after unblocking and unmuting',
] as const;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks agent comment visibility in disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-a2a-get-comments-viewer-moderation',
      file: 'packages/testing/integration/mcp-a2a-get-comments-viewer-moderation.integration.test.ts',
      cases: [...cases],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { comments, db, eq, inArray, posts, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { FeedAgentExecutor } = await import(
    '../../a2a/src/executors/feed-executor'
  );
  const { executeGetComments } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const viewerId = randomUUID();
  const authorId = randomUUID();
  const normalId = randomUUID();
  const blockedId = randomUUID();
  const mutedId = randomUUID();
  const blockerId = randomUUID();
  const postId = randomUUID();
  const normalCommentId = randomUUID();
  const ownCommentId = randomUUID();
  const blockedCommentId = randomUUID();
  const mutedCommentId = randomUUID();
  const blockerCommentId = randomUUID();
  const deletedCommentId = randomUUID();
  const blockedReplyId = randomUUID();
  const blockedGrandchildId = randomUUID();
  const deletedReplyId = randomUUID();
  const blockIds = [randomUUID(), randomUUID()] as const;
  const muteId = randomUUID();

  const canonicalOrder = [
    normalCommentId,
    ownCommentId,
    blockedCommentId,
    mutedCommentId,
    blockerCommentId,
    blockedReplyId,
    blockedGrandchildId,
  ];
  const noModerationNewest = [...canonicalOrder].reverse();

  const a2aResult = z.object({
    comments: z.array(z.object({ id: z.string() })),
  });

  async function mcpIds(userId: string, limit = 50) {
    const result = await executeGetComments(
      { agentId: 'comment-visibility-test', userId },
      { postId, limit }
    );
    return result.comments.map((comment) => comment.id);
  }

  async function a2aIds(userId: string, limit = 50) {
    const result = await FeedAgentExecutor.executeDirectly(
      'social.get_comments',
      { postId, limit },
      userId
    );
    return a2aResult.parse(result).comments.map((comment) => comment.id);
  }

  beforeAll(async () => {
    const now = new Date();
    const at = (secondsAgo: number) =>
      new Date(now.getTime() - secondsAgo * 1000);

    await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values(
          [viewerId, authorId, normalId, blockedId, mutedId, blockerId].map(
            (id) => ({ id, username: `comment-${id}`, updatedAt: now })
          )
        );
      await tx.insert(posts).values({
        id: postId,
        authorId,
        content: 'Agent comment visibility fixture',
        timestamp: at(3600),
      });

      function comment(
        id: string,
        authorId: string,
        secondsAgo: number,
        parentCommentId: string | null = null,
        deletedAt: Date | null = null
      ) {
        return {
          id,
          postId,
          authorId,
          parentCommentId,
          deletedAt,
          content: `Fixture comment ${id}`,
          createdAt: at(secondsAgo),
          updatedAt: now,
        };
      }

      await tx
        .insert(comments)
        .values([
          comment(normalCommentId, normalId, 50),
          comment(ownCommentId, viewerId, 40, normalCommentId),
          comment(blockedCommentId, blockedId, 30),
          comment(mutedCommentId, mutedId, 20),
          comment(blockerCommentId, blockerId, 10),
          comment(deletedCommentId, normalId, 5, null, now),
          comment(deletedReplyId, normalId, 4, deletedCommentId),
          comment(blockedReplyId, normalId, 3, blockedCommentId),
          comment(blockedGrandchildId, viewerId, 2, blockedReplyId),
        ]);
      await tx.insert(userBlocks).values([
        { id: blockIds[0], blockerId: viewerId, blockedId },
        { id: blockIds[1], blockerId, blockedId: viewerId },
      ]);
      await tx
        .insert(userMutes)
        .values({ id: muteId, muterId: viewerId, mutedId });
    });
  });

  test(cases[0], async () => {
    const ids = await mcpIds(viewerId);
    expect(ids).toContain(normalCommentId);
    expect(ids).toContain(ownCommentId);
    for (const id of [blockedCommentId, mutedCommentId, blockerCommentId]) {
      expect(ids).not.toContain(id);
    }
  });

  test(cases[1], async () => {
    expect(await mcpIds(viewerId, 2)).toEqual([ownCommentId, normalCommentId]);
  });

  test(cases[2], async () => {
    expect(await mcpIds(authorId)).toEqual(noModerationNewest);
  });

  test(cases[3], async () => {
    const ids = await a2aIds(viewerId);
    expect(ids).toContain(normalCommentId);
    expect(ids).toContain(ownCommentId);
    for (const id of [blockedCommentId, mutedCommentId, blockerCommentId]) {
      expect(ids).not.toContain(id);
    }
  });

  test(cases[4], async () => {
    expect(await a2aIds(viewerId, 3)).toEqual([normalCommentId, ownCommentId]);
  });

  test(cases[5], async () => {
    expect(await a2aIds(authorId)).toEqual(canonicalOrder);
  });

  test(cases[6], async () => {
    expect(await a2aIds('')).toEqual(canonicalOrder);
  });

  test(cases[7], async () => {
    for (const ids of await Promise.all([mcpIds(viewerId), a2aIds(viewerId)])) {
      for (const id of [blockedReplyId, blockedGrandchildId, deletedReplyId]) {
        expect(ids).not.toContain(id);
      }
    }
  });

  test(cases[8], async () => {
    await db.transaction(async (tx) => {
      await tx.delete(userBlocks).where(inArray(userBlocks.id, [...blockIds]));
      await tx.delete(userMutes).where(eq(userMutes.id, muteId));
    });
    expect(await mcpIds(viewerId)).toEqual(noModerationNewest);
  });
}
