/**
 * Reputation Service
 *
 * @description Centralized service for managing non-spendable reputation and
 * progression rewards. Tracks reputation transactions, prevents duplicate
 * awards, and provides leaderboard functionality. Trading balance funding is
 * handled by TradingBalanceFundingService.
 */

import {
  actorState,
  and,
  asc,
  count,
  db,
  desc,
  eq,
  gt,
  gte,
  isNull,
  type JsonValue,
  lt,
  ne,
  or,
  pointsTransactions,
  referrals,
  sql,
  type Transaction,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import {
  generateSnowflakeId,
  logger,
  POINTS,
  type PointsReason,
} from '@feed/shared';
import type {
  LeaderboardPosition,
  LeaderboardResult,
  LeaderboardScope,
} from './leaderboard-types';

/**
 * Leaderboard category type (legacy — used by existing getLeaderboard)
 */
type LeaderboardCategory = 'all' | 'earned' | 'referral';

/**
 * Result of awarding reputation to a user.
 *
 * @description Contains success status, reputation awarded, new total, and optional
 * error information.
 */
export interface AwardReputationResult {
  success: boolean;
  reputationAwarded: number;
  newReputationTotal: number;
  alreadyAwarded?: boolean;
  error?: string;
  /**
   * @deprecated Use reputationAwarded.
   */
  pointsAwarded: number;
  /**
   * @deprecated Use newReputationTotal.
   */
  newTotal: number;
}

/**
 * Reputation history entry returned by the canonical API/service contract.
 */
export interface ReputationHistoryItem {
  id: string;
  userId: string;
  reputationDelta: number;
  reputationBefore: number;
  reputationAfter: number;
  reason: string;
  metadata: string | null;
  createdAt: Date;
}

function buildAwardReputationResult(
  reputationAwarded: number,
  newReputationTotal: number,
  extras?: Partial<
    Pick<AwardReputationResult, 'success' | 'alreadyAwarded' | 'error'>
  >
): AwardReputationResult {
  return {
    success: extras?.success ?? true,
    reputationAwarded,
    newReputationTotal,
    alreadyAwarded: extras?.alreadyAwarded,
    error: extras?.error,
    pointsAwarded: reputationAwarded,
    newTotal: newReputationTotal,
  };
}

/**
 * Reputation Service Class
 *
 * @description Static service class for managing reputation and progression
 * rewards. Provides methods for awarding reputation, checking duplicates, and
 * retrieving leaderboards.
 */
export class ReputationService {
  /**
   * Award reputation to a user with transaction tracking.
   */
  static async awardReputation(
    userId: string,
    amount: number,
    reason: PointsReason,
    metadata?: Record<string, JsonValue>
  ): Promise<AwardReputationResult> {
    return db.transaction((tx) =>
      ReputationService.awardReputationInTx(
        tx,
        userId,
        amount,
        reason,
        metadata
      )
    );
  }

  /**
   * Transaction-aware award primitive. Locks the user row, checks one-time
   * flags, updates counters and writes the ledger entry within `tx`, so
   * callers can combine the award with their own claim in one transaction.
   */
  static async awardReputationInTx(
    tx: Transaction,
    userId: string,
    amount: number,
    reason: PointsReason,
    metadata?: Record<string, JsonValue>
  ): Promise<AwardReputationResult> {
    if (!Number.isSafeInteger(amount))
      throw new Error('Reputation award amount must be a finite integer');
    // Lock the row before reading counters or one-time award flags.
    const userResult = await tx
      .select({
        reputationPoints: users.reputationPoints,
        invitePoints: users.invitePoints,
        earnedPoints: users.earnedPoints,
        bonusPoints: users.bonusPoints,
        pointsAwardedForProfile: users.pointsAwardedForProfile,
        pointsAwardedForTwitter: users.pointsAwardedForTwitter,
        pointsAwardedForTwitterFollow: users.pointsAwardedForTwitterFollow,
        pointsAwardedForDiscord: users.pointsAwardedForDiscord,
        pointsAwardedForDiscordJoin: users.pointsAwardedForDiscordJoin,
        pointsAwardedForWallet: users.pointsAwardedForWallet,
        pointsAwardedForReferralBonus: users.pointsAwardedForReferralBonus,
        pointsAwardedForShare: users.pointsAwardedForShare,
        pointsAwardedForPrivateGroup: users.pointsAwardedForPrivateGroup,
        pointsAwardedForPrivateChannel: users.pointsAwardedForPrivateChannel,
        pointsAwardedForTelegram: users.pointsAwardedForTelegram,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');

    const user = userResult[0];

    if (!user) {
      return buildAwardReputationResult(0, 0, {
        success: false,
        error: 'User not found',
      });
    }

    // Check if reputation was already awarded for this reason
    const alreadyAwarded = ReputationService.checkAlreadyAwarded(user, reason);
    if (alreadyAwarded) {
      return buildAwardReputationResult(0, user.reputationPoints, {
        alreadyAwarded: true,
      });
    }

    for (const value of [
      user.reputationPoints,
      user.invitePoints,
      user.bonusPoints,
    ]) {
      if (!Number.isSafeInteger(value))
        throw new Error(`Invalid reputation counters for ${userId}`);
    }
    const reputationBefore = user.reputationPoints;
    const reputationAfter = reputationBefore + amount;

    // Build update data
    const updateData: Partial<{
      reputationPoints: number;
      invitePoints: number;
      bonusPoints: number;
      pointsAwardedForProfile: boolean;
      pointsAwardedForTwitter: boolean;
      pointsAwardedForTwitterFollow: boolean;
      pointsAwardedForDiscord: boolean;
      pointsAwardedForDiscordJoin: boolean;
      pointsAwardedForWallet: boolean;
      pointsAwardedForReferralBonus: boolean;
      pointsAwardedForShare: boolean;
      pointsAwardedForPrivateGroup: boolean;
      pointsAwardedForPrivateChannel: boolean;
      pointsAwardedForTelegram: boolean;
    }> = {
      reputationPoints: reputationAfter,
    };

    // Set the appropriate tracking flag and update the correct reputation bucket.
    switch (reason) {
      case 'referral_signup':
        updateData.invitePoints = user.invitePoints + amount;
        break;
      case 'profile_completion':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForProfile = true;
        break;
      case 'twitter_link':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForTwitter = true;
        break;
      case 'twitter_follow':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForTwitterFollow = true;
        break;
      case 'discord_link':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForDiscord = true;
        break;
      case 'discord_join':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForDiscordJoin = true;
        break;
      case 'telegram_link':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForTelegram = true;
        break;
      case 'wallet_connect':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForWallet = true;
        break;
      case 'referral_bonus':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForReferralBonus = true;
        break;
      case 'share_action':
      case 'share_to_twitter':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForShare = true;
        break;
      case 'private_group_create':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForPrivateGroup = true;
        break;
      case 'private_channel_create':
        updateData.bonusPoints = user.bonusPoints + amount;
        updateData.pointsAwardedForPrivateChannel = true;
        break;
      default:
        // For generic reputation rewards, add to bonus points.
        updateData.bonusPoints = user.bonusPoints + amount;
        break;
    }

    // Counter mutation and its ledger entry commit together.
    await tx.update(users).set(updateData).where(eq(users.id, userId));

    await tx.insert(pointsTransactions).values({
      id: await generateSnowflakeId(),
      userId,
      amount,
      pointsBefore: reputationBefore,
      pointsAfter: reputationAfter,
      reason,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });

    logger.info(
      `Awarded ${amount} reputation to user ${userId} for ${reason}`,
      { userId, amount, reason, reputationBefore, reputationAfter },
      'ReputationService'
    );

    return buildAwardReputationResult(amount, reputationAfter);
  }

  /**
   * @deprecated Use awardReputation.
   */
  static async awardPoints(
    userId: string,
    amount: number,
    reason: PointsReason,
    metadata?: Record<string, JsonValue>
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(userId, amount, reason, metadata);
  }

  /**
   * Award reputation for profile completion (username + image + bio).
   */
  static async awardProfileCompletion(
    userId: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.PROFILE_COMPLETION,
      'profile_completion'
    );
  }

  /**
   * Award reputation for Twitter follow.
   */
  static async awardTwitterFollow(
    userId: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.TWITTER_FOLLOW,
      'twitter_follow',
      { action: 'follow_playfeed' }
    );
  }

  static async awardDiscordLink(
    userId: string,
    discordUsername?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.DISCORD_LINK,
      'discord_link',
      discordUsername ? { discordUsername } : undefined
    );
  }

  static async awardDiscordJoin(
    userId: string,
    discordUsername?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.DISCORD_JOIN,
      'discord_join',
      discordUsername ? { discordUsername } : undefined
    );
  }

  static async awardTelegramLink(
    userId: string,
    telegramUsername?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.TELEGRAM_LINK,
      'telegram_link',
      telegramUsername ? { telegramUsername } : undefined
    );
  }

  /**
   * Award reputation for Twitter link.
   */
  static async awardTwitterLink(
    userId: string,
    twitterUsername?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.TWITTER_LINK,
      'twitter_link',
      twitterUsername ? { twitterUsername } : undefined
    );
  }

  /**
   * Award reputation for wallet connection.
   */
  static async awardWalletConnect(
    userId: string,
    walletAddress?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.WALLET_CONNECT,
      'wallet_connect',
      walletAddress ? { walletAddress } : undefined
    );
  }

  /**
   * Award reputation for a share action.
   */
  static async awardShareAction(
    userId: string,
    platform: string,
    contentType: string,
    contentId?: string
  ): Promise<AwardReputationResult> {
    const amount =
      platform === 'twitter' ? POINTS.SHARE_TO_TWITTER : POINTS.SHARE_ACTION;
    const reason = platform === 'twitter' ? 'share_to_twitter' : 'share_action';

    return ReputationService.awardReputation(userId, amount, reason, {
      platform,
      contentType,
      ...(contentId ? { contentId } : {}),
    });
  }

  /**
   * Award reputation for creating a private group.
   */
  static async awardPrivateGroupCreate(
    userId: string,
    groupId?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.PRIVATE_GROUP_CREATE,
      'private_group_create',
      groupId ? { groupId } : undefined
    );
  }

  /**
   * Award reputation for creating a private channel.
   */
  static async awardPrivateChannelCreate(
    userId: string,
    channelId?: string
  ): Promise<AwardReputationResult> {
    return ReputationService.awardReputation(
      userId,
      POINTS.PRIVATE_CHANNEL_CREATE,
      'private_channel_create',
      channelId ? { channelId } : undefined
    );
  }

  /**
   * Award reputation for referral signup.
   * Enforces rolling limit of 10 unqualified referrals at any time
   * When limit is reached, the referral is tracked but reputation is deferred until a slot opens
   * Checks IP addresses to detect self-referrals
   */
  static async awardReferralSignup(
    referrerId: string,
    referredUserId: string
  ): Promise<AwardReputationResult> {
    // Check IP addresses and other identifiers for self-referral detection
    const [referrerResult, referredUserResult] = await Promise.all([
      db
        .select({
          registrationIpHash: users.registrationIpHash,
          createdAt: users.createdAt,
          walletAddress: users.walletAddress,
          privyId: users.privyId,
          twitterId: users.twitterId,
        })
        .from(users)
        .where(eq(users.id, referrerId))
        .limit(1),
      db
        .select({
          registrationIpHash: users.registrationIpHash,
          createdAt: users.createdAt,
          walletAddress: users.walletAddress,
          privyId: users.privyId,
          twitterId: users.twitterId,
        })
        .from(users)
        .where(eq(users.id, referredUserId))
        .limit(1),
    ]);

    const referrer = referrerResult[0];
    const referredUser = referredUserResult[0];

    // Check if IP addresses match (potential self-referral)
    if (referrer?.registrationIpHash && referredUser?.registrationIpHash) {
      if (referrer.registrationIpHash === referredUser.registrationIpHash) {
        const timeDiff =
          referredUser.createdAt.getTime() - referrer.createdAt.getTime();
        const fifteenMinutes = 15 * 60 * 1000;
        const twentyFourHours = 24 * 60 * 60 * 1000;

        // Check if users have different identifiers
        const hasDifferentWallet =
          referrer.walletAddress &&
          referredUser.walletAddress &&
          referrer.walletAddress !== referredUser.walletAddress;
        const hasDifferentPrivyId =
          referrer.privyId &&
          referredUser.privyId &&
          referrer.privyId !== referredUser.privyId;
        const hasDifferentTwitter =
          referrer.twitterId &&
          referredUser.twitterId &&
          referrer.twitterId !== referredUser.twitterId;

        const hasDifferentIdentifiers =
          hasDifferentWallet || hasDifferentPrivyId || hasDifferentTwitter;

        // Only block if same IP AND no different identifiers AND within 15 minutes
        if (
          timeDiff >= 0 &&
          timeDiff < fifteenMinutes &&
          !hasDifferentIdentifiers
        ) {
          logger.warn(
            'Self-referral detected: same IP within 15 minutes with no different identifiers',
            {
              referrerId,
              referredUserId,
              timeDiffMs: timeDiff,
              referrerWallet: referrer.walletAddress,
              referredWallet: referredUser.walletAddress,
              referrerPrivyId: referrer.privyId,
              referredPrivyId: referredUser.privyId,
            },
            'ReputationService'
          );
          return buildAwardReputationResult(0, 0, {
            success: false,
            error:
              'Self-referral detected: accounts created from same IP within 15 minutes with no different identifiers',
          });
        }

        // Same IP within 24 hours is logged for review. The signup does not pay points.
        if (
          timeDiff >= 0 &&
          timeDiff < twentyFourHours &&
          !hasDifferentIdentifiers
        ) {
          logger.warn(
            'Potential self-referral: same IP within 24 hours with no different identifiers',
            {
              referrerId,
              referredUserId,
              timeDiffMs: timeDiff,
              referrerWallet: referrer.walletAddress,
              referredWallet: referredUser.walletAddress,
            },
            'ReputationService'
          );
          // Continue. The signup records the referral and does not pay points.
        } else if (hasDifferentIdentifiers) {
          logger.info(
            'Allowing referral despite same IP: users have different identifiers',
            {
              referrerId,
              referredUserId,
              timeDiffMs: timeDiff,
              hasDifferentWallet,
              hasDifferentPrivyId,
              hasDifferentTwitter,
            },
            'ReputationService'
          );
        }
      }
    }

    // Everything below runs in one transaction serialized on the referrer
    // row: the quota count, the per-referral idempotency check, the award,
    // and the referral bookkeeping cannot interleave with another award for
    // the same referrer, and a retried request cannot pay twice.
    return db.transaction(async (tx) => {
      const [referrerRow] = await tx
        .select({ reputationPoints: users.reputationPoints })
        .from(users)
        .where(eq(users.id, referrerId))
        .for('update');
      if (!referrerRow) {
        return buildAwardReputationResult(0, 0, {
          success: false,
          error: 'Referrer not found',
        });
      }

      if (
        await ReputationService.hasReferralSignupAward(
          tx,
          referrerId,
          referredUserId
        )
      ) {
        return buildAwardReputationResult(0, referrerRow.reputationPoints, {
          alreadyAwarded: true,
        });
      }

      // Do not credit the referrer. PRD §9.6 removes referral signup rewards
      // and onboarding point bonuses. D-18 says points cannot be transferred
      // between users. The referral row is still recorded by the caller.
      const result = buildAwardReputationResult(
        0,
        referrerRow.reputationPoints
      );

      const [referralRecord] = await tx
        .select({ id: referrals.id })
        .from(referrals)
        .where(
          and(
            eq(referrals.referrerId, referrerId),
            eq(referrals.referredUserId, referredUserId)
          )
        )
        .orderBy(desc(referrals.createdAt))
        .limit(1);

      if (referralRecord) {
        const updateData: {
          signupPointsAwarded: boolean;
          suspiciousReferralFlags?: JsonValue;
        } = { signupPointsAwarded: false };

        if (
          referrer?.registrationIpHash &&
          referredUser?.registrationIpHash &&
          referrer.registrationIpHash === referredUser.registrationIpHash
        ) {
          const timeDiff =
            referredUser.createdAt.getTime() - referrer.createdAt.getTime();
          const oneHour = 60 * 60 * 1000;
          const twentyFourHours = 24 * 60 * 60 * 1000;
          const isSuspicious = timeDiff >= 0 && timeDiff < twentyFourHours;
          const isBlocked = timeDiff >= 0 && timeDiff < oneHour;
          if (isSuspicious || isBlocked) {
            updateData.suspiciousReferralFlags = {
              sameIp: true,
              timeDiffMs: timeDiff,
              flaggedAt: new Date().toISOString(),
              blocked: isBlocked,
              flagged: isSuspicious && !isBlocked,
            };
          }
        }

        await tx
          .update(referrals)
          .set(updateData)
          .where(eq(referrals.id, referralRecord.id));
      }

      return result;
    });
  }

  /**
   * Whether the referrer already received signup reputation for this
   * referred user (ledger-based, so it holds even without a Referral row).
   */
  private static async hasReferralSignupAward(
    tx: Transaction,
    referrerId: string,
    referredUserId: string
  ): Promise<boolean> {
    const [existing] = await tx
      .select({ id: pointsTransactions.id })
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.userId, referrerId),
          eq(pointsTransactions.reason, 'referral_signup'),
          // metadata is JSON text written by awardReputationInTx; match the
          // exact serialized key/value without casting legacy rows.
          sql`position(${`"referredUserId":${JSON.stringify(referredUserId)}`} in ${pointsTransactions.metadata}) > 0`
        )
      )
      .limit(1);
    return existing !== undefined;
  }

  /**
   * Deferred signup rewards used to pay a queued referrer. PRD §9.6 removes
   * that credit, so a newly qualified referral does not release one.
   */
  static async awardPendingReferralSignupPoints(
    _referrerId: string
  ): Promise<AwardReputationResult | null> {
    return null;
  }

  /**
   * Check and qualify referral when a referred user links a social account.
   */
  static async checkAndQualifyReferral(
    referredUserId: string
  ): Promise<AwardReputationResult | null> {
    // Get user with referrer info and social account status
    const userResult = await db
      .select({
        referredBy: users.referredBy,
        hasTwitter: users.hasTwitter,
        walletAddress: users.walletAddress,
      })
      .from(users)
      .where(eq(users.id, referredUserId))
      .limit(1);

    const user = userResult[0];

    if (!user || !user.referredBy) {
      return null;
    }

    // Check if user has at least one social account linked
    const hasSocialAccount = user.hasTwitter || !!user.walletAddress;
    if (!hasSocialAccount) {
      return null;
    }

    // Find the referral record
    const referralResult = await db
      .select({
        id: referrals.id,
        qualifiedAt: referrals.qualifiedAt,
      })
      .from(referrals)
      .where(
        and(
          eq(referrals.referrerId, user.referredBy),
          eq(referrals.referredUserId, referredUserId),
          eq(referrals.status, 'completed')
        )
      )
      .orderBy(desc(referrals.completedAt))
      .limit(1);

    const referral = referralResult[0];

    if (!referral) {
      logger.warn(
        `No referral record found for referrer ${user.referredBy} and referred user ${referredUserId}`,
        { referrerId: user.referredBy, referredUserId },
        'ReputationService'
      );
      return null;
    }

    // Check if already qualified
    if (referral.qualifiedAt) {
      return null;
    }

    const referrerId = user.referredBy;

    // Claim the qualification (qualifiedAt IS NULL) once. Concurrent callers
    // set qualifiedAt and do not pay points.
    const qualificationResult = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(referrals)
        .set({ qualifiedAt: new Date() })
        .where(
          and(eq(referrals.id, referral.id), isNull(referrals.qualifiedAt))
        )
        .returning({ id: referrals.id });
      if (!claimed) return null;

      // Record that the referred user qualified. Do not pay the referrer.
      return buildAwardReputationResult(0, 0);
    });

    if (qualificationResult) {
      logger.info(
        'Referral qualified without a point credit',
        {
          referrerId,
          referredUserId,
          referralId: referral.id,
        },
        'ReputationService'
      );
    }

    return qualificationResult;
  }

  /**
   * Check if reputation was already awarded for a specific reason.
   */
  private static checkAlreadyAwarded(
    user: {
      pointsAwardedForProfile: boolean;
      pointsAwardedForTwitter: boolean;
      pointsAwardedForTwitterFollow: boolean;
      pointsAwardedForDiscord: boolean;
      pointsAwardedForDiscordJoin: boolean;
      pointsAwardedForWallet: boolean;
      pointsAwardedForReferralBonus: boolean;
      pointsAwardedForShare: boolean;
      pointsAwardedForPrivateGroup: boolean;
      pointsAwardedForPrivateChannel: boolean;
      pointsAwardedForTelegram: boolean;
    },
    reason: PointsReason
  ): boolean {
    switch (reason) {
      case 'profile_completion':
        return user.pointsAwardedForProfile;
      case 'twitter_link':
        return user.pointsAwardedForTwitter;
      case 'twitter_follow':
        return user.pointsAwardedForTwitterFollow;
      case 'discord_link':
        return user.pointsAwardedForDiscord;
      case 'discord_join':
        return user.pointsAwardedForDiscordJoin;
      case 'telegram_link':
        return user.pointsAwardedForTelegram;
      case 'wallet_connect':
        return user.pointsAwardedForWallet;
      case 'referral_bonus':
        return user.pointsAwardedForReferralBonus;
      case 'referral_qualified':
        return false;
      case 'share_action':
      case 'share_to_twitter':
        return user.pointsAwardedForShare;
      case 'private_group_create':
        return user.pointsAwardedForPrivateGroup;
      case 'private_channel_create':
        return user.pointsAwardedForPrivateChannel;
      default:
        return false;
    }
  }

  /**
   * Get a user's reputation summary and recent reputation history.
   */
  static async getUserReputation(userId: string) {
    const userResult = await db
      .select({
        reputationPoints: users.reputationPoints,
        referralCount: users.referralCount,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user) {
      return null;
    }

    const transactions = await ReputationService.getReputationHistory(
      userId,
      50
    );

    return {
      reputationPoints: user.reputationPoints,
      referralCount: user.referralCount,
      transactions,
    };
  }

  /**
   * @deprecated Use getUserReputation.
   */
  static async getUserPoints(userId: string) {
    const result = await ReputationService.getUserReputation(userId);
    if (!result) {
      return null;
    }

    return {
      points: result.reputationPoints,
      referralCount: result.referralCount,
      transactions: result.transactions.map((transaction) => ({
        ...transaction,
        amount: transaction.reputationDelta,
        pointsBefore: transaction.reputationBefore,
        pointsAfter: transaction.reputationAfter,
      })),
    };
  }

  static async getReputationHistory(
    userId: string,
    limit = 100
  ): Promise<ReputationHistoryItem[]> {
    const transactions = await db
      .select()
      .from(pointsTransactions)
      .where(eq(pointsTransactions.userId, userId))
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(limit);

    return transactions.map((transaction) => ({
      id: transaction.id,
      userId: transaction.userId,
      reputationDelta: transaction.amount,
      reputationBefore: transaction.pointsBefore,
      reputationAfter: transaction.pointsAfter,
      reason: transaction.reason,
      metadata: transaction.metadata,
      createdAt: transaction.createdAt,
    }));
  }

  /**
   * Get leaderboard with pagination (includes both Users and Actors with pools)
   */
  static async getLeaderboard(
    page = 1,
    pageSize = 100,
    minPoints = 500,
    pointsCategory: LeaderboardCategory = 'all'
  ) {
    const skip = (page - 1) * pageSize;

    // Common user select fields for leaderboard
    const userSelectFields = {
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      reputationPoints: users.reputationPoints,
      invitePoints: users.invitePoints,
      earnedPoints: users.earnedPoints,
      bonusPoints: users.bonusPoints,
      referralCount: users.referralCount,
      virtualBalance: users.virtualBalance,
      lifetimePnL: users.lifetimePnL,
      createdAt: users.createdAt,
      nftTokenId: users.nftTokenId,
    };

    // Build users query based on category
    // All modes exclude actors (isActor=false) AND agents (isAgent=false)
    let usersResult;
    if (pointsCategory === 'all') {
      usersResult = await db
        .select(userSelectFields)
        .from(users)
        .where(
          and(
            eq(users.isActor, false),
            eq(users.isAgent, false),
            gte(users.reputationPoints, minPoints)
          )
        );
    } else if (pointsCategory === 'earned') {
      usersResult = await db
        .select(userSelectFields)
        .from(users)
        .where(
          and(
            eq(users.isActor, false),
            eq(users.isAgent, false),
            ne(users.earnedPoints, 0)
          )
        );
    } else {
      usersResult = await db
        .select(userSelectFields)
        .from(users)
        .where(
          and(
            eq(users.isActor, false),
            eq(users.isAgent, false),
            gt(users.invitePoints, 0)
          )
        );
    }

    const combined = [
      ...usersResult.map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        profileImageUrl: user.profileImageUrl,
        allPoints: user.reputationPoints,
        invitePoints: user.invitePoints,
        earnedPoints: user.earnedPoints,
        bonusPoints: user.bonusPoints,
        referralCount: user.referralCount,
        balance: Number(user.virtualBalance ?? 0),
        lifetimePnL: Number(user.lifetimePnL ?? 0),
        createdAt: user.createdAt,
        isActor: false,
        tier: null as string | null,
        nftTokenId: user.nftTokenId,
      })),
    ];

    if (pointsCategory === 'all') {
      // Get actor states with sufficient reputation points
      const actorStates = await db
        .select({
          id: actorState.id,
          reputationPoints: actorState.reputationPoints,
          createdAt: actorState.createdAt,
        })
        .from(actorState)
        .where(gte(actorState.reputationPoints, minPoints));

      // Combine with static data
      combined.push(
        ...actorStates
          .map((state) => {
            const staticActor = StaticDataRegistry.getActor(state.id);
            if (!staticActor) return null;
            return {
              id: state.id,
              username: state.id,
              displayName: staticActor.name,
              profileImageUrl:
                staticActor.profileImageUrl ?? (null as string | null),
              allPoints: state.reputationPoints,
              invitePoints: 0,
              earnedPoints: 0,
              bonusPoints: 0,
              referralCount: 0,
              balance: 0,
              lifetimePnL: 0,
              createdAt: state.createdAt,
              isActor: true,
              tier: staticActor.tier,
              nftTokenId: null as number | null,
            };
          })
          .filter((a): a is NonNullable<typeof a> => a !== null)
      );
    }

    const sortField: 'allPoints' | 'earnedPoints' | 'invitePoints' =
      pointsCategory === 'all'
        ? 'allPoints'
        : pointsCategory === 'earned'
          ? 'earnedPoints'
          : 'invitePoints';

    combined.sort((a, b) => {
      const comparison = b[sortField] - a[sortField];
      if (comparison !== 0) {
        return comparison;
      }

      if (pointsCategory === 'referral') {
        const referralComparison = b.referralCount - a.referralCount;
        if (referralComparison !== 0) {
          return referralComparison;
        }
      }

      if (pointsCategory === 'earned') {
        const pnlComparison = b.lifetimePnL - a.lifetimePnL;
        if (pnlComparison !== 0) {
          return pnlComparison;
        }
      }

      return b.allPoints - a.allPoints;
    });

    const totalCount = combined.length;
    const paginatedResults = combined.slice(skip, skip + pageSize);

    const resultsWithRank = paginatedResults.map((entry, index) => ({
      ...entry,
      rank: skip + index + 1,
    }));

    return {
      users: resultsWithRank,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      pointsCategory,
    };
  }

  /**
   * Get user's rank on leaderboard (including actors)
   */
  static async getUserRank(userId: string): Promise<number | null> {
    const userResult = await db
      .select({
        reputationPoints: users.reputationPoints,
        isActor: users.isActor,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = userResult[0];

    if (!user || user.isActor) {
      return null;
    }

    // Count users with more points
    const [higherUsersResult] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(
          gt(users.reputationPoints, user.reputationPoints),
          eq(users.isActor, false)
        )
      );

    // Count actors with more points using actorState table
    const [higherActorsResult] = await db
      .select({ count: count() })
      .from(actorState)
      .where(gt(actorState.reputationPoints, user.reputationPoints));

    const higherUsersCount = higherUsersResult?.count ?? 0;
    const higherActorsCount = higherActorsResult?.count ?? 0;

    return higherUsersCount + higherActorsCount + 1;
  }

  /**
   * Per-wallet leaderboard: each human wallet ranked by reputation.
   */
  static async getWalletLeaderboard(
    page = 1,
    pageSize = 100
  ): Promise<LeaderboardResult> {
    const skip = (page - 1) * pageSize;

    const walletSelectFields = {
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      reputationPoints: users.reputationPoints,
      virtualBalance: users.virtualBalance,
      lifetimePnL: users.lifetimePnL,
      createdAt: users.createdAt,
      nftTokenId: users.nftTokenId,
      isAgent: users.isAgent,
      managedBy: users.managedBy,
    };

    const [countResult] = await db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.isActor, false), eq(users.isAgent, false)));

    const usersResult = await db
      .select(walletSelectFields)
      .from(users)
      .where(and(eq(users.isActor, false), eq(users.isAgent, false)))
      .orderBy(
        desc(users.reputationPoints),
        asc(users.createdAt),
        asc(users.id)
      )
      .limit(pageSize)
      .offset(skip);

    const usersWithRank = usersResult.map((user, index) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      profileImageUrl: user.profileImageUrl,
      reputationPoints: user.reputationPoints ?? 0,
      balance: Number(user.virtualBalance ?? 0),
      lifetimePnL: Number(user.lifetimePnL ?? 0),
      createdAt: new Date(user.createdAt),
      isAgent: user.isAgent,
      managedBy: user.managedBy,
      nftTokenId: user.nftTokenId,
      rank: skip + index + 1,
    }));

    const totalCount = Number(countResult?.count ?? 0);
    return {
      users: usersWithRank,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      leaderboardType: 'wallet',
      leaderboardMetric: 'reputation',
    };
  }

  /** Get a user's position on the personal wallet leaderboard. */
  static async getUserPosition(
    userId: string,
    _leaderboardType: LeaderboardScope,
    pageSize = 100
  ): Promise<LeaderboardPosition | null> {
    const positionSelectFields = {
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      reputationPoints: users.reputationPoints,
      virtualBalance: users.virtualBalance,
      lifetimePnL: users.lifetimePnL,
      createdAt: users.createdAt,
      nftTokenId: users.nftTokenId,
      isAgent: users.isAgent,
      managedBy: users.managedBy,
    };

    const userResult = await db
      .select(positionSelectFields)
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.isActor, false),
          eq(users.isAgent, false)
        )
      )
      .limit(1);

    if (!userResult[0]) return null;
    const user = userResult[0];

    const effectiveReputationPoints = user.reputationPoints ?? 0;
    const [higherCount] = await db
      .select({ count: count() })
      .from(users)
      .where(
        and(
          eq(users.isActor, false),
          eq(users.isAgent, false),
          or(
            gt(users.reputationPoints, effectiveReputationPoints),
            and(
              eq(users.reputationPoints, effectiveReputationPoints),
              or(
                lt(users.createdAt, user.createdAt),
                and(eq(users.createdAt, user.createdAt), lt(users.id, user.id))
              )
            )
          )
        )
      );

    const rank = Number(higherCount?.count ?? 0) + 1;
    return {
      rank,
      page: Math.ceil(rank / pageSize),
      entry: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        profileImageUrl: user.profileImageUrl,
        reputationPoints: user.reputationPoints ?? 0,
        balance: Number(user.virtualBalance ?? 0),
        lifetimePnL: Number(user.lifetimePnL ?? 0),
        createdAt: new Date(user.createdAt),
        isAgent: user.isAgent,
        managedBy: user.managedBy,
        nftTokenId: user.nftTokenId,
        rank,
      },
    };
  }
}
