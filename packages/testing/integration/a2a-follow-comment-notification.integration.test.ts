/**
 * PRD §8.1, MVP Phase 3: agent tools use the same services as REST,
 * including notifications. The website and MCP notify the followed user
 * after a new follow and the post author after a comment; A2A users.follow
 * and social.create_comment must do the same.
 */

import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import {
  and,
  comments,
  db,
  eq,
  follows,
  inArray,
  notifications,
  or,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import * as notificationService from '../../api/src/services/notification-service';

const userIds: string[] = [];

async function createPost(authorId: string): Promise<string> {
  const postId = await generateSnowflakeId();
  await db.insert(posts).values({
    id: postId,
    content: 'a post to comment on',
    authorId,
    timestamp: new Date(Date.now() - 60_000),
  });
  return postId;
}

async function comment(agentId: string, postId: string, content: string) {
  const result = await FeedAgentExecutor.executeDirectly(
    'social.create_comment',
    { postId, content },
    agentId
  );
  return (result as { success: boolean; comment: { id: string } }).comment.id;
}

async function createUser(displayName: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `a2a_ntf_${id.slice(-10)}`,
    displayName,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function notificationsFor(userId: string, actorId: string) {
  return db
    .select({
      type: notifications.type,
      title: notifications.title,
      message: notifications.message,
      postId: notifications.postId,
      commentId: notifications.commentId,
    })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.actorId, actorId))
    );
}

afterAll(async () => {
  await db
    .delete(notifications)
    .where(
      or(
        inArray(notifications.userId, userIds),
        inArray(notifications.actorId, userIds)
      )
    );
  await db.delete(comments).where(inArray(comments.authorId, userIds));
  await db
    .delete(follows)
    .where(
      or(
        inArray(follows.followerId, userIds),
        inArray(follows.followingId, userIds)
      )
    );
  await db.delete(posts).where(inArray(posts.authorId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('A2A follow and comment notifications', () => {
  it('notifies the followed user after users.follow', async () => {
    const agentId = await createUser('Agent Follower');
    const targetId = await createUser('Target');

    await FeedAgentExecutor.executeDirectly(
      'users.follow',
      { userId: targetId },
      agentId
    );

    expect(await notificationsFor(targetId, agentId)).toEqual([
      {
        type: 'follow',
        title: 'New Follower',
        message: 'Agent Follower started following you',
        postId: null,
        commentId: null,
      },
    ]);
  });

  it('does not notify again when the agent already follows the user', async () => {
    const agentId = await createUser('Agent Follower');
    const targetId = await createUser('Target');

    await FeedAgentExecutor.executeDirectly(
      'users.follow',
      { userId: targetId },
      agentId
    );
    const repeat = await FeedAgentExecutor.executeDirectly(
      'users.follow',
      { userId: targetId },
      agentId
    );

    expect(repeat).toMatchObject({ message: 'Already following' });
    expect(await notificationsFor(targetId, agentId)).toHaveLength(1);
  });

  it('keeps the follow when the notification fails', async () => {
    const agentId = await createUser('Agent Follower');
    const targetId = await createUser('Target');
    const notify = spyOn(notificationService, 'notifyFollow');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const result = await FeedAgentExecutor.executeDirectly(
        'users.follow',
        { userId: targetId },
        agentId
      );

      expect(result).toMatchObject({ success: true });
      expect(notify).toHaveBeenCalledTimes(1);
      const stored = await db
        .select({ id: follows.id })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, agentId),
            eq(follows.followingId, targetId)
          )
        );
      expect(stored).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });

  it('does not notify the agent about a comment on its own post', async () => {
    const agentId = await createUser('Agent Author');
    const postId = await createPost(agentId);

    await comment(agentId, postId, 'adding context');

    expect(await notificationsFor(agentId, agentId)).toHaveLength(0);
  });

  it('keeps the comment when the notification fails', async () => {
    const agentId = await createUser('Agent Commenter');
    const authorId = await createUser('Author');
    const postId = await createPost(authorId);
    const notify = spyOn(notificationService, 'notifyCommentOnPost');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const commentId = await comment(agentId, postId, 'still saved');

      expect(notify).toHaveBeenCalledTimes(1);
      const stored = await db
        .select({ content: comments.content })
        .from(comments)
        .where(eq(comments.id, commentId));
      expect(stored).toEqual([{ content: 'still saved' }]);
    } finally {
      notify.mockRestore();
    }
  });

  it('notifies the post author after social.create_comment', async () => {
    const agentId = await createUser('Agent Commenter');
    const authorId = await createUser('Author');
    const postId = await createPost(authorId);

    const commentId = await comment(agentId, postId, 'interesting take');

    expect(await notificationsFor(authorId, agentId)).toEqual([
      {
        type: 'comment',
        title: 'New Comment',
        message: 'Agent Commenter commented on your post',
        postId,
        commentId,
      },
    ]);
  });
});
