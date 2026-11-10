/**
 * MCP create_comment follows the same rules as the web comments route and
 * the other MCP write tools: the post must exist, be published and not
 * deleted, and a fresh comment notifies the post author (never the agent
 * itself, and never across a block). A notification failure must not fail
 * the committed comment.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import {
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import * as notificationService from '../../api/src/services/notification-service';
import { executeCreateComment } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const postIds: string[] = [];
const blockIds: string[] = [];

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `mcpc_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function createPost(
  authorId: string,
  overrides: Partial<typeof posts.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    content: 'post to comment on',
    authorId,
    timestamp: new Date(Date.now() - 60_000),
    ...overrides,
  });
  postIds.push(id);
  return id;
}

async function commentsOn(postId: string) {
  return db
    .select({ id: comments.id, authorId: comments.authorId })
    .from(comments)
    .where(eq(comments.postId, postId));
}

async function notificationsFor(postId: string) {
  return db
    .select({
      userId: notifications.userId,
      type: notifications.type,
      actorId: notifications.actorId,
      postId: notifications.postId,
      commentId: notifications.commentId,
    })
    .from(notifications)
    .where(eq(notifications.postId, postId));
}

describe('MCP create_comment', () => {
  afterAll(async () => {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(comments).where(inArray(comments.postId, postIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('notifies the post author when the agent comments', async () => {
    const author = await createUser();
    const agentUserId = await createUser();
    const postId = await createPost(author);

    const result = await executeCreateComment(
      { agentId: 'agent', userId: agentUserId },
      { postId, content: 'nice post' }
    );

    expect(result.success).toBe(true);
    expect(await commentsOn(postId)).toHaveLength(1);
    expect(await notificationsFor(postId)).toEqual([
      {
        userId: author,
        type: 'comment',
        actorId: agentUserId,
        postId,
        commentId: result.commentId,
      },
    ]);
  });

  it('does not notify when the agent comments on its own post', async () => {
    const agentUserId = await createUser();
    const postId = await createPost(agentUserId);

    const result = await executeCreateComment(
      { agentId: 'agent', userId: agentUserId },
      { postId, content: 'note to self' }
    );

    expect(result.success).toBe(true);
    expect(await commentsOn(postId)).toHaveLength(1);
    expect(await notificationsFor(postId)).toHaveLength(0);
  });

  it('does not notify across a block, but the comment still lands', async () => {
    const author = await createUser();
    const agentUserId = await createUser();
    const postId = await createPost(author);
    const inserted = await db
      .insert(userBlocks)
      .values({
        id: await generateSnowflakeId(),
        blockerId: author,
        blockedId: agentUserId,
      })
      .returning({ id: userBlocks.id });
    blockIds.push(...inserted.map((row) => row.id));

    const result = await executeCreateComment(
      { agentId: 'agent', userId: agentUserId },
      { postId, content: 'blocked hello' }
    );

    expect(result.success).toBe(true);
    expect(await commentsOn(postId)).toHaveLength(1);
    expect(await notificationsFor(postId)).toHaveLength(0);
  });

  it('rejects a comment on a deleted post', async () => {
    const author = await createUser();
    const agentUserId = await createUser();
    const postId = await createPost(author, { deletedAt: new Date() });

    await expect(
      executeCreateComment(
        { agentId: 'agent', userId: agentUserId },
        { postId, content: 'too late' }
      )
    ).rejects.toThrow('deleted');
    expect(await commentsOn(postId)).toHaveLength(0);
    expect(await notificationsFor(postId)).toHaveLength(0);
  });

  it('rejects a comment on an unknown post', async () => {
    const agentUserId = await createUser();
    const postId = await generateSnowflakeId();

    await expect(
      executeCreateComment(
        { agentId: 'agent', userId: agentUserId },
        { postId, content: 'into the void' }
      )
    ).rejects.toThrow('not found');
    expect(await commentsOn(postId)).toHaveLength(0);
  });

  it('rejects a comment on a future post', async () => {
    const author = await createUser();
    const agentUserId = await createUser();
    const postId = await createPost(author, {
      timestamp: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expect(
      executeCreateComment(
        { agentId: 'agent', userId: agentUserId },
        { postId, content: 'early' }
      )
    ).rejects.toThrow('not found');
    expect(await commentsOn(postId)).toHaveLength(0);
    expect(await notificationsFor(postId)).toHaveLength(0);
  });

  it('still reports the committed comment when the author notification fails', async () => {
    const author = await createUser();
    const agentUserId = await createUser();
    const postId = await createPost(author);
    const notify = spyOn(notificationService, 'notifyCommentOnPost');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const result = await executeCreateComment(
        { agentId: 'agent', userId: agentUserId },
        { postId, content: 'committed anyway' }
      );

      expect(result.success).toBe(true);
      expect(await commentsOn(postId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });
});
