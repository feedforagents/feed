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
 * Notifications are matched to the exact inputs the creator calls were
 * given (type, actor, comment/post/chat) — never adopted because they
 * appeared during a time window. A cleanup that finds any row it does
 * not own refuses entirely and deletes nothing, so a partial setup or a
 * concurrent foreign row can never orphan or erase another owner's data.
 * A user is deleted only when nothing references it that this fixture
 * does not own — an unowned notification, or a GameOnboarding /
 * UserPnLSnapshot / Whitelist row that would vanish through
 * ON DELETE CASCADE. A setup that fails partway (for example on an ID
 * collision with a pre-existing post or comment) therefore cannot delete
 * data the fixture did not create; the ownership describe below proves
 * that.
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
  and,
  comments,
  db,
  eq,
  gameOnboarding,
  inArray,
  notInArray,
  notifications,
  posts,
  userPnLSnapshots,
  users,
  whitelist,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { serializeNotificationForApi } from '../../../apps/web/src/app/api/notifications/route';
import { getNotificationHref } from '../../../apps/web/src/lib/notifications/presentation';

interface FixtureRegistry {
  commentIds: string[];
  notificationIds: string[];
  postId: string | null;
  userIds: string[];
}

function newRegistry(): FixtureRegistry {
  return { commentIds: [], notificationIds: [], postId: null, userIds: [] };
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

// A notification this fixture's creator calls made, identified by the
// exact inputs passed to the creator — not by appearing in a time
// window. Every id in the tuple is a fresh snowflake this fixture
// generated (post, comment, chat), so no other owner can produce the
// same tuple; a row created by someone else between the reads is never
// adopted. The notify* wrappers return void — createNotification's id
// never reaches the caller — so the tuple is the attributable receipt
// available to this fixture.
interface ExpectedNotification {
  type: string;
  actorId: string;
  commentId?: string | null;
  postId?: string | null;
  chatId?: string | null;
}

function matchesExpected(
  row: {
    type: string;
    actorId: string | null;
    commentId: string | null;
    postId: string | null;
    chatId: string | null;
  },
  expected: ExpectedNotification
): boolean {
  return (
    row.type === expected.type &&
    row.actorId === expected.actorId &&
    (row.commentId ?? null) === (expected.commentId ?? null) &&
    (row.postId ?? null) === (expected.postId ?? null) &&
    (row.chatId ?? null) === (expected.chatId ?? null)
  );
}

async function recordExpectedNotifications(
  registry: FixtureRegistry,
  userId: string,
  expected: ExpectedNotification[]
): Promise<void> {
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      actorId: notifications.actorId,
      commentId: notifications.commentId,
      postId: notifications.postId,
      chatId: notifications.chatId,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
  for (const wanted of expected) {
    const match = rows.find(
      (row) =>
        matchesExpected(row, wanted) &&
        !registry.notificationIds.includes(row.id)
    );
    if (match) registry.notificationIds.push(match.id);
  }
}

async function cleanupRegistry(registry: FixtureRegistry): Promise<void> {
  await db.transaction(async (tx) => {
    // Refusal checks run BEFORE any deletion, under locks, so a refusal
    // rolls the whole cleanup back instead of committing a partial
    // deletion. Comment.postId / parentCommentId have no physical FK, so
    // the Post/Comment logical references need explicit guards.
    if (registry.postId) {
      // Lock the owned post, then refuse when a comment this fixture
      // does not own hangs under it — deleting the post would orphan it.
      await tx
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.id, registry.postId))
        .for('update');
      const foreignCommentCondition =
        registry.commentIds.length > 0
          ? and(
              eq(comments.postId, registry.postId),
              notInArray(comments.id, registry.commentIds)
            )
          : eq(comments.postId, registry.postId);
      const [foreignComment] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(foreignCommentCondition)
        .limit(1);
      if (foreignComment) {
        throw new Error(
          `cleanup refused: foreign comment on owned post ${registry.postId}`
        );
      }
      // A foreign reply to an owned comment would be orphaned the same
      // way when the owned comment is deleted.
      if (registry.commentIds.length > 0) {
        const [foreignReply] = await tx
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              inArray(comments.parentCommentId, registry.commentIds),
              notInArray(comments.id, registry.commentIds)
            )
          )
          .limit(1);
        if (foreignReply) {
          throw new Error('cleanup refused: foreign reply to owned comment');
        }
      }
    }
    // Users: lock the parent row before checking its references, so a
    // concurrent insert cannot slip in between the check and the delete.
    // Any foreign reference refuses the whole cleanup.
    const deletableUserIds: string[] = [];
    for (const userId of registry.userIds) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      const unownedNotificationCondition =
        registry.notificationIds.length > 0
          ? and(
              eq(notifications.userId, userId),
              notInArray(notifications.id, registry.notificationIds)
            )
          : eq(notifications.userId, userId);
      const [unownedNotifications, onboarding, snapshots, whitelistRows] =
        await Promise.all([
          tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(unownedNotificationCondition)
            .limit(1),
          tx
            .select({ id: gameOnboarding.id })
            .from(gameOnboarding)
            .where(eq(gameOnboarding.userId, userId))
            .limit(1),
          tx
            .select({ id: userPnLSnapshots.id })
            .from(userPnLSnapshots)
            .where(eq(userPnLSnapshots.userId, userId))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(eq(whitelist.userId, userId))
            .limit(1),
        ]);
      if (
        unownedNotifications.length > 0 ||
        onboarding.length > 0 ||
        snapshots.length > 0 ||
        whitelistRows.length > 0
      ) {
        throw new Error(
          `cleanup refused: foreign row references user ${userId}`
        );
      }
      deletableUserIds.push(userId);
    }
    // Only now, with every guard passed, delete the owned rows.
    // Notifications: only the rows this fixture's creator calls made.
    if (registry.notificationIds.length > 0) {
      await tx
        .delete(notifications)
        .where(inArray(notifications.id, registry.notificationIds));
    }
    if (registry.commentIds.length > 0) {
      await tx
        .delete(comments)
        .where(inArray(comments.id, registry.commentIds));
    }
    if (registry.postId) {
      await tx.delete(posts).where(eq(posts.id, registry.postId));
    }
    if (deletableUserIds.length > 0) {
      await tx.delete(users).where(inArray(users.id, deletableUserIds));
    }
  });
  // A refused cleanup throws above, so the registry is cleared only on
  // success; a refused registry stays intact for a later retry.
  registry.commentIds.length = 0;
  registry.notificationIds.length = 0;
  registry.postId = null;
  registry.userIds = [];
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

    // Adopt only the rows these exact creator calls made, by tuple —
    // never any other notification that happens to exist for the
    // recipient.
    await recordExpectedNotifications(fixtures, recipient, [
      { type: 'reaction', actorId: actor, postId, commentId: null },
      { type: 'comment', actorId: actor, postId, commentId: commentOnPost },
      { type: 'reply', actorId: actor, postId, commentId: parentComment },
      { type: 'mention', actorId: actor, postId, commentId: mentionComment },
      {
        type: 'reaction',
        actorId: actor,
        postId,
        commentId: reactedComment,
      },
      { type: 'follow', actorId: actor },
      { type: 'system', actorId: actor, chatId },
    ]);

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

  it('cleanup refuses a user with separately owned notification and onboarding rows', async () => {
    const fixture = newRegistry();
    const outsider = newRegistry();
    let separateNotificationId: string | null = null;
    let separateOnboardingId: string | null = null;
    try {
      const userId = await insertUser(fixture);
      const actorId = await insertUser(outsider);
      const fixturePostId = await insertPost(fixture, userId);

      // Rows another owner created for the same user and post; none of
      // them is registered in `fixture`, so cleanup must leave them —
      // and the user they reference — untouched.
      const [separateNotification] = await db
        .insert(notifications)
        .values({
          id: await generateSnowflakeId(),
          userId,
          type: 'follow',
          actorId,
          title: 'separate',
          message: 'separately owned notification',
        })
        .returning({ id: notifications.id });
      if (!separateNotification)
        throw new Error('separate notification insert returned no row');
      separateNotificationId = separateNotification.id;

      const [separateOnboarding] = await db
        .insert(gameOnboarding)
        .values({
          id: await generateSnowflakeId(),
          userId,
          currentStep: 'welcome',
        })
        .returning({ id: gameOnboarding.id });
      if (!separateOnboarding)
        throw new Error('separate onboarding insert returned no row');
      separateOnboardingId = separateOnboarding.id;

      const separateCommentId = await insertComment(
        outsider,
        fixturePostId,
        actorId
      );

      // Cleanup refuses the whole fixture: nothing is deleted — not the
      // user, not the foreign rows, and not the fixture post the foreign
      // comment hangs under.
      let cleanupRefused = false;
      try {
        await cleanupRegistry(fixture);
      } catch {
        cleanupRefused = true;
      }
      expect(cleanupRefused).toBe(true);

      // The user survives because cleanup refuses it, so the cascade
      // children survive with it; the separately owned notification and
      // the comment on the fixture post survive as well.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(survivingUser).toBeDefined();
      const [survivingNotification] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, separateNotificationId));
      expect(survivingNotification).toBeDefined();
      const [survivingOnboarding] = await db
        .select()
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, separateOnboardingId));
      expect(survivingOnboarding).toBeDefined();
      // The complete foreign tuple survives, including its parent Post:
      // the comment is not orphaned by a deleted post.
      const [survivingComment] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, separateCommentId));
      expect(survivingComment).toBeDefined();
      expect(survivingComment?.postId).toBe(fixturePostId);
      expect(survivingComment?.authorId).toBe(actorId);
      expect(survivingComment?.content).toBe('comment');
      const [survivingPost] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, fixturePostId));
      expect(survivingPost).toBeDefined();
      expect(survivingPost?.authorId).toBe(userId);
    } finally {
      // Remove the separately owned rows first; only then may the
      // fixture user be cleaned up.
      if (separateNotificationId) {
        await db
          .delete(notifications)
          .where(eq(notifications.id, separateNotificationId));
      }
      if (separateOnboardingId) {
        await db
          .delete(gameOnboarding)
          .where(eq(gameOnboarding.id, separateOnboardingId));
      }
      await cleanupRegistry(outsider);
      await cleanupRegistry(fixture);
    }
  });

  it('adopts only the notifications its own creator calls made', async () => {
    const fixture = newRegistry();
    let foreignNotificationId: string | null = null;
    try {
      const userId = await insertUser(fixture);
      const actorId = await insertUser(fixture);
      const postId = await insertPost(fixture, userId);
      const commentId = await insertComment(fixture, postId, actorId);

      // A separately owned notification for the same recipient, created
      // after the fixture's own rows exist: the old before/after diff
      // would adopt it; tuple matching must not.
      const [foreign] = await db
        .insert(notifications)
        .values({
          id: await generateSnowflakeId(),
          userId,
          type: 'follow',
          actorId,
          title: 'foreign',
          message: 'separately owned notification',
        })
        .returning({ id: notifications.id });
      if (!foreign) {
        throw new Error('foreign notification insert returned no row');
      }
      foreignNotificationId = foreign.id;

      await notifyCommentOnPost(userId, actorId, postId, commentId);
      await recordExpectedNotifications(fixture, userId, [
        { type: 'comment', actorId, postId, commentId },
      ]);
      expect(fixture.notificationIds).toHaveLength(1);
      const [createdId] = fixture.notificationIds;
      if (!createdId) {
        throw new Error('expected notification id was not recorded');
      }
      expect(createdId).not.toBe(foreignNotificationId);

      // Cleanup refuses while the foreign notification references the
      // user, and the refused cleanup deletes nothing.
      let cleanupRefused = false;
      try {
        await cleanupRegistry(fixture);
      } catch {
        cleanupRefused = true;
      }
      expect(cleanupRefused).toBe(true);
      const [createdStillThere] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, createdId));
      expect(createdStillThere).toBeDefined();
      const [foreignStillThere] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, foreignNotificationId));
      expect(foreignStillThere).toBeDefined();
    } finally {
      if (foreignNotificationId) {
        await db
          .delete(notifications)
          .where(eq(notifications.id, foreignNotificationId));
      }
      await cleanupRegistry(fixture);
    }
  });
});
