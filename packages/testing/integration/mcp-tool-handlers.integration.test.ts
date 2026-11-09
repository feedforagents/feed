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
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeCreateComment,
  executeGetFavoritePosts,
  executeGetMarkets,
  executeGetPositions,
  executeGetUnreadCount,
  executeGetUserWallet,
  executeMarkNotificationsRead,
} from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const blockIds: string[] = [];
const commentTestPostIds: string[] = [];
let agentUserId: string;
let otherUserId: string;
let privateUserId: string;
let postId: string;
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
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(favorites).where(inArray(favorites.userId, userIds));
    await db.delete(positions).where(inArray(positions.userId, userIds));
    await db
      .delete(comments)
      .where(inArray(comments.postId, commentTestPostIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(posts).where(inArray(posts.id, commentTestPostIds));
    await db.delete(markets).where(eq(markets.id, marketId));
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

  for (const direction of [
    'author-blocks-commenter',
    'commenter-blocks-author',
  ] as const) {
    it(`rejects create_comment when a block stands: ${direction}`, async () => {
      const authorId = await createUser();
      const targetPostId = await generateSnowflakeId();
      commentTestPostIds.push(targetPostId);
      await db.insert(posts).values({
        id: targetPostId,
        content: 'blocked post',
        authorId,
      });
      const inserted = await db
        .insert(userBlocks)
        .values({
          id: crypto.randomUUID(),
          blockerId:
            direction === 'author-blocks-commenter' ? authorId : agentUserId,
          blockedId:
            direction === 'author-blocks-commenter' ? agentUserId : authorId,
        })
        .returning({ id: userBlocks.id });
      blockIds.push(...inserted.map((row) => row.id));
      await expect(
        executeCreateComment(agent(), {
          postId: targetPostId,
          content: 'hello',
        })
      ).rejects.toThrow('Cannot comment on this post');
      expect(
        await db
          .select({ id: comments.id })
          .from(comments)
          .where(eq(comments.postId, targetPostId))
      ).toHaveLength(0);
    });
  }

  it('comments on a live post via create_comment when no block stands', async () => {
    const result = await executeCreateComment(agent(), {
      postId,
      content: 'hello',
    });
    expect(result.success).toBe(true);
    expect(result.commentId).toBeTruthy();
    expect(
      await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.postId, postId))
    ).toHaveLength(1);
  });
});
