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
 * recorded IDs, children before parents.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { cachedDb } from '@feed/api';
import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_USER_POSTS: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
};

let targetId: string;
let otherId: string;
let controlId: string;
let hostPostId: string;

async function insertUser(id: string, tag: string): Promise<void> {
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f196-${tag}-${id.slice(-12)}`,
      displayName: `F196 ${tag}`,
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
  expect(inserted).toEqual([{ id }]);
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

  [targetId, otherId, controlId, hostPostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await insertUser(targetId, 'target');
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

afterAll(async () => {
  if (owned.comments.size > 0) {
    await db.delete(comments).where(inArray(comments.id, [...owned.comments]));
  }
  if (owned.posts.size > 0) {
    await db.delete(posts).where(inArray(posts.id, [...owned.posts]));
  }
  if (owned.users.size > 0) {
    await db.delete(users).where(inArray(users.id, [...owned.users]));
  }
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

  it('control user: header comment count agrees with the replies tab', async () => {
    const body = await callReplies(controlId);
    expect(body.total).toBe(1);
    const stats = await cachedDb.getUserProfileStats(controlId);
    expect(stats.comments).toBe(1);
  });
});
