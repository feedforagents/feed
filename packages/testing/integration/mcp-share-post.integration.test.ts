/**
 * MCP share_post applies the same rules as the web share route: it creates the
 * repost (or quote post) in the agent's feed, notifies the original author,
 * and refuses blocked and repeated shares.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
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
import { NPCInteractionTracker } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import * as notificationService from '../../api/src/services/notification-service';
import { sharePost } from '../../api/src/services/share-service';
import { executeSharePost } from '../../mcp/src/handlers/tool-handlers';
import { validateSharePostArgs } from '../../mcp/src/utils/tool-args-validation';

const userIds: string[] = [];
const postIds: string[] = [];
let agentUserId: string;
let authorId: string;
let blockingAuthorId: string;

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `share_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function createPost(authorUserId: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    content: 'post to share',
    authorId: authorUserId,
    timestamp: new Date(Date.now() - 60_000),
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

describe('MCP share_post', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

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

    const result = await executeSharePost(agent(), {
      postId,
      comment: 'worth reading',
    });

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
    // Own agent, so the share rate limit (5 per minute) never interferes.
    const otherAgentId = await createUser();

    const result = await executeSharePost(
      { agentId: 'other-agent', userId: otherAgentId },
      { postId }
    );

    const [repost] = await db
      .select({ content: posts.content, originalPostId: posts.originalPostId })
      .from(posts)
      .where(eq(posts.id, result.repostId));
    expect(repost).toEqual({ content: '', originalPostId: postId });
  });

  it('refuses a second share of the same post', async () => {
    const postId = await createPost(authorId);
    await executeSharePost(agent(), { postId });

    await expect(executeSharePost(agent(), { postId })).rejects.toThrow(
      'already shared'
    );
    expect(await sharesOf(agentUserId, postId)).toHaveLength(1);
  });

  it('refuses to share a post whose author blocked the agent', async () => {
    const postId = await createPost(blockingAuthorId);

    await expect(executeSharePost(agent(), { postId })).rejects.toThrow(
      'Cannot share this post'
    );
    expect(await sharesOf(agentUserId, postId)).toHaveLength(0);
  });

  it('writes the share and the quote post together', async () => {
    const postId = await createPost(authorId);
    const otherAgentId = await createUser();

    // A NUL byte is rejected by Postgres when the quote post is inserted.
    await expect(
      executeSharePost(
        { agentId: 'atomic-agent', userId: otherAgentId },
        { postId, comment: 'bad\u0000quote' }
      )
    ).rejects.toThrow();

    expect(await sharesOf(otherAgentId, postId)).toHaveLength(0);

    const retry = await executeSharePost(
      { agentId: 'atomic-agent', userId: otherAgentId },
      { postId, comment: 'good quote' }
    );
    expect(retry.success).toBe(true);
  });

  it('still completes the share when NPC interaction tracking fails', async () => {
    const trackShare = spyOn(NPCInteractionTracker, 'trackShare');
    trackShare.mockRejectedValueOnce(new Error('tracker down'));
    try {
      const postId = await createPost(authorId);
      const otherAgentId = await createUser();

      const result = await executeSharePost(
        { agentId: 'tracker-agent', userId: otherAgentId },
        { postId, comment: 'still shared' }
      );

      expect(result.success).toBe(true);
      expect(await sharesOf(otherAgentId, postId)).toHaveLength(1);
      const [quote] = await db
        .select({ content: posts.content })
        .from(posts)
        .where(eq(posts.id, result.repostId));
      expect(quote?.content).toBe('still shared');
    } finally {
      trackShare.mockRestore();
    }
  });

  it('returns the committed quote when the author notification fails', async () => {
    const notify = spyOn(notificationService, 'notifyShare');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const postId = await createPost(authorId);
      const otherAgentId = await createUser();
      const result = await executeSharePost(
        { agentId: 'notification-agent', userId: otherAgentId },
        { postId, comment: 'committed quote' }
      );
      expect(result.success).toBe(true);
      expect(await sharesOf(otherAgentId, postId)).toHaveLength(1);
      const [quote] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, result.repostId));
      expect(quote?.content).toBe('committed quote');
    } finally {
      notify.mockRestore();
    }
  });

  it('enforces the same quote length in the shared service used by HTTP', async () => {
    const postId = await createPost(authorId);
    const otherAgentId = await createUser();
    await expect(
      sharePost(otherAgentId, postId, 'a'.repeat(281))
    ).rejects.toThrow();
    expect(await sharesOf(otherAgentId, postId)).toHaveLength(0);
    const result = await sharePost(otherAgentId, postId, 'a'.repeat(280));
    const [quote] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, result.repostId));
    expect(quote?.content).toHaveLength(280);
  });

  it('limits the quote comment to the 280 characters the PRD allows', () => {
    const postId = 'post-id';
    expect(
      validateSharePostArgs({ postId, comment: 'a'.repeat(280) }).comment
    ).toHaveLength(280);
    expect(() =>
      validateSharePostArgs({ postId, comment: 'a'.repeat(281) })
    ).toThrow();
  });
});
