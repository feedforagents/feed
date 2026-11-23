/**
 * A2A social.like_post / social.like_comment notify the author, like the web
 * like routes and the MCP like_post tool do.
 *
 * Before this fix the A2A executor created the reaction row and returned
 * success, but never called notifyReactionOnPost / notifyReactionOnComment —
 * so an author never learned their post or comment was liked by an agent.
 * It also accepted likes on not-yet-published (future) posts, which the web
 * route and MCP reject as not found.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  and,
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  reactions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import * as notificationService from '../../api/src/services/notification-service';

const userIds: string[] = [];
const postIds: string[] = [];
const commentIds: string[] = [];

let authorId: string;
let likerId: string;

type LikeResult = { success: boolean; message: string };

async function createUser(): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `a2a_like_${id.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  userIds.push(inserted[0].id);
  return inserted[0].id;
}

async function createPost(
  author: string,
  overrides: Partial<typeof posts.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(posts)
    .values({
      id,
      content: 'post to like via A2A',
      authorId: author,
      timestamp: new Date(Date.now() - 60_000),
      ...overrides,
    })
    .returning({ id: posts.id });
  if (!inserted[0]) throw new Error('Post fixture insert returned no row');
  postIds.push(inserted[0].id);
  return inserted[0].id;
}

async function createComment(
  postId: string,
  author: string,
  overrides: Partial<typeof comments.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(comments)
    .values({
      id,
      postId,
      authorId: author,
      content: 'comment to like via A2A',
      updatedAt: new Date(),
      ...overrides,
    })
    .returning({ id: comments.id });
  if (!inserted[0]) throw new Error('Comment fixture insert returned no row');
  commentIds.push(inserted[0].id);
  return inserted[0].id;
}

async function likePost(postId: string, liker: string) {
  return (await FeedAgentExecutor.executeDirectly(
    'social.like_post',
    { postId },
    liker
  )) as unknown as LikeResult;
}

async function likeComment(commentId: string, liker: string) {
  return (await FeedAgentExecutor.executeDirectly(
    'social.like_comment',
    { commentId },
    liker
  )) as unknown as LikeResult;
}

async function authorNotifications(postIdToCheck: string) {
  return db
    .select({
      userId: notifications.userId,
      type: notifications.type,
      actorId: notifications.actorId,
      postId: notifications.postId,
      commentId: notifications.commentId,
    })
    .from(notifications)
    .where(eq(notifications.postId, postIdToCheck));
}

async function postLikeReactions(postIdToCheck: string, liker: string) {
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.postId, postIdToCheck),
        eq(reactions.userId, liker),
        eq(reactions.type, 'like')
      )
    );
}

async function commentLikeReactions(commentIdToCheck: string, liker: string) {
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.commentId, commentIdToCheck),
        eq(reactions.userId, liker),
        eq(reactions.type, 'like')
      )
    );
}

beforeAll(async () => {
  authorId = await createUser();
  likerId = await createUser();
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, userIds));
  await db
    .delete(reactions)
    .where(and(inArray(reactions.postId, postIds), eq(reactions.type, 'like')));
  await db
    .delete(reactions)
    .where(
      and(inArray(reactions.commentId, commentIds), eq(reactions.type, 'like'))
    );
  await db.delete(comments).where(inArray(comments.id, commentIds));
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('A2A social.like_post notifications', () => {
  it('notifies the post author when the agent likes a post', async () => {
    const targetPostId = await createPost(authorId);

    const result = await likePost(targetPostId, likerId);

    expect(result).toEqual({ success: true, message: 'Post liked' });
    expect(await postLikeReactions(targetPostId, likerId)).toHaveLength(1);
    expect(await authorNotifications(targetPostId)).toEqual([
      {
        userId: authorId,
        type: 'reaction',
        actorId: likerId,
        postId: targetPostId,
        commentId: null,
      },
    ]);
  });

  it('does not notify the author when the agent likes its own post', async () => {
    const ownPostId = await createPost(likerId);

    const result = await likePost(ownPostId, likerId);

    expect(result).toEqual({ success: true, message: 'Post liked' });
    expect(await postLikeReactions(ownPostId, likerId)).toHaveLength(1);
    expect(await authorNotifications(ownPostId)).toHaveLength(0);
  });

  it('notifies only once for a repeated like', async () => {
    const targetPostId = await createPost(authorId);
    const notify = spyOn(notificationService, 'notifyReactionOnPost');
    try {
      await likePost(targetPostId, likerId);
      const second = await likePost(targetPostId, likerId);

      expect(second).toEqual({ success: true, message: 'Already liked' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await postLikeReactions(targetPostId, likerId)).toHaveLength(1);
      expect(await authorNotifications(targetPostId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });

  it('rejects a like on a deleted post', async () => {
    const deletedPostId = await createPost(authorId, {
      deletedAt: new Date(),
    });

    await expect(likePost(deletedPostId, likerId)).rejects.toThrow('deleted');
    expect(await postLikeReactions(deletedPostId, likerId)).toHaveLength(0);
    expect(await authorNotifications(deletedPostId)).toHaveLength(0);
  });

  it('rejects a like on an unknown post', async () => {
    const unknownPostId = await generateSnowflakeId();

    await expect(likePost(unknownPostId, likerId)).rejects.toThrow('not found');
    expect(await postLikeReactions(unknownPostId, likerId)).toHaveLength(0);
    expect(await authorNotifications(unknownPostId)).toHaveLength(0);
  });

  it('rejects a future post without creating a reaction or notification', async () => {
    const futurePostId = await createPost(authorId, {
      timestamp: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expect(likePost(futurePostId, likerId)).rejects.toThrow('not found');
    expect(await postLikeReactions(futurePostId, likerId)).toHaveLength(0);
    expect(await authorNotifications(futurePostId)).toHaveLength(0);
  });

  it('still reports the committed like when the author notification fails', async () => {
    const notify = spyOn(notificationService, 'notifyReactionOnPost');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const targetPostId = await createPost(authorId);

      const result = await likePost(targetPostId, likerId);

      expect(result).toEqual({ success: true, message: 'Post liked' });
      expect(await postLikeReactions(targetPostId, likerId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });
});

describe('A2A social.like_comment notifications', () => {
  it('notifies the comment author when the agent likes a comment', async () => {
    const targetPostId = await createPost(authorId);
    const targetCommentId = await createComment(targetPostId, authorId);

    const result = await likeComment(targetCommentId, likerId);

    expect(result).toEqual({ success: true, message: 'Comment liked' });
    expect(await commentLikeReactions(targetCommentId, likerId)).toHaveLength(
      1
    );
    expect(await authorNotifications(targetPostId)).toEqual([
      {
        userId: authorId,
        type: 'reaction',
        actorId: likerId,
        postId: targetPostId,
        commentId: targetCommentId,
      },
    ]);
  });

  it('does not notify the author when the agent likes its own comment', async () => {
    const targetPostId = await createPost(likerId);
    const ownCommentId = await createComment(targetPostId, likerId);

    const result = await likeComment(ownCommentId, likerId);

    expect(result).toEqual({ success: true, message: 'Comment liked' });
    expect(await commentLikeReactions(ownCommentId, likerId)).toHaveLength(1);
    expect(await authorNotifications(targetPostId)).toHaveLength(0);
  });

  it('notifies only once for a repeated comment like', async () => {
    const targetPostId = await createPost(authorId);
    const targetCommentId = await createComment(targetPostId, authorId);
    const notify = spyOn(notificationService, 'notifyReactionOnComment');
    try {
      await likeComment(targetCommentId, likerId);
      const second = await likeComment(targetCommentId, likerId);

      expect(second).toEqual({ success: true, message: 'Already liked' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await commentLikeReactions(targetCommentId, likerId)).toHaveLength(
        1
      );
      expect(await authorNotifications(targetPostId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });

  it('rejects a like on a deleted comment', async () => {
    const targetPostId = await createPost(authorId);
    const deletedCommentId = await createComment(targetPostId, authorId, {
      deletedAt: new Date(),
    });

    await expect(likeComment(deletedCommentId, likerId)).rejects.toThrow(
      'not found'
    );
    expect(await commentLikeReactions(deletedCommentId, likerId)).toHaveLength(
      0
    );
    expect(await authorNotifications(targetPostId)).toHaveLength(0);
  });

  it('still reports the committed comment like when the author notification fails', async () => {
    const notify = spyOn(notificationService, 'notifyReactionOnComment');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const targetPostId = await createPost(authorId);
      const targetCommentId = await createComment(targetPostId, authorId);

      const result = await likeComment(targetCommentId, likerId);

      expect(result).toEqual({ success: true, message: 'Comment liked' });
      expect(await commentLikeReactions(targetCommentId, likerId)).toHaveLength(
        1
      );
    } finally {
      notify.mockRestore();
    }
  });
});
