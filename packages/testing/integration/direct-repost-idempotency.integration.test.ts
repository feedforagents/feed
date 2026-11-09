/** Real duplicate inserts must return the persisted repost, including with quotes. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, eq, inArray, posts, shares, users } from '@feed/db';
import { executeDirectRepost } from '../../agents/src/autonomous/DirectExecutors';

const userIds = [crypto.randomUUID(), crypto.randomUUID()];
const authorId = userIds[0]!;
const agentUserId = userIds[1]!;
const postId = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(users).values(
    userIds.map((id) => ({
      id,
      username: `repost_${id}`,
      updatedAt: new Date(),
    }))
  );
  await db
    .insert(posts)
    .values({ id: postId, authorId, content: 'Original post' });
});

afterAll(async () => {
  await db.delete(shares).where(eq(shares.userId, agentUserId));
  await db.delete(posts).where(inArray(posts.authorId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

test('repeating a quote returns the existing share without creating another quote', async () => {
  const first = await executeDirectRepost({
    agentUserId,
    postId,
    comment: 'First quote',
  });
  const repeated = await executeDirectRepost({
    agentUserId,
    postId,
    comment: 'Do not create another quote',
  });
  expect(first.success).toBe(true);
  expect(first.alreadyReposted).toBe(false);
  expect(repeated).toEqual({
    success: true,
    repostId: first.repostId,
    alreadyReposted: true,
  });
  const persistedShares = await db
    .select()
    .from(shares)
    .where(eq(shares.userId, agentUserId));
  const quotes = await db
    .select()
    .from(posts)
    .where(eq(posts.authorId, agentUserId));
  expect(persistedShares).toHaveLength(1);
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.content).toBe('First quote');
});
