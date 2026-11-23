/** PRD §§8.1, 12 / MVP Phases 3 and 5: enforce social moderation for direct agent actions. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  acquireUserBlockPairLock,
  and,
  comments,
  db,
  eq,
  follows,
  inArray,
  posts,
  sql,
  userBlocks,
  users,
  withTransaction,
} from '@feed/db';
import {
  executeDirectComment,
  executeDirectFollow,
} from '../../agents/src/autonomous/DirectExecutors';
import { assertDisposableAgentFollowDatabase } from './helpers/agent-follow-database';

const [
  agentUserId,
  authorId,
  postId,
  deletedPostId,
  scheduledPostId,
  parentId,
] = [
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
] as const;
const userIds = [agentUserId, authorId];
const postIds = [postId, deletedPostId, scheduledPostId];
const params = { agentUserId, targetUserId: authorId };
const reply = { agentUserId, postId, content: 'Fixture comment' };
const followPair = and(
  eq(follows.followerId, agentUserId),
  eq(follows.followingId, authorId)
);
let fixturesCreated = false;

beforeAll(async () => {
  await assertDisposableAgentFollowDatabase();
  const now = new Date();
  await withTransaction(async (tx) => {
    await tx
      .insert(users)
      .values(
        userIds.map((id) => ({ id, username: `direct_${id}`, updatedAt: now }))
      );
    await tx.insert(posts).values([
      { id: postId, authorId, content: 'Live post' },
      { id: deletedPostId, authorId, content: 'Deleted post', deletedAt: now },
      {
        id: scheduledPostId,
        authorId,
        content: 'Scheduled post',
        timestamp: new Date(now.getTime() + 60_000),
      },
    ]);
    await tx.insert(comments).values({
      id: parentId,
      postId,
      authorId,
      content: 'Deleted parent',
      updatedAt: now,
      deletedAt: now,
    });
  });
  fixturesCreated = true;
});

afterAll(async () => {
  if (!fixturesCreated) return;
  await db.delete(follows).where(followPair);
  await db.delete(comments).where(inArray(comments.postId, postIds));
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

test('direct follows and comments refuse either direction of a block', async () => {
  for (const [blockerId, blockedId] of [
    [authorId, agentUserId],
    [agentUserId, authorId],
  ] as const) {
    const id = crypto.randomUUID();
    await db.insert(userBlocks).values({ id, blockerId, blockedId });
    try {
      await expect(executeDirectFollow(params)).resolves.toEqual({
        success: false,
        error: 'Cannot follow this user',
      });
      await expect(executeDirectComment(reply)).resolves.toEqual({
        success: false,
        error: 'Cannot comment on this post',
      });
    } finally {
      await db.delete(userBlocks).where(eq(userBlocks.id, id));
      await db.delete(follows).where(followPair);
    }
  }
});

test('direct comments require a published post and live parent', async () => {
  await expect(
    executeDirectComment({ ...reply, postId: deletedPostId })
  ).resolves.toEqual({
    success: false,
    error: 'Cannot comment on deleted post',
  });
  await expect(
    executeDirectComment({ ...reply, postId: scheduledPostId })
  ).resolves.toEqual({
    success: false,
    error: `Post not found: ${scheduledPostId}`,
  });
  await expect(
    executeDirectComment({ ...reply, parentCommentId: parentId })
  ).resolves.toEqual({
    success: false,
    error: `Parent comment not found: ${parentId}`,
  });
  const created = await executeDirectComment(reply);
  assert.ok(created.success && created.commentId);
  expect(
    await db
      .select({ id: comments.id, postId: comments.postId })
      .from(comments)
      .where(eq(comments.authorId, agentUserId))
  ).toEqual([{ id: created.commentId, postId }]);
});

test('a direct follow waits for the pair lock and remains idempotent', async () => {
  const ready = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const barrier = withTransaction(async (tx) => {
    await acquireUserBlockPairLock(tx, agentUserId, authorId);
    const [row] = await tx.execute<{ pid: number }>(
      sql`SELECT pg_backend_pid() AS pid`
    );
    if (!row) throw new Error('Missing pair lock backend');
    ready.resolve(row.pid);
    await release.promise;
  }).catch((error: Error) => {
    ready.reject(error);
    throw error;
  });

  const pid = await ready.promise;
  const pending = executeDirectFollow(params);
  const settled = Promise.allSettled([pending]);
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 40 && !waiting; attempt++) {
      const [row] = await db.execute<{ waiting: boolean }>(
        sql`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`
      );
      waiting = row?.waiting === true;
      if (!waiting) await Bun.sleep(25);
    }
  } finally {
    release.resolve();
    await barrier;
    await settled;
  }

  expect(waiting).toBe(true);
  await expect(pending).resolves.toMatchObject({
    success: true,
    followed: true,
  });
  await expect(executeDirectFollow(params)).resolves.toMatchObject({
    success: true,
    alreadyFollowing: true,
  });
  expect(await db.select().from(follows).where(followPair)).toHaveLength(1);
});
