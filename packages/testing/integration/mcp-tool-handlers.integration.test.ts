/**
 * MCP tool handlers return real data for the authenticated agent.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
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
  executeGetFavoritePosts,
  executeGetMarkets,
  executeGetPositions,
  executeGetUnreadCount,
  executeGetUserWallet,
  executeLikeComment,
  executeMarkNotificationsRead,
} from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
let agentUserId: string;
let otherUserId: string;
let privateUserId: string;
let postId: string;
let marketId: string;
let activePositionId: string;
let liveCommentId: string;
let deletedCommentId: string;

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
    liveCommentId = await generateSnowflakeId();
    deletedCommentId = await generateSnowflakeId();
    await db.insert(comments).values([
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
    ]);
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
    await db
      .delete(reactions)
      .where(inArray(reactions.commentId, [liveCommentId, deletedCommentId]));
    await db
      .delete(comments)
      .where(inArray(comments.id, [liveCommentId, deletedCommentId]));
    await db.delete(favorites).where(inArray(favorites.userId, userIds));
    await db.delete(positions).where(inArray(positions.userId, userIds));
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
});
