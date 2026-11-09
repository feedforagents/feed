/** Real shared-service mutation tests; DATABASE_URL must identify an isolated test database. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { generateSnowflakeId } from '@feed/shared';
import { sharePost, unsharePost } from '../../api/src/services/share-service';

const userIds: string[] = [];
let actorId: string;
let authorId: string;
let otherId: string;
async function createUser() {
  const id = await generateSnowflakeId();
  await db
    .insert(users)
    .values({ id, username: `repost_${id}`, updatedAt: new Date() });
  userIds.push(id);
  return id;
}
async function createPost(author = authorId) {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    authorId: author,
    content: 'A public post to repost',
    timestamp: new Date(Date.now() - 60_000),
  });
  return id;
}
async function actorShares(postId: string) {
  return db
    .select()
    .from(shares)
    .where(and(eq(shares.userId, actorId), eq(shares.postId, postId)));
}

describe('shared player repost and unrepost path', () => {
  beforeAll(async () => {
    actorId = await createUser();
    authorId = await createUser();
    otherId = await createUser();
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

  test('repost is persisted under the account and unrepost removes only that account copy', async () => {
    const postId = await createPost();
    const result = await sharePost(actorId, postId);
    const other = await sharePost(otherId, postId);
    const [persisted] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, result.repostId));
    expect(persisted?.authorId).toBe(actorId);
    expect(persisted?.originalPostId).toBe(postId);
    expect(await actorShares(postId)).toHaveLength(1);
    const removed = await unsharePost(actorId, postId);
    expect(removed).toEqual({ shareTargetPostId: postId, shareCount: 1 });
    expect(await actorShares(postId)).toHaveLength(0);
    expect(
      await db.select().from(posts).where(eq(posts.id, result.repostId))
    ).toHaveLength(0);
    expect(
      await db.select().from(posts).where(eq(posts.id, other.repostId))
    ).toHaveLength(1);
    expect(
      await db.select().from(posts).where(eq(posts.id, postId))
    ).toHaveLength(1);
  });

  test('repost audit failure rolls the mutation back', async () => {
    const postId = await createPost();
    await expect(
      sharePost(actorId, postId, undefined, undefined, async () => {
        throw new Error('audit unavailable');
      })
    ).rejects.toThrow('audit unavailable');
    expect(await actorShares(postId)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(posts)
        .where(
          and(eq(posts.authorId, actorId), eq(posts.originalPostId, postId))
        )
    ).toHaveLength(0);
  });

  test('unrepost audit failure leaves the share and its post intact', async () => {
    const postId = await createPost();
    const result = await sharePost(actorId, postId);
    await expect(
      unsharePost(actorId, postId, async () => {
        throw new Error('audit unavailable');
      })
    ).rejects.toThrow('audit unavailable');
    expect(await actorShares(postId)).toHaveLength(1);
    expect(
      await db.select().from(posts).where(eq(posts.id, result.repostId))
    ).toHaveLength(1);
  });

  test('an unrelated account cannot remove the owner repost', async () => {
    const postId = await createPost();
    const result = await sharePost(actorId, postId);
    await expect(unsharePost(otherId, postId)).rejects.toThrow('Share');
    expect(await actorShares(postId)).toHaveLength(1);
    expect(
      await db.select().from(posts).where(eq(posts.id, result.repostId))
    ).toHaveLength(1);
  });

  test('concurrent unreposts consume the share once', async () => {
    const postId = await createPost();
    const result = await sharePost(actorId, postId);
    const responses = await Promise.allSettled([
      unsharePost(actorId, postId),
      unsharePost(actorId, postId),
    ]);
    expect(
      responses.filter((response) => response.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 'rejected')
    ).toHaveLength(1);
    expect(await actorShares(postId)).toHaveLength(0);
    expect(
      await db.select().from(posts).where(eq(posts.id, result.repostId))
    ).toHaveLength(0);
  });

  test('a pure repost alias resolves to the original account share', async () => {
    const postId = await createPost();
    const alias = await sharePost(otherId, postId);
    await sharePost(actorId, alias.repostId);
    const result = await unsharePost(actorId, alias.repostId);
    expect(result.shareTargetPostId).toBe(postId);
    expect(await actorShares(postId)).toHaveLength(0);
  });

  test('deleted original still permits removal of an existing share', async () => {
    const postId = await createPost();
    await sharePost(actorId, postId);
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));
    await unsharePost(actorId, postId);
    expect(await actorShares(postId)).toHaveLength(0);
  });
  test('OAuth pure-only removal refuses a quote while web removal preserves its existing semantics', async () => {
    const postId = await createPost();
    const quote = await sharePost(actorId, postId, 'My authored quote');
    await expect(
      unsharePost(actorId, postId, undefined, { pureOnly: true })
    ).rejects.toThrow('quote');
    expect(await actorShares(postId)).toHaveLength(1);
    expect(
      await db.select().from(posts).where(eq(posts.id, quote.repostId))
    ).toHaveLength(1);
    await unsharePost(actorId, postId);
    expect(
      await db.select().from(posts).where(eq(posts.id, quote.repostId))
    ).toHaveLength(0);
  });

  test('legacy quote and pure repost coexistence deletes only the pure repost', async () => {
    const postId = await createPost();
    const quote = await sharePost(actorId, postId, 'Retain my authored quote');
    const pureId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: pureId,
      authorId: actorId,
      content: '  ',
      originalPostId: postId,
      timestamp: new Date(),
    });
    await unsharePost(actorId, postId, undefined, { pureOnly: true });
    expect(
      await db.select().from(posts).where(eq(posts.id, pureId))
    ).toHaveLength(0);
    expect(
      await db.select().from(posts).where(eq(posts.id, quote.repostId))
    ).toHaveLength(1);
    expect(await actorShares(postId)).toHaveLength(0);
  });
});
