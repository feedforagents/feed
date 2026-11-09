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
 * Fixture ownership: every ID is registered only from a successful
 * INSERT ... RETURNING, and cleanup deletes exactly those owned rows.
 * A setup that fails partway (for example on an ID collision with a
 * pre-existing post or comment) therefore cannot delete data the fixture
 * did not create; the ownership describe below proves that.
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

interface FixtureRegistry {
  commentIds: string[];
  postId: string | null;
  userIds: string[];
}

function newRegistry(): FixtureRegistry {
  return { commentIds: [], postId: null, userIds: [] };
}

async function insertUser(registry: FixtureRegistry): Promise<string> {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(users)
    .values({
      id,
      username: `ntgt_${id.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  registry.userIds.push(row.id);
  return row.id;
}

async function insertPost(
  registry: FixtureRegistry,
  authorId: string,
  explicitId?: string
): Promise<string> {
  const id = explicitId ?? (await generateSnowflakeId());
  const [row] = await db
    .insert(posts)
    .values({
      id,
      content: 'post',
      authorId,
    })
    .returning({ id: posts.id });
  if (!row) throw new Error('post insert returned no row');
  registry.postId = row.id;
  return row.id;
}

async function insertComment(
  registry: FixtureRegistry,
  postId: string,
  authorId: string,
  parentCommentId?: string,
  explicitId?: string
): Promise<string> {
  const id = explicitId ?? (await generateSnowflakeId());
  const [row] = await db
    .insert(comments)
    .values({
      id,
      content: 'comment',
      postId,
      authorId,
      parentCommentId: parentCommentId ?? null,
      updatedAt: new Date(),
    })
    .returning({ id: comments.id });
  if (!row) throw new Error('comment insert returned no row');
  registry.commentIds.push(row.id);
  return row.id;
}

async function cleanupRegistry(registry: FixtureRegistry): Promise<void> {
  if (registry.userIds.length > 0) {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, registry.userIds));
  }
  if (registry.commentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, registry.commentIds));
  }
  if (registry.postId) {
    await db.delete(posts).where(eq(posts.id, registry.postId));
  }
  if (registry.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, registry.userIds));
  }
  registry.commentIds.length = 0;
  registry.postId = null;
  registry.userIds.length = 0;
}

describe('notification comment targets', () => {
  const fixtures = newRegistry();
  let recipient: string;
  let actor: string;
  let postId: string;
  let commentOnPost: string;
  let parentComment: string;
  let mentionComment: string;
  let reactedComment: string;
  let chatId: string;
  let hrefByKey: Map<string, string>;

  beforeAll(async () => {
    recipient = await insertUser(fixtures);
    actor = await insertUser(fixtures);

    postId = await insertPost(fixtures, recipient);

    commentOnPost = await insertComment(fixtures, postId, actor);
    parentComment = await insertComment(fixtures, postId, recipient);
    const replyComment = await insertComment(
      fixtures,
      postId,
      actor,
      parentComment
    );
    mentionComment = await insertComment(fixtures, postId, actor);
    reactedComment = await insertComment(fixtures, postId, recipient);
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
    await cleanupRegistry(fixtures);
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

describe('notification comment targets fixture ownership', () => {
  it('cleanup after a colliding setup leaves pre-existing rows untouched', async () => {
    const victim = newRegistry();
    const attempt = newRegistry();
    try {
      const victimAuthor = await insertUser(victim);
      const victimPostId = await insertPost(victim, victimAuthor);
      const victimCommentId = await insertComment(
        victim,
        victimPostId,
        victimAuthor
      );

      // A post INSERT reusing the pre-existing post's ID collides; the
      // attempting fixture registers no post ownership, and cleaning up
      // that incomplete setup is a no-op for the victim's rows.
      let postCollisionFailed = false;
      try {
        await insertPost(attempt, victimAuthor, victimPostId);
      } catch {
        postCollisionFailed = true;
      }
      expect(postCollisionFailed).toBe(true);
      expect(attempt.postId).toBeNull();
      await cleanupRegistry(attempt);

      const [postAfterFailedSetup] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, victimPostId));
      expect(postAfterFailedSetup).toBeDefined();

      // Partial setup: the attempt registers its own user and post, then a
      // comment INSERT reusing the pre-existing comment's ID collides and
      // registers no comment ownership.
      const attemptAuthor = await insertUser(attempt);
      const attemptPostId = await insertPost(attempt, attemptAuthor);
      let commentCollisionFailed = false;
      try {
        await insertComment(
          attempt,
          attemptPostId,
          attemptAuthor,
          undefined,
          victimCommentId
        );
      } catch {
        commentCollisionFailed = true;
      }
      expect(commentCollisionFailed).toBe(true);
      expect(attempt.commentIds).toEqual([]);

      await cleanupRegistry(attempt);

      // The pre-existing post, its comment and their author all survive.
      const [survivingPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, victimPostId));
      expect(survivingPost).toBeDefined();
      const [survivingComment] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, victimCommentId));
      expect(survivingComment).toBeDefined();
      expect(survivingComment?.postId).toBe(victimPostId);
      const [survivingAuthor] = await db
        .select()
        .from(users)
        .where(eq(users.id, victimAuthor));
      expect(survivingAuthor).toBeDefined();
    } finally {
      await cleanupRegistry(attempt);
      await cleanupRegistry(victim);
    }
  });
});
