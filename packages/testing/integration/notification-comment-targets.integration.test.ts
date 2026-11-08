/**
 * Comment-bearing notifications must arrive at the comment they are about.
 *
 * The creators record the comment id on the notification row (a comment on
 * your post, a reply to your comment, a mention in a comment, a reaction to
 * your comment), and every other comment click in the app goes to
 * /comment/[id]. The notifications page used to drop the user on
 * /post/[postId] instead, where no comment can be focused.
 *
 * Drives the real creators from @feed/api against a real database, shapes
 * the rows with the real GET-route serializer, and resolves the destination
 * with the same function the notifications page renders.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  notifyCommentOnPost,
  notifyDMMessage,
  notifyFollow,
  notifyMention,
  notifyReactionOnComment,
  notifyReactionOnPost,
  notifyReplyToComment,
} from '@feed/api';
import {
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { serializeNotificationForApi } from '../../../apps/web/src/app/api/notifications/route';
import { getNotificationHref } from '../../../apps/web/src/lib/notifications/presentation';

const userIds: string[][] = [];

describe('notification comment targets', () => {
  let recipient: string;
  let actor: string;
  let postId: string;
  let commentOnPost: string;
  let parentComment: string;
  let mentionComment: string;
  let reactedComment: string;
  let chatId: string;
  let hrefByKey: Map<string, string>;

  async function createUser(): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `ntgt_${id.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    });
    userIds.push([id]);
    return id;
  }

  async function createComment(
    authorId: string,
    parentCommentId?: string
  ): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(comments).values({
      id,
      content: 'comment',
      postId,
      authorId,
      parentCommentId: parentCommentId ?? null,
      updatedAt: new Date(),
    });
    return id;
  }

  beforeAll(async () => {
    recipient = await createUser();
    actor = await createUser();

    postId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: postId,
      content: 'post',
      authorId: recipient,
    });

    commentOnPost = await createComment(actor);
    parentComment = await createComment(recipient);
    const replyComment = await createComment(actor, parentComment);
    mentionComment = await createComment(actor);
    reactedComment = await createComment(recipient);
    chatId = await generateSnowflakeId();

    // Post reaction first: its dedupe check has no commentId condition, so
    // creating it after the comment reaction would suppress it.
    await notifyReactionOnPost(recipient, actor, postId);
    await notifyCommentOnPost(recipient, actor, postId, commentOnPost);
    await notifyReplyToComment(
      recipient,
      actor,
      postId,
      parentComment,
      replyComment
    );
    await notifyMention(recipient, actor, postId, mentionComment);
    await notifyReactionOnComment(recipient, actor, reactedComment, postId);
    await notifyFollow(recipient, actor);
    await notifyDMMessage(recipient, actor, chatId, 'hello there');

    const [actorRow] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, actor));

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, recipient));

    hrefByKey = new Map();
    for (const row of rows) {
      const serialized = serializeNotificationForApi({
        ...row,
        actor: actorRow ?? null,
      });
      const key = `${serialized.type}:${serialized.commentId ?? ''}`;
      hrefByKey.set(key, getNotificationHref(serialized));
    }
  });

  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.userId, recipient));
    await db.delete(comments).where(eq(comments.postId, postId));
    await db.delete(posts).where(eq(posts.id, postId));
    await db.delete(users).where(
      inArray(
        users.id,
        userIds.map(([id]) => id)
      )
    );
  });

  it('sends a comment notification to the comment, not the post', () => {
    expect(hrefByKey.get(`comment:${commentOnPost}`)).toBe(
      `/comment/${commentOnPost}`
    );
  });

  it('sends a reply notification to the parent comment it hangs under', () => {
    expect(hrefByKey.get(`reply:${parentComment}`)).toBe(
      `/comment/${parentComment}`
    );
  });

  it('sends a mention in a comment to that comment', () => {
    expect(hrefByKey.get(`mention:${mentionComment}`)).toBe(
      `/comment/${mentionComment}`
    );
  });

  it('sends a reaction on a comment to that comment', () => {
    expect(hrefByKey.get(`reaction:${reactedComment}`)).toBe(
      `/comment/${reactedComment}`
    );
  });

  it('keeps a reaction on the post itself going to the post', () => {
    expect(hrefByKey.get('reaction:')).toBe(`/post/${postId}`);
  });

  it('keeps follow and chat notifications on their existing targets', () => {
    expect(hrefByKey.get('follow:')).toBe(`/profile/${actor}`);
    expect(hrefByKey.get('system:')).toBe(`/chats?chat=${chatId}`);
  });
});
