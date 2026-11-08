/**
 * MCP tool handlers return real data for the authenticated agent.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
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
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeCreateComment,
  executeGetFavoritePosts,
  executeGetMarketPrices,
  executeGetMarkets,
  executeGetPositions,
  executeGetUnreadCount,
  executeGetUserWallet,
  executeMarkNotificationsRead,
} from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const marketIds: string[] = [];
let agentUserId: string;
let otherUserId: string;
let privateUserId: string;
let postId: string;
let deletedPostId: string;
let marketId: string;
let activePositionId: string;

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `mcp_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
    ...overrides,
  });
  userIds.push(id);
  return id;
}

describe('MCP tool handlers', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    agentUserId = await createUser();
    otherUserId = await createUser();
    privateUserId = await createUser({
      showWalletPublic: false,
      walletAddress: '0x00000000000000000000000000000000000000aa',
    });
    postId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: postId,
      content: 'favorite post',
      authorId: otherUserId,
    });
    deletedPostId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: deletedPostId,
      content: 'deleted post',
      authorId: otherUserId,
      deletedAt: new Date(),
    });
    await db.insert(favorites).values({
      id: await generateSnowflakeId(),
      userId: agentUserId,
      targetUserId: otherUserId,
    });
    marketId = await generateSnowflakeId();
    await db.insert(markets).values({
      id: marketId,
      question: 'Will the MCP list only open positions?',
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });
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
    await db
      .insert(positions)
      .values([
        positionRow(activePositionId, true, 'active'),
        positionRow(await generateSnowflakeId(), false, 'closed'),
        positionRow(await generateSnowflakeId(), true, 'resolved'),
      ]);
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
    await db
      .delete(reactions)
      .where(inArray(reactions.postId, [postId, deletedPostId]));
    await db
      .delete(comments)
      .where(inArray(comments.postId, [postId, deletedPostId]));
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(favorites).where(inArray(favorites.userId, userIds));
    await db.delete(positions).where(inArray(positions.userId, userIds));
    await db.delete(markets).where(eq(markets.id, marketId));
    await db.delete(markets).where(inArray(markets.id, marketIds));
    await db.delete(posts).where(eq(posts.id, postId));
    await db.delete(posts).where(eq(posts.id, deletedPostId));
    await db.delete(users).where(inArray(users.id, userIds));
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
    expect(own.walletAddress).toBe(
      '0x00000000000000000000000000000000000000aa'
    );
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
    await db.insert(markets).values({
      id,
      question: 'MCP price consistency',
      yesShares: pool.yesShares,
      noShares: pool.noShares,
      liquidity: '10000',
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });
    marketIds.push(id);

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

  it('comments on a live post via create_comment', async () => {
    const result = await executeCreateComment(agent(), {
      postId,
      content: 'live comment',
    });
    expect(result.success).toBe(true);
    const rows = await db
      .select()
      .from(comments)
      .where(eq(comments.postId, postId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe('live comment');
  });

  it('rejects comments on unknown or soft-deleted posts via create_comment', async () => {
    const unknownPostId = await generateSnowflakeId();
    await expect(
      executeCreateComment(agent(), {
        postId: unknownPostId,
        content: 'orphan comment',
      })
    ).rejects.toThrow('Post not found');
    expect(
      await db.select().from(comments).where(eq(comments.postId, unknownPostId))
    ).toHaveLength(0);

    await expect(
      executeCreateComment(agent(), {
        postId: deletedPostId,
        content: 'comment on deleted post',
      })
    ).rejects.toThrow('Post (deleted) not found');
    expect(
      await db.select().from(comments).where(eq(comments.postId, deletedPostId))
    ).toHaveLength(0);
  });
});
