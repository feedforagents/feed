/**
 * Waitlist Service
 *
 * @description Manages waitlist signups, position tracking, and invite code
 * generation. Handles referral tracking, position calculations based on points,
 * and leaderboard rankings for waitlist participants.
 */

import {
  and,
  asc,
  count,
  db,
  desc,
  eq,
  gt,
  lt,
  ne,
  or,
  pointsTransactions,
  referrals,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId, logger, POINTS } from '@feed/shared';
import { nanoid } from 'nanoid';
import { NotFoundError } from '../errors';
import { getOrCreateReferralCode } from './referral-service';
import { ReputationService } from './reputation-service';

export interface WaitlistMarkResult {
  success: boolean;
  waitlistPosition: number;
  inviteCode: string;
  points: number;
  referrerRewarded?: boolean;
  error?: string;
}

export interface WaitlistPosition {
  waitlistPosition: number; // Historical signup order (for records)
  leaderboardRank: number; // Actual position in line (dynamic, based on points)
  totalAhead: number; // How many people are ahead (by points)
  totalCount: number; // Total people on waitlist
  percentile: number; // Top X% of waitlist
  inviteCode: string;
  points: number;
  invitePoints: number;
  earnedPoints: number;
  bonusPoints: number;
  referralCount: number;
}

export class WaitlistService {
  /**
   * Generate a unique invite code
   */
  static generateInviteCode(): string {
    return nanoid(8).toUpperCase();
  }

  /**
   * Mark an existing user as waitlisted
   *
   * @description Marks a user as waitlisted after they complete onboarding.
   * Users must be created through the normal onboarding flow before calling
   * this method. Handles referral code processing and initial point awards.
   *
   * @param {string} userId - User ID to mark as waitlisted
   * @param {string} [referralCode] - Optional referral code used during signup
   * @returns {Promise<WaitlistMarkResult>} Waitlist marking result with position and invite code
   */
  static async markAsWaitlisted(
    userId: string,
    referralCode?: string
  ): Promise<WaitlistMarkResult> {
    // Get user - they should already exist from onboarding
    const userResult = await db
      .select({
        id: users.id,
        waitlistPosition: users.waitlistPosition,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        isWaitlistActive: users.isWaitlistActive,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user) {
      throw new NotFoundError('User', undefined, {
        userId,
        message: 'User must complete onboarding before joining waitlist',
      });
    }

    // Already waitlisted: position, status and referral attribution are
    // fixed; a referral code supplied now is ignored.
    if (user.waitlistPosition && user.isWaitlistActive) {
      if (referralCode) {
        logger.info(
          `User ${userId} already waitlisted, referral code ignored`,
          { userId, referralCode },
          'WaitlistService'
        );
      }
      return {
        success: true,
        waitlistPosition: user.waitlistPosition,
        inviteCode: user.referralCode || '',
        points: user.reputationPoints,
        referrerRewarded: false,
      };
    }

    // Get the highest waitlist position
    const lastPositionResult = await db
      .select({ waitlistPosition: users.waitlistPosition })
      .from(users)
      .where(ne(users.waitlistPosition, 0))
      .orderBy(desc(users.waitlistPosition))
      .limit(1);

    const lastPosition = lastPositionResult[0];
    const newPosition = (lastPosition?.waitlistPosition || 0) + 1;

    // Use the user's referral code, creating the canonical one if missing.
    const inviteCode =
      user.referralCode || (await getOrCreateReferralCode(userId));

    // Handle referral rewards with validation
    let referrerRewarded = false;

    if (referralCode) {
      const referrerResult = await db
        .select({
          id: users.id,
          reputationPoints: users.reputationPoints,
          invitePoints: users.invitePoints,
          referralCount: users.referralCount,
        })
        .from(users)
        .where(eq(users.referralCode, referralCode))
        .limit(1);

      const referrer = referrerResult[0];

      if (referrer) {
        // PREVENT SELF-REFERRAL: Can't refer yourself!
        if (referrer.id === userId) {
          logger.warn(
            `User ${userId} attempted self-referral`,
            {
              userId,
              referralCode,
            },
            'WaitlistService'
          );
          referrerRewarded = false;
        }
        // PREVENT DOUBLE-REFERRAL: Check if user was already referred
        else if (user.referredBy) {
          logger.warn(
            `User ${userId} already referred by ${user.referredBy}, ignoring new referral`,
            {
              userId,
              existingReferrer: user.referredBy,
              attemptedReferrer: referrer.id,
            },
            'WaitlistService'
          );
          referrerRewarded = false;
        }
        // Valid referral: record the completed referral and the referredBy
        // link FIRST, then award, so the award is bookkept on the referral
        // row (signupPointsAwarded) and retries are idempotent.
        else {
          await db
            .insert(referrals)
            .values({
              id: await generateSnowflakeId(),
              referrerId: referrer.id,
              referralCode,
              referredUserId: userId,
              status: 'completed',
              completedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [referrals.referralCode, referrals.referredUserId],
              set: { status: 'completed', completedAt: new Date() },
            });
          await db
            .update(users)
            .set({ referredBy: referrer.id })
            .where(eq(users.id, userId));

          const referralResult = await ReputationService.awardReferralSignup(
            referrer.id,
            userId
          );

          if (
            referralResult.success &&
            !referralResult.alreadyAwarded &&
            referralResult.reputationAwarded > 0
          ) {
            referrerRewarded = true;
            logger.info(
              `Rewarded referrer ${referrer.id} with ${referralResult.reputationAwarded} reputation via referral system`,
              {
                referrerId: referrer.id,
                reputationAwarded: referralResult.reputationAwarded,
                newReputationTotal: referralResult.newReputationTotal,
              },
              'WaitlistService'
            );
          } else if (!referralResult.success) {
            logger.warn(
              `Failed to award referral points: ${referralResult.error}`,
              {
                referrerId: referrer.id,
                referredUserId: userId,
                error: referralResult.error,
              },
              'WaitlistService'
            );
          }
        }
      } else {
        logger.warn(
          `Invalid referral code: ${referralCode}`,
          {
            userId,
            referralCode,
          },
          'WaitlistService'
        );
      }
    }

    // Update user as waitlisted
    // IMPORTANT: Don't change reputationPoints here - they should already have correct amount from onboarding
    // referredBy is already set above if referral was processed
    await db
      .update(users)
      .set({
        waitlistPosition: newPosition,
        waitlistJoinedAt: new Date(),
        isWaitlistActive: true,
        referralCode: inviteCode,
      })
      .where(eq(users.id, userId));

    logger.info(
      'User marked as waitlisted',
      {
        userId,
        position: newPosition,
        referrerRewarded,
      },
      'WaitlistService'
    );

    return {
      success: true,
      waitlistPosition: newPosition,
      inviteCode,
      points: user.reputationPoints,
      referrerRewarded,
    };
  }

  /**
   * Graduate a user from waitlist to full access
   */
  static async graduateFromWaitlist(userId: string): Promise<boolean> {
    await db
      .update(users)
      .set({
        isWaitlistActive: false,
        waitlistGraduatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info('User graduated from waitlist', { userId }, 'WaitlistService');
    return true;
  }

  /**
   * Get user's waitlist position and stats
   * CRITICAL: Position is based on INVITE POINTS (leaderboard rank), not signup order!
   * This creates the viral loop incentive.
   */
  static async getWaitlistPosition(
    userId: string
  ): Promise<WaitlistPosition | null> {
    const userResult = await db
      .select({
        waitlistPosition: users.waitlistPosition,
        waitlistJoinedAt: users.waitlistJoinedAt,
        isWaitlistActive: users.isWaitlistActive,
        referralCode: users.referralCode,
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        referralCount: users.referralCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user || !user.isWaitlistActive) {
      return null;
    }

    // Count users ahead in line based on INVITE POINTS (viral loop!)
    // Users with more invites are closer to the front
    const userJoinedAt = user.waitlistJoinedAt || new Date();

    const [usersAheadResult] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(
          eq(users.isWaitlistActive, true),
          or(
            // Primary sort: More invite points = better position
            gt(users.invitePoints, user.invitePoints),
            // Tie-breaker: If same invite points, earlier signup wins
            and(
              eq(users.invitePoints, user.invitePoints),
              lt(users.waitlistJoinedAt, userJoinedAt)
            )
          )
        )
      );

    const usersAhead = usersAheadResult?.count ?? 0;

    // Calculate leaderboard rank (actual position in line)
    const leaderboardRank = usersAhead + 1;

    // Get total waitlist count
    const totalCount = await WaitlistService.getTotalWaitlistCount();

    // Calculate percentile (Top X% - what percentile you're in from the top)
    const percentile =
      totalCount > 0 ? Math.round((leaderboardRank / totalCount) * 100) : 100;

    return {
      waitlistPosition: user.waitlistPosition || 0, // Historical record
      leaderboardRank, // What users see!
      totalAhead: usersAhead,
      totalCount,
      percentile,
      inviteCode: user.referralCode || '',
      points: user.reputationPoints,
      invitePoints: user.invitePoints,
      earnedPoints: user.earnedPoints,
      bonusPoints: user.bonusPoints,
      referralCount: user.referralCount,
    };
  }

  /**
   * Award the one-time bonus for a linked identity (wallet or email).
   *
   * The submitted value is never written to the account: it must equal the
   * identity already linked by the authentication provider. Accepting
   * arbitrary values let users claim other people's wallets (NFT gating
   * trusts users.walletAddress) and admin-domain emails (admin roles are
   * granted from users.email).
   *
   * The award flag is flipped with a conditional UPDATE in the same
   * transaction as the ledger insert, so concurrent requests award once.
   */
  private static async awardLinkedIdentityBonus(params: {
    userId: string;
    kind: 'wallet' | 'email';
    submitted: string;
  }): Promise<boolean> {
    const { userId, kind, submitted } = params;
    const bonusAmount =
      kind === 'wallet' ? POINTS.WALLET_CONNECT : POINTS.EMAIL_SUBMIT;
    const awardedColumn =
      kind === 'wallet'
        ? users.pointsAwardedForWallet
        : users.pointsAwardedForEmail;
    const identityColumn =
      kind === 'wallet' ? users.walletAddress : users.email;

    return db.transaction(async (tx) => {
      const conditions = [
        eq(users.id, userId),
        eq(awardedColumn, false),
        sql`lower(${identityColumn}) = ${submitted.trim().toLowerCase()}`,
      ];
      if (kind === 'email') {
        conditions.push(eq(users.isWaitlistActive, true));
      }

      const [updated] = await tx
        .update(users)
        .set({
          ...(kind === 'wallet'
            ? { pointsAwardedForWallet: true }
            : { pointsAwardedForEmail: true }),
          bonusPoints: sql`${users.bonusPoints} + ${bonusAmount}`,
          reputationPoints: sql`${users.reputationPoints} + ${bonusAmount}`,
        })
        .where(and(...conditions))
        .returning({ reputationPoints: users.reputationPoints });

      if (!updated) {
        return false;
      }

      await tx.insert(pointsTransactions).values({
        id: await generateSnowflakeId(),
        userId,
        amount: bonusAmount,
        pointsBefore: updated.reputationPoints - bonusAmount,
        pointsAfter: updated.reputationPoints,
        reason: kind === 'wallet' ? 'wallet_connect' : 'email_submit',
      });

      logger.info(
        `Awarded ${kind} bonus to user ${userId}`,
        { userId, bonusAmount },
        'WaitlistService'
      );
      return true;
    });
  }

  /**
   * Award bonus points for the wallet linked to the account. Returns false if
   * the submitted wallet is not the linked wallet or the bonus was awarded.
   */
  static async awardWalletBonus(
    userId: string,
    walletAddress: string
  ): Promise<boolean> {
    return WaitlistService.awardLinkedIdentityBonus({
      userId,
      kind: 'wallet',
      submitted: walletAddress,
    });
  }

  /**
   * Award bonus points for the verified email linked to the account. Returns
   * false if the submitted email is not the account email, the user is not
   * on the waitlist, or the bonus was already awarded.
   */
  static async awardEmailBonus(
    userId: string,
    email: string
  ): Promise<boolean> {
    return WaitlistService.awardLinkedIdentityBonus({
      userId,
      kind: 'email',
      submitted: email,
    });
  }

  /**
   * Get total waitlist count
   */
  static async getTotalWaitlistCount(): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(ne(users.waitlistPosition, 0), eq(users.isWaitlistActive, true))
      );

    return result?.count ?? 0;
  }

  /**
   * Get top waitlist users (leaderboard)
   * Sorted by invite points (most invites = best position)
   * Supports pagination with offset
   */
  static async getTopWaitlistUsers(
    limit = 10,
    offset = 0,
    pointsType: 'total' | 'invite' = 'invite'
  ) {
    // Ensure limit is reasonable
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const safeOffset = Math.max(0, offset);

    // Build orderBy based on pointsType
    const orderByColumns =
      pointsType === 'total'
        ? [
            desc(users.reputationPoints),
            desc(users.invitePoints),
            asc(users.waitlistJoinedAt),
          ]
        : [
            desc(users.invitePoints),
            desc(users.reputationPoints),
            asc(users.waitlistJoinedAt),
          ];

    const usersResult = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        // profileImageUrl removed - fetch on-demand to reduce bandwidth
        invitePoints: users.invitePoints,
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
        waitlistJoinedAt: users.waitlistJoinedAt,
      })
      .from(users)
      .where(
        and(
          eq(users.isWaitlistActive, true),
          // Only include users with usernames (required for referral codes)
          ne(users.username, '')
        )
      )
      .orderBy(...orderByColumns)
      .offset(safeOffset)
      .limit(safeLimit);

    return usersResult.map((user, index) => ({
      id: user.id, // For frontend compatibility (TopUser interface expects 'id')
      userId: user.id, // Keep for backward compatibility
      username: user.username,
      displayName: user.displayName,
      // profileImageUrl removed - fetch on-demand when profile is clicked to reduce bandwidth
      points:
        pointsType === 'total' ? user.reputationPoints : user.invitePoints, // Keep for backward compatibility
      invitePoints: user.invitePoints, // For frontend TopUser interface
      reputationPoints: user.reputationPoints, // For frontend TopUser interface
      referralCount: user.referralCount,
      rank: safeOffset + index + 1, // Adjust rank based on offset
    }));
  }
}
