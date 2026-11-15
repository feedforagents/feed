/**
 * Profile header comment count against a real database: the comments
 * number on a profile must count the same comments the profile's own
 * replies tab delivers.
 *
 * The profile stats code states the agreement rule for its own counts:
 * the followers count joins the follower's user row and applies the
 * list's membership "or the header number disagrees with the list on the
 * same screen". The followers and following counts follow that rule, and
 * the post count is being brought under it separately (#1717). The
 * comments count still counts every comment row the user ever wrote,
 * including soft-deleted ones (deletedAt set). The replies tab on the
 * same profile (GET /api/users/[userId]/posts?type=replies) counts and
 * delivers only non-deleted comments, and every other comment count in
 * the product — post detail counts, profile post lists — filters
 * deletedAt the same way. A user who deletes a reply therefore keeps a
 * header number that no tab on their own profile can reproduce.
 *
 * Fixture ownership: every helper records an ID only from the successful
 * `returning()` result of its own insert. Teardown deletes exactly the
 * recorded IDs, children before parents — but only after a transactional
 * foreign-reference check: a row this run did not create that still
 * references an owned parent (a reply or reaction under an owned comment or
 * post, or a cascade/restrict row such as GameOnboarding under an owned
 * user) refuses that parent's delete, so the foreign row and its parent
 * both survive and the refusal throws loudly instead of silently
 * orphaning or cascading foreign data.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { cachedDb } from '@feed/api';
import {
  adminRoles,
  and,
  comments,
  db,
  eq,
  gameOnboarding,
  inArray,
  not,
  posts,
  reactions,
  userPnLSnapshots,
  users,
  whitelist,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_USER_POSTS: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;
let GET_BY_USERNAME: typeof import('../../../apps/web/src/app/api/users/by-username/[username]/route').GET;

type OwnedReceipt = {
  users: Set<string>;
  posts: Set<string>;
  comments: Set<string>;
};

const owned: OwnedReceipt = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
};

let targetId: string;
let targetUsername: string;
let otherId: string;
let controlId: string;
let hostPostId: string;

async function insertUser(id: string, tag: string): Promise<string> {
  const username = `f196-${tag}-${id.slice(-12)}`;
  const inserted = await db
    .insert(users)
    .values({
      id,
      username,
      displayName: `F196 ${tag}`,
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
  expect(inserted).toEqual([{ id }]);
  return username;
}

async function insertComment(values: {
  id: string;
  authorId: string;
  content: string;
  deletedAt?: Date | null;
}): Promise<void> {
  const inserted = await db
    .insert(comments)
    .values({
      id: values.id,
      authorId: values.authorId,
      postId: hostPostId,
      content: values.content,
      parentCommentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: values.deletedAt ?? null,
    })
    .returning({ id: comments.id });
  for (const row of inserted) owned.comments.add(row.id);
  expect(inserted).toEqual([{ id: values.id }]);
}

async function callReplies(
  userId: string
): Promise<{ items: Array<{ id: string }>; total: number }> {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/users/${userId}/posts?type=replies&limit=100&page=1`
    )
  );
  const response = await GET_USER_POSTS(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    items: Array<{ id: string }>;
    total: number;
  };
}

beforeAll(async () => {
  ({ GET: GET_USER_POSTS } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  ));
  ({ GET: GET_BY_USERNAME } = await import(
    '../../../apps/web/src/app/api/users/by-username/[username]/route'
  ));

  [targetId, otherId, controlId, hostPostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  targetUsername = await insertUser(targetId, 'target');
  await insertUser(otherId, 'other');
  await insertUser(controlId, 'control');

  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const insertedHost = await db
    .insert(posts)
    .values({
      id: hostPostId,
      authorId: otherId,
      content: 'host post',
      timestamp: past,
      createdAt: past,
      deletedAt: null,
      originalPostId: null,
    })
    .returning({ id: posts.id });
  for (const row of insertedHost) owned.posts.add(row.id);
  expect(insertedHost).toEqual([{ id: hostPostId }]);

  const visibleComment1 = await generateSnowflakeId();
  const visibleComment2 = await generateSnowflakeId();
  const deletedCommentId = await generateSnowflakeId();
  await insertComment({
    id: visibleComment1,
    authorId: targetId,
    content: 'visible reply one',
  });
  await insertComment({
    id: visibleComment2,
    authorId: targetId,
    content: 'visible reply two',
  });
  await insertComment({
    id: deletedCommentId,
    authorId: targetId,
    content: 'reply the author deleted',
    deletedAt: now,
  });

  const controlCommentId = await generateSnowflakeId();
  await insertComment({
    id: controlCommentId,
    authorId: controlId,
    content: 'control visible reply',
  });
});

/**
 * Delete exactly the fixture rows in `receipt`, children before parents.
 *
 * Before deleting a parent, one transaction checks it for foreign rows —
 * rows this run did not create that still reference it. Comments and
 * reactions carry no foreign key to their parent, so deleting an owned
 * comment or post would silently orphan them; user children such as
 * GameOnboarding, UserPnLSnapshot and Whitelist cascade on user delete,
 * and AdminRole blocks it (restrict / no action). A refused parent is
 * left in place together with its foreign rows, the other owned rows are
 * still deleted, and the refusal throws after the transaction commits so
 * the interference is loud instead of silent.
 */
async function cleanupOwned(receipt: OwnedReceipt): Promise<void> {
  const refusals: string[] = [];
  await db.transaction(async (tx) => {
    const commentIds = [...receipt.comments];
    const postIds = [...receipt.posts];
    const userIds = [...receipt.users];
    const refusedComments = new Set<string>();
    const refusedPosts = new Set<string>();
    const refusedUsers = new Set<string>();

    if (commentIds.length > 0) {
      const foreignReplies = await tx
        .select({ id: comments.id, parentCommentId: comments.parentCommentId })
        .from(comments)
        .where(
          and(
            inArray(comments.parentCommentId, commentIds),
            not(inArray(comments.id, commentIds))
          )
        );
      for (const row of foreignReplies) {
        refusedComments.add(row.parentCommentId as string);
        refusals.push(
          `foreign reply ${row.id} under owned comment ${row.parentCommentId}`
        );
      }
      const foreignReactions = await tx
        .select({ id: reactions.id, commentId: reactions.commentId })
        .from(reactions)
        .where(inArray(reactions.commentId, commentIds));
      for (const row of foreignReactions) {
        refusedComments.add(row.commentId as string);
        refusals.push(
          `foreign reaction ${row.id} under owned comment ${row.commentId}`
        );
      }
    }
    if (postIds.length > 0) {
      const foreignComments = await tx
        .select({ id: comments.id, postId: comments.postId })
        .from(comments)
        .where(
          and(
            inArray(comments.postId, postIds),
            not(inArray(comments.id, commentIds))
          )
        );
      for (const row of foreignComments) {
        refusedPosts.add(row.postId);
        refusals.push(
          `foreign comment ${row.id} under owned post ${row.postId}`
        );
      }
      const foreignReactions = await tx
        .select({ id: reactions.id, postId: reactions.postId })
        .from(reactions)
        .where(inArray(reactions.postId, postIds));
      for (const row of foreignReactions) {
        refusedPosts.add(row.postId as string);
        refusals.push(
          `foreign reaction ${row.id} under owned post ${row.postId}`
        );
      }
    }
    if (userIds.length > 0) {
      const foreignChildren = await Promise.all([
        tx
          .select({ userId: gameOnboarding.userId })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, userIds)),
        tx
          .select({ userId: userPnLSnapshots.userId })
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.userId, userIds)),
        tx
          .select({ userId: whitelist.userId })
          .from(whitelist)
          .where(inArray(whitelist.userId, userIds)),
        tx
          .select({ userId: adminRoles.userId })
          .from(adminRoles)
          .where(inArray(adminRoles.userId, userIds)),
        tx
          .select({ userId: adminRoles.grantedBy })
          .from(adminRoles)
          .where(inArray(adminRoles.grantedBy, userIds)),
      ]);
      const labels = [
        'GameOnboarding',
        'UserPnLSnapshot',
        'Whitelist',
        'AdminRole',
        'AdminRole grantedBy',
      ];
      foreignChildren.forEach((rows, index) => {
        for (const row of rows) {
          refusedUsers.add(row.userId);
          refusals.push(
            `foreign ${labels[index]} row under owned user ${row.userId}`
          );
        }
      });
    }

    const deletableComments = commentIds.filter(
      (id) => !refusedComments.has(id)
    );
    const deletablePosts = postIds.filter((id) => !refusedPosts.has(id));
    const deletableUsers = userIds.filter((id) => !refusedUsers.has(id));
    if (deletableComments.length > 0) {
      await tx.delete(comments).where(inArray(comments.id, deletableComments));
    }
    if (deletablePosts.length > 0) {
      await tx.delete(posts).where(inArray(posts.id, deletablePosts));
    }
    if (deletableUsers.length > 0) {
      await tx.delete(users).where(inArray(users.id, deletableUsers));
    }
  });
  if (refusals.length > 0) {
    throw new Error(
      `Fixture cleanup refused ${refusals.length} parent(s); foreign rows and their parents preserved: ${refusals.join('; ')}`
    );
  }
}

afterAll(async () => {
  await cleanupOwned(owned);
});

describe('profile header comment count', () => {
  it('replies tab total counts only non-deleted replies', async () => {
    const body = await callReplies(targetId);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it('header comments count equals the replies total', async () => {
    const stats = await cachedDb.getUserProfileStats(targetId);
    expect(stats.comments).toBe(2);
  });

  it('by-username header stats count only non-deleted comments', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/users/by-username/${targetUsername}`)
    );
    const response = await GET_BY_USERNAME(request, {
      params: Promise.resolve({ username: targetUsername }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { stats: { comments: number } };
    };
    expect(body.user.stats.comments).toBe(2);
  });

  it('control user: header comment count agrees with the replies tab', async () => {
    const body = await callReplies(controlId);
    expect(body.total).toBe(1);
    const stats = await cachedDb.getUserProfileStats(controlId);
    expect(stats.comments).toBe(1);
  });

  it('teardown refuses a parent that foreign rows still reference', async () => {
    // Sacrificial owned rows plus foreign rows inserted directly, never
    // through the fixture helpers, so the ownership records hold only the
    // sacrificial IDs.
    const sacrificialUserId = await generateSnowflakeId();
    const sacrificialCommentId = await generateSnowflakeId();
    const foreignReplyId = await generateSnowflakeId();
    const foreignReactionId = await generateSnowflakeId();
    const foreignOnboardingId = await generateSnowflakeId();
    await db.insert(users).values({
      id: sacrificialUserId,
      username: `f196-sac-${sacrificialUserId.slice(-12)}`,
      displayName: 'F196 sacrificial',
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    });
    await db.insert(comments).values({
      id: sacrificialCommentId,
      authorId: sacrificialUserId,
      postId: hostPostId,
      content: 'sacrificial comment',
      parentCommentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await db.insert(comments).values({
      id: foreignReplyId,
      authorId: otherId,
      postId: hostPostId,
      content: 'foreign reply under the sacrificial comment',
      parentCommentId: sacrificialCommentId,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    await db.insert(reactions).values({
      id: foreignReactionId,
      commentId: sacrificialCommentId,
      postId: null,
      userId: otherId,
      type: 'like',
      createdAt: new Date(),
    });
    await db.insert(gameOnboarding).values({
      id: foreignOnboardingId,
      userId: sacrificialUserId,
    });
    try {
      await expect(
        cleanupOwned({
          users: new Set([sacrificialUserId]),
          posts: new Set(),
          comments: new Set([sacrificialCommentId]),
        })
      ).rejects.toThrow('Fixture cleanup refused');
      // The foreign rows and their parents all survive the refusal.
      const survivors = await Promise.all([
        db
          .select({ id: comments.id })
          .from(comments)
          .where(inArray(comments.id, [sacrificialCommentId, foreignReplyId])),
        db
          .select({ id: reactions.id })
          .from(reactions)
          .where(eq(reactions.id, foreignReactionId)),
        db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, foreignOnboardingId)),
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, sacrificialUserId)),
      ]);
      expect(survivors.map((rows) => rows.length)).toEqual([2, 1, 1, 1]);
    } finally {
      await db.delete(reactions).where(eq(reactions.id, foreignReactionId));
      await db.delete(comments).where(eq(comments.id, foreignReplyId));
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
      await db.delete(comments).where(eq(comments.id, sacrificialCommentId));
      await db.delete(users).where(eq(users.id, sacrificialUserId));
    }
  });
});
