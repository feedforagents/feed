/**
 * MCP tool handlers return real data for the authenticated agent.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  eq,
  favorites,
  inArray,
  markets,
  notifications,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeGetFavoritePosts,
  executeGetMarketPrices,
  executeGetMarkets,
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
    await db.insert(favorites).values({
      id: await generateSnowflakeId(),
      userId: agentUserId,
      targetUserId: otherUserId,
    });
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
    await db.delete(markets).where(inArray(markets.id, marketIds));
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(favorites).where(inArray(favorites.userId, userIds));
    await db.delete(posts).where(eq(posts.id, postId));
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
});
