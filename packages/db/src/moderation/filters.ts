/**
 * Moderation Filters
 *
 * Helper functions for filtering content based on user blocks and mutes.
 * Used to exclude blocked or muted users from feeds and search results.
 */

import { generateSnowflakeId } from '@feed/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../db';
import { db, withTransaction } from '../db';
import { follows, userBlocks, userMutes } from '../schema';

/**
 * Get list of user IDs that the current user has blocked.
 *
 * @param userId - Current user's ID
 * @returns Array of blocked user IDs
 */
export async function getBlockedUserIds(
  userId: string,
  database: Pick<Transaction, 'select'> = db
): Promise<string[]> {
  const blocks = await database
    .select({ blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, userId));

  return blocks.map((b) => b.blockedId);
}

/**
 * Get list of user IDs that have blocked the current user.
 *
 * @param userId - Current user's ID
 * @returns Array of user IDs who have blocked the current user
 */
export async function getBlockedByUserIds(
  userId: string,
  database: Pick<Transaction, 'select'> = db
): Promise<string[]> {
  const blocks = await database
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(eq(userBlocks.blockedId, userId));

  return blocks.map((b) => b.blockerId);
}

/**
 * Get list of user IDs that the current user has muted.
 *
 * @param userId - Current user's ID
 * @returns Array of muted user IDs
 */
export async function getMutedUserIds(userId: string): Promise<string[]> {
  const mutes = await db
    .select({ mutedId: userMutes.mutedId })
    .from(userMutes)
    .where(eq(userMutes.muterId, userId));

  return mutes.map((m) => m.mutedId);
}

/**
 * Get user IDs with a block relationship in either direction.
 * Pass the primary reader when the result controls a write.
 *
 * @param userId - Current user's ID
 * @returns Array of user IDs in either block direction
 */
export async function getFilteredUserIds(
  userId: string,
  database: Pick<Transaction, 'select'> = db
): Promise<string[]> {
  const [blockedByMe, blockedMe] = await Promise.all([
    getBlockedUserIds(userId, database),
    getBlockedByUserIds(userId, database),
  ]);

  return [...new Set([...blockedByMe, ...blockedMe])];
}

/**
 * Check if one user has blocked another user.
 *
 * @param blockerId - ID of the user who may have blocked
 * @param blockedId - ID of the user who may be blocked
 * @param tx - Optional transaction to read from, so a block committed by a
 * concurrent write serialized on the same pair lock is visible
 * @returns True if blockerId has blocked blockedId
 */
export async function hasBlocked(
  blockerId: string,
  blockedId: string,
  tx?: Pick<Transaction, 'select'>
): Promise<boolean> {
  const block = await (tx ?? db)
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId)
      )
    )
    .limit(1);

  return block.length > 0;
}

/**
 * Take the transaction-scoped advisory lock shared by the follow and block
 * writes for one unordered user pair. The key is order-independent, so a
 * follow and a block for the same two users serialize against each other
 * no matter which direction each one runs in: whichever transaction takes
 * the lock first completes before the other reads block state. Reading the
 * block state before taking this lock leaves a window where a block
 * committed mid-follow leaves both a block and a follow behind.
 *
 * Must be the first statement of the follow and block transactions.
 */
export async function acquireUserBlockPairLock(
  tx: Transaction,
  userIdA: string,
  userIdB: string
): Promise<void> {
  const [first, second] = [userIdA, userIdB].sort();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'user-block-pair:' + first + ':' + second}))`
  );
}

/** Create an agent follow under the same pair lock used by block writers. */
export async function followUserWithBlockCheck(
  followerId: string,
  followingId: string
): Promise<boolean> {
  return withTransaction(async (tx) => {
    await acquireUserBlockPairLock(tx, followerId, followingId);
    const [targetBlockedMe, iBlockedTarget] = await Promise.all([
      hasBlocked(followingId, followerId, tx),
      hasBlocked(followerId, followingId, tx),
    ]);
    if (targetBlockedMe || iBlockedTarget) {
      throw new Error('Cannot follow this user');
    }
    const [created] = await tx
      .insert(follows)
      .values({ id: await generateSnowflakeId(), followerId, followingId })
      .onConflictDoNothing({
        target: [follows.followerId, follows.followingId],
      })
      .returning({ id: follows.id });
    return Boolean(created);
  });
}

/**
 * Check if one user has muted another user.
 *
 * @param muterId - ID of the user who may have muted
 * @param mutedId - ID of the user who may be muted
 * @returns True if muterId has muted mutedId
 */
export async function hasMuted(
  muterId: string,
  mutedId: string
): Promise<boolean> {
  const mute = await db
    .select({ muterId: userMutes.muterId })
    .from(userMutes)
    .where(and(eq(userMutes.muterId, muterId), eq(userMutes.mutedId, mutedId)))
    .limit(1);

  return mute.length > 0;
}

/**
 * Filter an array of posts to exclude those from blocked or muted users.
 *
 * @param posts - Array of posts to filter
 * @param blockedUserIds - Array of blocked user IDs
 * @param mutedUserIds - Array of muted user IDs (default: empty array)
 * @returns Filtered array of posts
 */
export function filterPostsByModeration<T extends { authorId?: string }>(
  posts: T[],
  blockedUserIds: string[],
  mutedUserIds: string[] = []
): T[] {
  const excludedIds = new Set([...blockedUserIds, ...mutedUserIds]);

  return posts.filter((post) => {
    if (!post.authorId) return true;
    return !excludedIds.has(post.authorId);
  });
}

/**
 * Build a where clause object to exclude blocked users from queries.
 *
 * @param blockedUserIds - Array of blocked user IDs
 * @returns Where clause object with authorId notIn condition, or empty object if no blocked users
 */
export function buildBlockedUsersWhereClause(blockedUserIds: string[]) {
  if (blockedUserIds.length === 0) {
    return {};
  }

  return {
    authorId: {
      notIn: blockedUserIds,
    },
  };
}
