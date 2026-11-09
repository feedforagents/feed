/**
 * MCP get_comments and A2A social.get_comments against a real database:
 * both must apply the same read-time viewer moderation filter as the web
 * comment list (GET /api/posts/[id]/comments).
 *
 * The web list excludes comments whose author the viewer blocked or muted,
 * or who blocked the viewer — "as the post feeds, favorites feed,
 * notifications and user search do". The MCP and A2A comment reads scoped
 * their queries only to the post and the soft-delete flag, so an agent
 * reading a thread received every comment the website hides, including
 * comments from accounts the viewer had blocked or muted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  comments,
  db,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import { executeGetComments } from '../../mcp/src/handlers/tool-handlers';

let viewerId: string;
let authorId: string;
let normalId: string;
let blockedId: string;
let mutedId: string;
let blockerId: string;
let postId: string;
let normalCommentId: string;
let ownCommentId: string;
let blockedCommentId: string;
let mutedCommentId: string;
let blockerCommentId: string;
let deletedCommentId: string;

const allUserIds: string[] = [];
const allCommentIds: string[] = [];

async function mcpComments(userId: string, limit: number) {
  return executeGetComments(
    { agentId: 'test-agent', userId },
    { postId, limit }
  );
}

async function a2aComments(userId: string, limit: number) {
  return (await FeedAgentExecutor.executeDirectly(
    'social.get_comments',
    { postId, limit },
    userId
  )) as unknown as { comments: Array<{ id: string }> };
}

beforeAll(async () => {
  [
    viewerId,
    authorId,
    normalId,
    blockedId,
    mutedId,
    blockerId,
    postId,
    normalCommentId,
    ownCommentId,
    blockedCommentId,
    mutedCommentId,
    blockerCommentId,
    deletedCommentId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allUserIds.push(viewerId, authorId, normalId, blockedId, mutedId, blockerId);
  allCommentIds.push(
    normalCommentId,
    ownCommentId,
    blockedCommentId,
    mutedCommentId,
    blockerCommentId,
    deletedCommentId
  );

  const now = new Date();
  const at = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000);

  await db.insert(users).values(
    allUserIds.map((id, i) => ({
      id,
      username: `gc-mod-${i}-${id}`,
      displayName: `GC Fixture ${i}`,
      updatedAt: now,
    }))
  );

  await db.insert(posts).values({
    id: postId,
    authorId,
    content: 'GC moderation fixture post',
    timestamp: at(3600),
  });

  // Oldest first: normal, viewer-own, blocked, muted, blocker, deleted.
  await db.insert(comments).values([
    {
      id: normalCommentId,
      postId,
      authorId: normalId,
      content: 'Normal comment that must stay visible',
      createdAt: at(50),
      updatedAt: now,
    },
    {
      id: ownCommentId,
      postId,
      authorId: viewerId,
      content: 'Viewer own comment that must stay visible',
      createdAt: at(40),
      updatedAt: now,
    },
    {
      id: blockedCommentId,
      postId,
      authorId: blockedId,
      content: 'Blocked actor comment that must stay hidden',
      createdAt: at(30),
      updatedAt: now,
    },
    {
      id: mutedCommentId,
      postId,
      authorId: mutedId,
      content: 'Muted actor comment that must stay hidden',
      createdAt: at(20),
      updatedAt: now,
    },
    {
      id: blockerCommentId,
      postId,
      authorId: blockerId,
      content: 'Blocking actor comment that must stay hidden',
      createdAt: at(10),
      updatedAt: now,
    },
    {
      id: deletedCommentId,
      postId,
      authorId: normalId,
      content: 'Soft-deleted comment that must stay hidden',
      createdAt: at(5),
      updatedAt: now,
      deletedAt: now,
    },
  ]);

  // The viewer blocked one author, muted another, and is blocked by a third
  // — the three sets the web comment list excludes at read time.
  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(userBlocks).values([
    { id: blockRowA, blockerId: viewerId, blockedId },
    { id: blockRowB, blockerId, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: viewerId, mutedId }]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(inArray(posts.id, [postId]));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('MCP get_comments viewer moderation', () => {
  it('hides comments from muted, blocked, and blocking authors', async () => {
    const result = await mcpComments(viewerId, 50);
    const ids = result.comments.map((c) => c.id);
    expect(ids).toContain(normalCommentId);
    expect(ids).toContain(ownCommentId);
    expect(ids).not.toContain(blockedCommentId);
    expect(ids).not.toContain(mutedCommentId);
    expect(ids).not.toContain(blockerCommentId);
    expect(ids).not.toContain(deletedCommentId);
    expect(JSON.stringify(result.comments)).not.toContain('must stay hidden');
  });

  it('applies moderation before the limit so hidden rows do not consume slots', async () => {
    // Newest-first: the two newest rows are the blocker and muted comments.
    const result = await mcpComments(viewerId, 2);
    expect(result.comments.map((c) => c.id)).toEqual([
      ownCommentId,
      normalCommentId,
    ]);
  });

  it('shows every non-deleted comment to a viewer with no moderation relationships', async () => {
    const result = await mcpComments(authorId, 50);
    expect(result.comments.map((c) => c.id).sort()).toEqual(
      [
        normalCommentId,
        ownCommentId,
        blockedCommentId,
        mutedCommentId,
        blockerCommentId,
      ].sort()
    );
  });
});

describe('A2A social.get_comments viewer moderation', () => {
  it('hides comments from muted, blocked, and blocking authors', async () => {
    const result = await a2aComments(viewerId, 50);
    const ids = result.comments.map((c) => c.id);
    expect(ids).toContain(normalCommentId);
    expect(ids).toContain(ownCommentId);
    expect(ids).not.toContain(blockedCommentId);
    expect(ids).not.toContain(mutedCommentId);
    expect(ids).not.toContain(blockerCommentId);
    expect(ids).not.toContain(deletedCommentId);
    expect(JSON.stringify(result.comments)).not.toContain('must stay hidden');
  });

  it('applies moderation before the limit so hidden rows do not consume slots', async () => {
    // Oldest-first: with a limit of 3 the unfiltered page would include the
    // blocked comment; the filtered page holds only the two visible rows.
    const result = await a2aComments(viewerId, 3);
    expect(result.comments.map((c) => c.id)).toEqual([
      normalCommentId,
      ownCommentId,
    ]);
  });

  it('shows every non-deleted comment to a viewer with no moderation relationships', async () => {
    const result = await a2aComments(authorId, 50);
    expect(result.comments.map((c) => c.id).sort()).toEqual(
      [
        normalCommentId,
        ownCommentId,
        blockedCommentId,
        mutedCommentId,
        blockerCommentId,
      ].sort()
    );
  });

  it('leaves anonymous reads unfiltered, matching the web comment list', async () => {
    const result = await a2aComments('', 50);
    expect(result.comments.map((c) => c.id).sort()).toEqual(
      [
        normalCommentId,
        ownCommentId,
        blockedCommentId,
        mutedCommentId,
        blockerCommentId,
      ].sort()
    );
  });
});

describe('get_comments moderation is read-time', () => {
  it('refreshes moderation immediately after unblocking and unmuting', async () => {
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, allUserIds));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockedId, allUserIds));
    await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
    const result = await mcpComments(viewerId, 50);
    expect(result.comments).toHaveLength(5);
  });
});
