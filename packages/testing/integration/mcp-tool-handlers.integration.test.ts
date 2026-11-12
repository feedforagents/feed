/**
 * MCP tool handlers return real data for the authenticated agent.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import {
  and,
  closeDatabase,
  comments,
  db,
  eq,
  favorites,
  inArray,
  markets,
  notifications,
  positions,
  posts,
  reactions,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import * as notificationService from '../../api/src/services/notification-service';
import {
  executeGetFavoritePosts,
  executeGetMarketPrices,
  executeGetMarkets,
  executeGetPositions,
  executeGetUnreadCount,
  executeGetUserWallet,
  executeLikeComment,
  executeLikePost,
  executeMarkNotificationsRead,
} from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const likePostIds: string[] = [];
const marketIds: string[] = [];
const postIds: string[] = [];
const commentIds: string[] = [];
const favoriteIds: string[] = [];
const positionIds: string[] = [];
const blockIds: string[] = [];
const privateWalletAddress = `0x${Array.from(
  crypto.getRandomValues(new Uint8Array(20)),
  (value) => value.toString(16).padStart(2, '0')
).join('')}`;
let agentUserId: string;
let otherUserId: string;
let privateUserId: string;
let postId: string;
let marketId: string;
let activePositionId: string;
let liveCommentId: string;
let deletedCommentId: string;

async function acquireUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = userIds
) {
  const inserted = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  ownership.push(...inserted.map((row) => row.id));
  return inserted;
}

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {},
  ownership = userIds
): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await acquireUsers(
    [
      {
        id,
        username: `mcp_${id.slice(-10)}`,
        isActor: false,
        updatedAt: new Date(),
        ...overrides,
      },
    ],
    ownership
  );
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  return inserted[0].id;
}

async function createLikePost(
  authorId: string,
  overrides: Partial<typeof posts.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(posts)
    .values({
      id,
      content: 'post to like',
      authorId,
      timestamp: new Date(Date.now() - 60_000),
      ...overrides,
    })
    .returning({ id: posts.id });
  if (!inserted[0]) throw new Error('Post fixture insert returned no row');
  likePostIds.push(inserted[0].id);
  return inserted[0].id;
}

async function authorNotifications(postIdToCheck: string) {
  return db
    .select({
      userId: notifications.userId,
      type: notifications.type,
      actorId: notifications.actorId,
      postId: notifications.postId,
    })
    .from(notifications)
    .where(eq(notifications.postId, postIdToCheck));
}

async function likeReactions(postIdToCheck: string, likerId: string) {
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.postId, postIdToCheck),
        eq(reactions.userId, likerId),
        eq(reactions.type, 'like')
      )
    );
}

describe('MCP tool handlers', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    otherUserId = await createUser();
    privateUserId = await createUser({
      showWalletPublic: false,
      walletAddress: privateWalletAddress,
    });
    postId = await generateSnowflakeId();
    const insertedPosts = await db
      .insert(posts)
      .values({
        id: postId,
        content: 'favorite post',
        authorId: otherUserId,
      })
      .returning({ id: posts.id });
    postIds.push(...insertedPosts.map((row) => row.id));
    const insertedFavorites = await db
      .insert(favorites)
      .values({
        id: await generateSnowflakeId(),
        userId: agentUserId,
        targetUserId: otherUserId,
      })
      .returning({ id: favorites.id });
    favoriteIds.push(...insertedFavorites.map((row) => row.id));
    liveCommentId = await generateSnowflakeId();
    deletedCommentId = await generateSnowflakeId();
    const insertedComments = await db
      .insert(comments)
      .values([
        {
          id: liveCommentId,
          content: 'live comment',
          postId,
          authorId: otherUserId,
          updatedAt: new Date(),
        },
        {
          id: deletedCommentId,
          content: 'moderated comment',
          postId,
          authorId: otherUserId,
          updatedAt: new Date(),
          deletedAt: new Date(),
        },
      ])
      .returning({ id: comments.id });
    commentIds.push(...insertedComments.map((row) => row.id));
    marketId = await generateSnowflakeId();
    const insertedMarkets = await db
      .insert(markets)
      .values({
        id: marketId,
        question: 'Will the MCP list only open positions?',
        yesShares: '500',
        noShares: '500',
        liquidity: '1000',
        endDate: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    marketIds.push(...insertedMarkets.map((row) => row.id));
    activePositionId = await generateSnowflakeId();
    const positionRow = (id: string, side: boolean, status: string) => ({
      id,
      userId: agentUserId,
      marketId,
      side,
      shares: status === 'closed' ? '0' : '10',
      avgPrice: '0.5',
      status,
      updatedAt: new Date(),
    });
    const insertedPositions = await db
      .insert(positions)
      .values([
        positionRow(activePositionId, true, 'active'),
        positionRow(await generateSnowflakeId(), false, 'closed'),
        positionRow(await generateSnowflakeId(), true, 'resolved'),
      ])
      .returning({ id: positions.id });
    positionIds.push(...insertedPositions.map((row) => row.id));
    await db.insert(notifications).values([
      {
        id: await generateSnowflakeId(),
        userId: agentUserId,
        type: 'system',
        title: 't',
        message: 'm1',
      },
      {
        id: await generateSnowflakeId(),
        userId: agentUserId,
        type: 'system',
        title: 't',
        message: 'm2',
      },
    ]);
  });

  afterAll(async () => {
    try {
      await db
        .delete(notifications)
        .where(inArray(notifications.userId, userIds));
      await db.delete(reactions).where(inArray(reactions.userId, userIds));
      await db.delete(comments).where(inArray(comments.id, commentIds));
      await db.delete(favorites).where(inArray(favorites.id, favoriteIds));
      await db.delete(positions).where(inArray(positions.id, positionIds));
      await db.delete(markets).where(inArray(markets.id, marketIds));
      await db
        .delete(posts)
        .where(inArray(posts.id, [...postIds, ...likePostIds]));
      await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
      await db.delete(users).where(inArray(users.id, userIds));
      for (const [table, ids] of [
        [users, userIds],
        [posts, [...postIds, ...likePostIds]],
        [comments, commentIds],
        [favorites, favoriteIds],
        [positions, positionIds],
        [markets, marketIds],
        [userBlocks, blockIds],
      ] as const) {
        if (ids.length)
          expect(
            await db
              .select({ id: table.id })
              .from(table)
              .where(inArray(table.id, ids))
          ).toHaveLength(0);
      }
      expect(
        await db
          .select({ id: reactions.id })
          .from(reactions)
          .where(inArray(reactions.userId, userIds))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(inArray(notifications.userId, userIds))
      ).toHaveLength(0);
    } finally {
      await closeDatabase();
    }
  });

  it('does not acquire fixture ownership after an atomic setup collision', async () => {
    const freshId = crypto.randomUUID();
    const pending: string[] = [];
    await assert.rejects(
      acquireUsers(
        [
          { id: freshId, updatedAt: new Date() },
          { id: agentUserId, updatedAt: new Date() },
        ],
        pending
      ),
      (error: Error) => {
        const cause = 'cause' in error ? error.cause : error;
        return (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === '23505'
        );
      }
    );
    expect(pending).toHaveLength(0);
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, freshId))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, agentUserId))
    ).toHaveLength(1);
  });

  it('counts real unread notifications and reports rows actually marked', async () => {
    expect(await executeGetUnreadCount(agent(), {})).toEqual({
      unreadCount: 2,
    });

    const own = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, agentUserId));
    const result = await executeMarkNotificationsRead(agent(), {
      notificationIds: [own[0]!.id, 'not-mine'],
    });
    expect(result.markedCount).toBe(1);
    expect(await executeGetUnreadCount(agent(), {})).toEqual({
      unreadCount: 1,
    });
  });

  it('returns posts from favorited profiles for the agent', async () => {
    const result = await executeGetFavoritePosts(agent(), {});
    expect(result.posts.map((p) => p.id)).toContain(postId);
  });

  it('respects wallet privacy for other users', async () => {
    await expect(
      executeGetUserWallet(agent(), { userId: privateUserId })
    ).rejects.toThrow('private');
    const own = await executeGetUserWallet(
      { agentId: 'agent', userId: privateUserId },
      { userId: privateUserId }
    );
    expect(own.walletAddress).toBe(privateWalletAddress);
  });

  it('rejects perpetuals on get_markets instead of returning an empty list', async () => {
    await expect(
      executeGetMarkets({ type: 'perpetuals' }, agent())
    ).rejects.toThrow('get_perpetuals');
  });

  it.each([
    { yesShares: '9000', noShares: '1000', yesPrice: 0.1, noPrice: 0.9 },
    { yesShares: '1000', noShares: '9000', yesPrice: 0.9, noPrice: 0.1 },
    { yesShares: '0', noShares: '0', yesPrice: 0.5, noPrice: 0.5 },
  ])('quotes CPMM prices for $yesShares/$noShares reserves', async (pool) => {
    const id = await generateSnowflakeId();
    const inserted = await db
      .insert(markets)
      .values({
        id,
        question: 'MCP price consistency',
        yesShares: pool.yesShares,
        noShares: pool.noShares,
        liquidity: '10000',
        endDate: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    marketIds.push(...inserted.map((row) => row.id));

    expect(
      await executeGetMarketPrices(agent(), { marketId: id })
    ).toMatchObject({
      marketId: id,
      yesPrice: pool.yesPrice,
      noPrice: pool.noPrice,
    });
  });

  it('lists only open prediction positions on get_positions', async () => {
    const result = await executeGetPositions(agent(), {});
    expect(result.positions.map((p) => p.id)).toEqual([activePositionId]);

    const filtered = await executeGetPositions(agent(), { marketId });
    expect(filtered.positions).toHaveLength(1);
    expect(filtered.positions[0]).toMatchObject({
      id: activePositionId,
      side: 'YES',
      question: 'Will the MCP list only open positions?',
    });
  });

  it('likes a live comment and notifies its author', async () => {
    const result = await executeLikeComment(agent(), {
      commentId: liveCommentId,
    });
    expect(result).toEqual({ success: true });

    const liked = await db
      .select()
      .from(reactions)
      .where(
        and(
          eq(reactions.commentId, liveCommentId),
          eq(reactions.userId, agentUserId),
          eq(reactions.type, 'like')
        )
      );
    expect(liked).toHaveLength(1);

    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, otherUserId),
          eq(notifications.commentId, liveCommentId),
          eq(notifications.type, 'reaction')
        )
      );
    expect(notes).toHaveLength(1);
  });

  it('does not like or notify twice for a repeated comment like', async () => {
    const result = await executeLikeComment(agent(), {
      commentId: liveCommentId,
    });
    expect(result).toEqual({ success: true });

    const liked = await db
      .select()
      .from(reactions)
      .where(eq(reactions.commentId, liveCommentId));
    expect(liked).toHaveLength(1);

    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, otherUserId),
          eq(notifications.commentId, liveCommentId),
          eq(notifications.type, 'reaction')
        )
      );
    expect(notes).toHaveLength(1);
  });

  it('rejects a like on an unknown comment without writing a reaction', async () => {
    const unknownId = await generateSnowflakeId();
    await expect(
      executeLikeComment(agent(), { commentId: unknownId })
    ).rejects.toThrow('Comment');

    const orphan = await db
      .select()
      .from(reactions)
      .where(eq(reactions.commentId, unknownId));
    expect(orphan).toHaveLength(0);
  });

  it('rejects a like on a soft-deleted comment without writing a reaction', async () => {
    await expect(
      executeLikeComment(agent(), { commentId: deletedCommentId })
    ).rejects.toThrow('Cannot like deleted comment');

    const liked = await db
      .select()
      .from(reactions)
      .where(eq(reactions.commentId, deletedCommentId));
    expect(liked).toHaveLength(0);
  });

  it('does not acquire cleanup ownership when user setup fails', async () => {
    const partial: string[] = [];
    const failed: string[] = [];
    let partialId = '';
    try {
      partialId = await createUser({}, partial);
      await expect(createUser({ id: agentUserId }, failed)).rejects.toThrow();
      expect(partial).toEqual([partialId]);
      expect(failed).toEqual([]);
      await db.delete(users).where(inArray(users.id, failed));
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, agentUserId));
      expect(existing).toHaveLength(1);
    } finally {
      await db.delete(users).where(inArray(users.id, partial));
    }
    const remaining = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, partialId));
    expect(remaining).toHaveLength(0);
  });

  it('notifies the post author when the agent likes a post', async () => {
    const targetPostId = await createLikePost(otherUserId);

    const result = await executeLikePost(agent(), { postId: targetPostId });

    expect(result).toEqual({ success: true, liked: true });
    expect(await likeReactions(targetPostId, agentUserId)).toHaveLength(1);
    expect(await authorNotifications(targetPostId)).toEqual([
      {
        userId: otherUserId,
        type: 'reaction',
        actorId: agentUserId,
        postId: targetPostId,
      },
    ]);
  });

  it('does not notify the author when the agent likes its own post', async () => {
    const ownPostId = await createLikePost(agentUserId);

    const result = await executeLikePost(agent(), { postId: ownPostId });

    expect(result).toEqual({ success: true, liked: true });
    expect(await likeReactions(ownPostId, agentUserId)).toHaveLength(1);
    expect(await authorNotifications(ownPostId)).toHaveLength(0);
  });

  it('notifies only once for a repeated like', async () => {
    const targetPostId = await createLikePost(otherUserId);
    const notify = spyOn(notificationService, 'notifyReactionOnPost');
    try {
      await executeLikePost(agent(), { postId: targetPostId });
      const second = await executeLikePost(agent(), { postId: targetPostId });

      expect(second).toEqual({ success: true, liked: true });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await likeReactions(targetPostId, agentUserId)).toHaveLength(1);
      expect(await authorNotifications(targetPostId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });

  it('rejects a like on a deleted post', async () => {
    const deletedPostId = await createLikePost(otherUserId, {
      deletedAt: new Date(),
    });

    await expect(
      executeLikePost(agent(), { postId: deletedPostId })
    ).rejects.toThrow('deleted');
    expect(await likeReactions(deletedPostId, agentUserId)).toHaveLength(0);
    expect(await authorNotifications(deletedPostId)).toHaveLength(0);
  });

  it('rejects a like on an unknown post', async () => {
    const unknownPostId = await generateSnowflakeId();

    await expect(
      executeLikePost(agent(), { postId: unknownPostId })
    ).rejects.toThrow('not found');
    expect(await likeReactions(unknownPostId, agentUserId)).toHaveLength(0);
    expect(await authorNotifications(unknownPostId)).toHaveLength(0);
  });

  it('rejects a future post without creating a reaction or notification', async () => {
    const futurePostId = await createLikePost(otherUserId, {
      timestamp: new Date(Date.now() + 60 * 60 * 1000),
    });
    await expect(
      executeLikePost(agent(), { postId: futurePostId })
    ).rejects.toThrow('not found');
    expect(await likeReactions(futurePostId, agentUserId)).toHaveLength(0);
    expect(await authorNotifications(futurePostId)).toHaveLength(0);
  });

  for (const direction of [
    'author-blocks-liker',
    'liker-blocks-author',
  ] as const) {
    it(`retains notification block policy: ${direction}`, async () => {
      const authorId = await createUser();
      const likerId = await createUser();
      const targetPostId = await createLikePost(authorId);
      const inserted = await db
        .insert(userBlocks)
        .values({
          id: crypto.randomUUID(),
          blockerId: direction === 'author-blocks-liker' ? authorId : likerId,
          blockedId: direction === 'author-blocks-liker' ? likerId : authorId,
        })
        .returning({ id: userBlocks.id });
      blockIds.push(...inserted.map((row) => row.id));
      const result = await executeLikePost(
        { agentId: likerId, userId: likerId },
        { postId: targetPostId }
      );
      expect(result).toEqual({ success: true, liked: true });
      expect(await likeReactions(targetPostId, likerId)).toHaveLength(1);
      expect(await authorNotifications(targetPostId)).toHaveLength(0);
    });
  }

  it('still reports the committed like when the author notification fails', async () => {
    const notify = spyOn(notificationService, 'notifyReactionOnPost');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const targetPostId = await createLikePost(otherUserId);

      const result = await executeLikePost(agent(), { postId: targetPostId });

      expect(result).toEqual({ success: true, liked: true });
      expect(await likeReactions(targetPostId, agentUserId)).toHaveLength(1);
    } finally {
      notify.mockRestore();
    }
  });
});
