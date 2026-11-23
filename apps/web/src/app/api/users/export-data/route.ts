/**
 * User Data Export API
 *
 * @route GET /api/users/export-data - Export user data
 * @access Authenticated
 *
 * @description
 * Exports all user data in JSON format for GDPR compliance (right to data portability).
 * Includes user profile, posts, comments, reactions, positions (including perp
 * positions), transactions, referrals, notifications, and all associated data.
 *
 * @openapi
 * /api/users/export-data:
 *   get:
 *     tags:
 *       - Users
 *     summary: Export user data
 *     description: Exports all user data for GDPR compliance (right to data portability)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User data exported successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 posts:
 *                   type: array
 *                 comments:
 *                   type: array
 *                 reactions:
 *                   type: array
 *                 positions:
 *                   type: array
 *                 transactions:
 *                   type: array
 *                 referrals:
 *                   type: array
 *                 notifications:
 *                   type: array
 *                 exportedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const data = await fetch('/api/users/export-data', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 *
 * @see GDPR Article 20 - Right to data portability
 */

import {
  authenticate,
  exportObject,
  exportRows,
  streamExport,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  agentPerformanceMetrics,
  balanceTransactions,
  comments,
  db,
  eq,
  feedbacks,
  follows,
  notifications,
  perpPositions,
  pointsTransactions,
  positions,
  posts,
  reactions,
  referrals,
  sql,
  tradingFees,
  users,
} from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  logger.info(
    'User requested data export',
    { userId },
    'GET /api/users/export-data'
  );

  const [user] = await db
    .select({
      id: users.id,
      privyId: users.privyId,
      walletAddress: users.walletAddress,
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      profileImageUrl: users.profileImageUrl,
      coverImageUrl: users.coverImageUrl,
      email: users.email,
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
      lifetimePnL: users.lifetimePnL,
      nftTokenId: users.nftTokenId,
      registrationTimestamp: users.registrationTimestamp,
      reputationPoints: users.reputationPoints,
      invitePoints: users.invitePoints,
      earnedPoints: users.earnedPoints,
      bonusPoints: users.bonusPoints,
      profileComplete: users.profileComplete,
      hasTwitter: users.hasTwitter,
      twitterUsername: users.twitterUsername,
      twitterId: users.twitterId,
      referralCode: users.referralCode,
      referredBy: users.referredBy,
      referralCount: users.referralCount,
      waitlistPosition: users.waitlistPosition,
      waitlistJoinedAt: users.waitlistJoinedAt,
      isWaitlistActive: users.isWaitlistActive,
      waitlistGraduatedAt: users.waitlistGraduatedAt,
      tosAccepted: users.tosAccepted,
      tosAcceptedAt: users.tosAcceptedAt,
      tosAcceptedVersion: users.tosAcceptedVersion,
      privacyPolicyAccepted: users.privacyPolicyAccepted,
      privacyPolicyAcceptedAt: users.privacyPolicyAcceptedAt,
      privacyPolicyAcceptedVersion: users.privacyPolicyAcceptedVersion,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return successResponse({ error: 'User not found' }, 404);
  }

  const [performanceMetrics] = await db
    .select({
      id: agentPerformanceMetrics.id,
      gamesPlayed: agentPerformanceMetrics.gamesPlayed,
      gamesWon: agentPerformanceMetrics.gamesWon,
      averageGameScore: agentPerformanceMetrics.averageGameScore,
      normalizedPnL: agentPerformanceMetrics.normalizedPnL,
      totalTrades: agentPerformanceMetrics.totalTrades,
      profitableTrades: agentPerformanceMetrics.profitableTrades,
      winRate: agentPerformanceMetrics.winRate,
      averageROI: agentPerformanceMetrics.averageROI,
      reputationScore: agentPerformanceMetrics.reputationScore,
      trustLevel: agentPerformanceMetrics.trustLevel,
      totalFeedbackCount: agentPerformanceMetrics.totalFeedbackCount,
      averageFeedbackScore: agentPerformanceMetrics.averageFeedbackScore,
      createdAt: agentPerformanceMetrics.createdAt,
      updatedAt: agentPerformanceMetrics.updatedAt,
    })
    .from(agentPerformanceMetrics)
    .where(eq(agentPerformanceMetrics.userId, userId))
    .limit(1);

  const userComments = exportRows(
    comments,
    {
      id: comments.id,
      content: comments.content,
      postId: comments.postId,
      parentCommentId: comments.parentCommentId,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
    },
    eq(comments.authorId, userId)
  );

  const userReactions = exportRows(
    reactions,
    {
      id: reactions.id,
      postId: reactions.postId,
      commentId: reactions.commentId,
      type: reactions.type,
      createdAt: reactions.createdAt,
    },
    eq(reactions.userId, userId)
  );

  const userPosts = exportRows(
    posts,
    {
      id: posts.id,
      type: posts.type,
      content: posts.content,
      fullContent: posts.fullContent,
      articleTitle: posts.articleTitle,
      timestamp: posts.timestamp,
      createdAt: posts.createdAt,
      deletedAt: posts.deletedAt, // Include deleted status for GDPR export
    },
    eq(posts.authorId, userId)
  );

  const userPositions = exportRows(
    positions,
    {
      id: positions.id,
      marketId: positions.marketId,
      side: positions.side,
      shares: positions.shares,
      avgPrice: positions.avgPrice,
      createdAt: positions.createdAt,
      updatedAt: positions.updatedAt,
    },
    eq(positions.userId, userId)
  );

  const userPerpPositions = exportRows(
    perpPositions,
    {
      id: perpPositions.id,
      ticker: perpPositions.ticker,
      organizationId: perpPositions.organizationId,
      side: perpPositions.side,
      entryPrice: perpPositions.entryPrice,
      currentPrice: perpPositions.currentPrice,
      size: perpPositions.size,
      leverage: perpPositions.leverage,
      liquidationPrice: perpPositions.liquidationPrice,
      unrealizedPnL: perpPositions.unrealizedPnL,
      unrealizedPnLPercent: perpPositions.unrealizedPnLPercent,
      fundingPaid: perpPositions.fundingPaid,
      openedAt: perpPositions.openedAt,
      lastUpdated: perpPositions.lastUpdated,
      closedAt: perpPositions.closedAt,
      realizedPnL: perpPositions.realizedPnL,
      settledAt: perpPositions.settledAt,
    },
    eq(perpPositions.userId, userId)
  );

  const userFollows = exportRows(
    follows,
    {
      id: follows.id,
      followingId: follows.followingId,
      createdAt: follows.createdAt,
    },
    eq(follows.followerId, userId)
  );

  const userFollowers = exportRows(
    follows,
    {
      id: follows.id,
      followerId: follows.followerId,
      createdAt: follows.createdAt,
    },
    eq(follows.followingId, userId)
  );

  const userBalanceTransactions = exportRows(
    balanceTransactions,
    {
      id: balanceTransactions.id,
      type: balanceTransactions.type,
      amount: balanceTransactions.amount,
      balanceBefore: balanceTransactions.balanceBefore,
      balanceAfter: balanceTransactions.balanceAfter,
      relatedId: balanceTransactions.relatedId,
      description: balanceTransactions.description,
      createdAt: balanceTransactions.createdAt,
    },
    eq(balanceTransactions.userId, userId),
    balanceTransactions.createdAt
  );

  const userPointsTransactions = exportRows(
    pointsTransactions,
    {
      id: pointsTransactions.id,
      amount: pointsTransactions.amount,
      pointsBefore: pointsTransactions.pointsBefore,
      pointsAfter: pointsTransactions.pointsAfter,
      reason: pointsTransactions.reason,
      metadata: pointsTransactions.metadata,
      createdAt: pointsTransactions.createdAt,
    },
    eq(pointsTransactions.userId, userId),
    pointsTransactions.createdAt
  );

  const userReferrals = exportRows(
    referrals,
    {
      id: referrals.id,
      referralCode: referrals.referralCode,
      referredUserId: referrals.referredUserId,
      status: referrals.status,
      createdAt: referrals.createdAt,
      completedAt: referrals.completedAt,
    },
    eq(referrals.referrerId, userId)
  );

  const userNotifications = exportRows(
    notifications,
    {
      id: notifications.id,
      type: notifications.type,
      actorId: notifications.actorId,
      postId: notifications.postId,
      commentId: notifications.commentId,
      title: notifications.title,
      message: notifications.message,
      read: notifications.read,
      createdAt: notifications.createdAt,
    },
    eq(notifications.userId, userId),
    notifications.createdAt
  );

  const userFeedback = exportRows(
    feedbacks,
    {
      id: feedbacks.id,
      fromUserId: feedbacks.fromUserId,
      toUserId: feedbacks.toUserId,
      score: feedbacks.score,
      rating: feedbacks.rating,
      comment: feedbacks.comment,
      category: feedbacks.category,
      interactionType: feedbacks.interactionType,
      createdAt: feedbacks.createdAt,
    },
    sql`(${eq(feedbacks.fromUserId, userId)} or ${eq(feedbacks.toUserId, userId)})`
  );

  const userTradingFees = exportRows(
    tradingFees,
    {
      id: tradingFees.id,
      tradeType: tradingFees.tradeType,
      tradeId: tradingFees.tradeId,
      marketId: tradingFees.marketId,
      feeAmount: tradingFees.feeAmount,
      platformFee: tradingFees.platformFee,
      referrerFee: tradingFees.referrerFee,
      createdAt: tradingFees.createdAt,
    },
    eq(tradingFees.userId, userId),
    tradingFees.createdAt
  );

  const referralFeesEarned = exportRows(
    tradingFees,
    {
      id: tradingFees.id,
      userId: tradingFees.userId,
      tradeType: tradingFees.tradeType,
      referrerFee: tradingFees.referrerFee,
      createdAt: tradingFees.createdAt,
    },
    eq(tradingFees.referrerId, userId),
    tradingFees.createdAt
  );

  const exportData = exportObject({
    export_info: JSON.stringify({
      exported_at: new Date().toISOString(),
      user_id: userId,
      format_version: '1.0',
    }),
    personal_information: JSON.stringify({
      ...user,
      blockchain_notice:
        'On-chain data (wallet address, NFT token ID, registration transaction) is recorded on public blockchain and cannot be deleted.',
    }),
    content: exportObject({
      posts: userPosts,
      comments: userComments,
      reactions: userReactions,
    }),
    trading: exportObject({
      positions: userPositions,
      perp_positions: userPerpPositions,
      balance_transactions: userBalanceTransactions,
    }),
    social: exportObject({
      following: userFollows,
      followers: userFollowers,
      referrals: userReferrals,
    }),
    points_and_reputation: exportObject({
      points_transactions: userPointsTransactions,
      performance_metrics: JSON.stringify(performanceMetrics ?? null),
      feedback_given_and_received: userFeedback,
    }),
    financial: exportObject({
      trading_fees_paid: userTradingFees,
      referral_fees_earned: referralFeesEarned,
    }),
    notifications: userNotifications,
    legal_consent: JSON.stringify({
      terms_of_service: {
        accepted: user.tosAccepted,
        accepted_at: user.tosAcceptedAt,
        version: user.tosAcceptedVersion,
      },
      privacy_policy: {
        accepted: user.privacyPolicyAccepted,
        accepted_at: user.privacyPolicyAcceptedAt,
        version: user.privacyPolicyAcceptedVersion,
      },
    }),
  });

  return new NextResponse(streamExport(exportData), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="feed-data-export-${userId}-${Date.now()}.json"`,
    },
  });
});
