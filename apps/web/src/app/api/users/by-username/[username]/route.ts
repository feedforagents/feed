/**
 * User Lookup by Username API
 *
 * @route GET /api/users/by-username/[username] - Get user by username
 * @access Public
 *
 * @description
 * Retrieves user profile by username with comprehensive profile data including
 * stats, social connections, on-chain status, and social media links.
 *
 * @openapi
 * /api/users/by-username/{username}:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user by username
 *     description: Returns complete user profile by username lookup
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to lookup
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     displayName:
 *                       type: string
 *                     bio:
 *                       type: string
 *                     profileImageUrl:
 *                       type: string
 *                     stats:
 *                       type: object
 *                       properties:
 *                         positions:
 *                           type: integer
 *                         comments:
 *                           type: integer
 *                         reactions:
 *                           type: integer
 *                         followers:
 *                           type: integer
 *                         following:
 *                           type: integer
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users/by-username/alice');
 * const { user } = await response.json();
 * console.log(`${user.displayName} (@${user.username})`);
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  addPublicReadHeaders,
  NotFoundError,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  comments,
  count,
  db,
  eq,
  followStatuses,
  follows,
  like,
  not,
  positions,
  reactions,
  sql,
  userActorFollows,
  users,
} from '@feed/db';
import { logger, toISO, UsernameParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/users/by-username/[username]
 * Get user profile by username
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ username: string }> }
  ) => {
    const params = await context.params;
    const { username } = UsernameParamSchema.parse(params);

    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    // Get user profile by username (case-insensitive)
    const [dbUser] = await db
      .select({
        id: users.id,
        walletAddress: users.walletAddress,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
        profileImageUrl: users.profileImageUrl,
        coverImageUrl: users.coverImageUrl,
        isActor: users.isActor,
        isAgent: users.isAgent,
        managedBy: users.managedBy,
        profileComplete: users.profileComplete,
        hasUsername: users.hasUsername,
        hasBio: users.hasBio,
        hasProfileImage: users.hasProfileImage,
        nftTokenId: users.nftTokenId,
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
        referralCode: users.referralCode,
        hasTwitter: users.hasTwitter,
        twitterUsername: users.twitterUsername,
        showTwitterPublic: users.showTwitterPublic,
        showWalletPublic: users.showWalletPublic,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);

    if (!dbUser) {
      throw new NotFoundError('User', username);
    }

    // Get counts for stats
    const [
      [positionCount],
      [commentCount],
      [reactionCount],
      [followerCount],
      [npcFollowerCount],
      [followingCount],
      [actorFollowingCount],
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(positions)
        .where(eq(positions.userId, dbUser.id)),
      db
        .select({ count: count() })
        .from(comments)
        .where(eq(comments.authorId, dbUser.id)),
      db
        .select({ count: count() })
        .from(reactions)
        .where(eq(reactions.userId, dbUser.id)),
      db
        .select({ count: count() })
        .from(follows)
        .innerJoin(users, eq(follows.followerId, users.id))
        .where(
          and(
            eq(follows.followingId, dbUser.id),
            // The followers list hides test and banned accounts, so the
            // header count must use the same membership or the two
            // disagree on the same profile screen.
            eq(users.isTest, false),
            eq(users.isBanned, false),
            not(like(users.id, 'test-%'))
          )
        ),
      // NPC followers live in FollowStatus (written by the engine when an
      // NPC follows this user). The followers list includes them with this
      // same filter, so the profile count must include them too.
      db
        .select({ count: count() })
        .from(followStatuses)
        .where(
          and(
            eq(followStatuses.userId, dbUser.id),
            eq(followStatuses.isActive, true),
            not(eq(followStatuses.followReason, 'user_followed'))
          )
        ),
      db
        .select({ count: count() })
        .from(follows)
        .innerJoin(users, eq(follows.followingId, users.id))
        .where(
          and(
            eq(follows.followerId, dbUser.id),
            // Same hidden-tier membership as the following list.
            eq(users.isTest, false),
            eq(users.isBanned, false),
            not(like(users.id, 'test-%'))
          )
        ),
      // Actor follows live in their own table; the by-id profile stats
      // (CachedDatabaseService.getUserProfileStats) and the following list
      // both add them to the following total.
      db
        .select({ count: count() })
        .from(userActorFollows)
        .where(eq(userActorFollows.userId, dbUser.id)),
    ]);

    logger.info(
      'User profile fetched by username',
      { username, userId: dbUser.id },
      'GET /api/users/by-username/[username]'
    );

    const res = successResponse({
      user: {
        id: dbUser.id,
        // Respect the owner's public visibility settings for linked identities.
        walletAddress: dbUser.showWalletPublic ? dbUser.walletAddress : null,
        username: dbUser.username,
        displayName: dbUser.displayName,
        bio: dbUser.bio,
        profileImageUrl: dbUser.profileImageUrl,
        coverImageUrl: dbUser.coverImageUrl,
        isActor: dbUser.isActor,
        isAgent: dbUser.isAgent,
        managedBy: dbUser.managedBy,
        profileComplete: dbUser.profileComplete,
        hasUsername: dbUser.hasUsername,
        hasBio: dbUser.hasBio,
        hasProfileImage: dbUser.hasProfileImage,
        nftTokenId: dbUser.nftTokenId,
        virtualBalance: Number(dbUser.virtualBalance ?? 0),
        lifetimePnL: Number(dbUser.lifetimePnL ?? 0),
        reputationPoints: dbUser.reputationPoints,
        referralCount: dbUser.referralCount,
        referralCode: dbUser.referralCode,
        hasTwitter: dbUser.hasTwitter,
        twitterUsername: dbUser.showTwitterPublic
          ? dbUser.twitterUsername
          : null,
        createdAt: toISO(dbUser.createdAt),
        stats: {
          positions: Number(positionCount?.count || 0),
          comments: Number(commentCount?.count || 0),
          reactions: Number(reactionCount?.count || 0),
          followers:
            Number(followerCount?.count || 0) +
            Number(npcFollowerCount?.count || 0),
          following:
            Number(followingCount?.count || 0) +
            Number(actorFollowingCount?.count || 0),
        },
      },
    });
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
