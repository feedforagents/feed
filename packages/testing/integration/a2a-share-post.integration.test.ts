/**
 * A2A social.share_post applies the same rules as the web share route and the
 * MCP share_post tool: it creates the repost (or quote post) in the agent's
 * feed, notifies the original author, and refuses blocked, repeated,
 * deleted, and not-yet-published shares.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import {
  and,
  db,
  eq,
  inArray,
  notifications,
  posts,
  shares,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

const userIds: string[] = [];
const postIds: string[] = [];
let agentUserId: string;
let authorId: string;
let blockingAuthorId: string;

function run(
  operation: string,
  params: Record<string, JsonValue>,
  userId: string
) {
  return FeedAgentExecutor.executeDirectly(operation, params, userId);
}

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `a2ashare_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function createPost(
  authorUserId: string,
  timestamp = new Date(Date.now() - 60_000)
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    content: 'post to share',
    authorId: authorUserId,
    timestamp,
  });
  postIds.push(id);
  return id;
}

async function sharesOf(userId: string, postId: string) {
  return db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.userId, userId), eq(shares.postId, postId)));
}

describe('A2A social.share_post', () => {
  beforeAll(async () => {
    agentUserId = await createUser();
    authorId = await createUser();
    blockingAuthorId = await createUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: blockingAuthorId,
      blockedId: agentUserId,
    });
  });

  afterAll(async () => {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(shares).where(inArray(shares.userId, userIds));
    await db.delete(posts).where(inArray(posts.authorId, userIds));
    await db.delete(userBlocks).where(inArray(userBlocks.blockerId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('creates the quote post in the agent feed and notifies the author', async () => {
    const postId = await createPost(authorId);

    const result = (await run(
      'social.share_post',
      { postId, comment: 'worth reading' },
      agentUserId
    )) as {
      success: boolean;
      shareId: string;
      repostId: string;
      shareCount: number;
    };

    expect(result.success).toBe(true);
    expect(result.shareCount).toBe(1);
    expect(await sharesOf(agentUserId, postId)).toHaveLength(1);

    const reposts = await db
      .select({
        id: posts.id,
        content: posts.content,
        originalPostId: posts.originalPostId,
      })
      .from(posts)
      .where(
        and(eq(posts.authorId, agentUserId), eq(posts.originalPostId, postId))
      );
    expect(reposts).toEqual([
      { id: result.repostId, content: 'worth reading', originalPostId: postId },
    ]);

    const authorNotifications = await db
      .select({ type: notifications.type, actorId: notifications.actorId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, authorId),
          eq(notifications.postId, postId)
        )
      );
    expect(authorNotifications).toEqual([
      { type: 'share', actorId: agentUserId },
    ]);
  });

  it('creates a pure repost when no comment is given', async () => {
    const postId = await createPost(authorId);
    const otherAgentId = await createUser();

    const result = (await run(
      'social.share_post',
      { postId },
      otherAgentId
    )) as { success: boolean; repostId: string };

    expect(result.success).toBe(true);
    const [repost] = await db
      .select({ content: posts.content, originalPostId: posts.originalPostId })
      .from(posts)
      .where(eq(posts.id, result.repostId));
    expect(repost).toEqual({ content: '', originalPostId: postId });
  });

  it('refuses a second share of the same post', async () => {
    const postId = await createPost(authorId);
    await run('social.share_post', { postId }, agentUserId);

    await expect(
      run('social.share_post', { postId }, agentUserId)
    ).rejects.toThrow('already shared');
    expect(await sharesOf(agentUserId, postId)).toHaveLength(1);
  });

  it('refuses to share a post whose author blocked the agent', async () => {
    const postId = await createPost(blockingAuthorId);

    await expect(
      run('social.share_post', { postId }, agentUserId)
    ).rejects.toThrow('Cannot share this post');
    expect(await sharesOf(agentUserId, postId)).toHaveLength(0);
  });

  it('refuses to share a not-yet-published post', async () => {
    const postId = await createPost(
      authorId,
      new Date(Date.now() + 60 * 60 * 1000)
    );

    await expect(
      run('social.share_post', { postId }, agentUserId)
    ).rejects.toThrow(/not found/i);
    expect(await sharesOf(agentUserId, postId)).toHaveLength(0);
  });

  it('refuses to share a deleted post', async () => {
    const postId = await createPost(authorId);
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));

    await expect(
      run('social.share_post', { postId }, agentUserId)
    ).rejects.toThrow('Cannot share deleted post');
    expect(await sharesOf(agentUserId, postId)).toHaveLength(0);
  });
});
