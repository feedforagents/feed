/**
 * Leaderboard API
 *
 * Supports personal wallet rankings by metric:
 * - **metric**
 *   - `reputation`: general leaderboard based on reputation points
 *   - `trading`: trading leaderboard based on realized return
 *     (`lifetimePnL / max(capitalBase, 1000)`) with lifetime P&L included as context
 *
 * Supports optional `userId` param to return the requesting user's
 * rank/position alongside the page data. Leaderboard pages are cached
 * in Redis (shared); user positions are always computed fresh.
 *
 * @openapi
 * /api/leaderboard:
 *   get:
 *     tags:
 *       - Leaderboard
 *     summary: Get leaderboard by metric and scope
 *     parameters:
 *       - in: query
 *         name: metric
 *         schema:
 *           type: string
 *           enum: [reputation, trading]
 *           default: reputation
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [wallet]
 *           default: wallet
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 100
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Optional user ID to include their rank in the response
 */

import {
  findUserByIdentifier,
  getCache,
  type LeaderboardPosition,
  type LeaderboardResult,
  optionalAuth,
  ReputationService,
  setCache,
  successResponse,
  TradingLeaderboardService,
  withErrorHandling,
} from '@feed/api';
import { and, db, eq, follows, inArray } from '@feed/db';
import { type LeaderboardMetric, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { sanitizeForJson } from '@/lib/json/sanitize';
import { parseLeaderboardQuery } from './query';

const CACHE_KEY_NAMESPACE = 'leaderboard-personal';
/**
 * LEADERBOARD_CACHE_MS: `0` disables caching; any other value must be a
 * whole number of milliseconds >= 1000 (TTL is applied in whole seconds).
 * Invalid values (negative, fractional, sub-second) fail fast instead of being
 * silently turned into a zero/negative TTL.
 */
const CACHE_TTL_SECONDS = (() => {
  const raw = process.env.LEADERBOARD_CACHE_MS;
  if (raw === undefined || raw.trim() === '') return 120;
  const ms = Number(raw);
  if (ms === 0) return 0;
  if (!Number.isInteger(ms) || ms < 1000) {
    throw new Error(
      `Invalid LEADERBOARD_CACHE_MS "${raw}": use 0 to disable or an integer >= 1000`
    );
  }
  return Math.floor(ms / 1000);
})();
const CACHE_ENABLED = CACHE_TTL_SECONDS > 0;
const STALE_SECONDS = CACHE_TTL_SECONDS * 3;

type CachedLeaderboardEntry = {
  data: LeaderboardResult;
  generatedAt: string;
};

type LeaderboardService = {
  getWalletLeaderboard: (
    page?: number,
    pageSize?: number
  ) => Promise<LeaderboardResult>;
  getUserPosition: (
    userId: string,
    leaderboardType: LeaderboardResult['leaderboardType'],
    pageSize?: number
  ) => Promise<LeaderboardPosition | null>;
};

const LEADERBOARD_SERVICES: Record<LeaderboardMetric, LeaderboardService> = {
  reputation: ReputationService,
  trading: TradingLeaderboardService,
};

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await optionalAuth(request);
  const { searchParams } = new URL(request.url);
  const { page, pageSize, metric, type, userId } =
    parseLeaderboardQuery(searchParams);
  const leaderboardMetric = metric ?? 'reputation';
  const leaderboardType = type ?? 'wallet';
  const leaderboardService = LEADERBOARD_SERVICES[leaderboardMetric];
  let effectiveUserId = authUser?.dbUserId ?? authUser?.userId;

  if (userId) {
    const resolvedUser = await findUserByIdentifier(userId, { id: true });
    effectiveUserId = resolvedUser?.id ?? userId;
  }

  const cacheKey = `${leaderboardMetric}-${leaderboardType}-${page}-${pageSize}`;

  let leaderboardData: LeaderboardResult | null = null;
  let generatedAt: string = new Date().toISOString();
  let cacheHit = false;

  if (CACHE_ENABLED) {
    const cached = await getCache<CachedLeaderboardEntry>(cacheKey, {
      namespace: CACHE_KEY_NAMESPACE,
    });
    if (cached?.data) {
      leaderboardData = cached.data;
      generatedAt = cached.generatedAt;
      cacheHit = true;
    }
  }

  if (!leaderboardData) {
    leaderboardData = await leaderboardService.getWalletLeaderboard(
      page,
      pageSize
    );
    generatedAt = new Date().toISOString();

    if (CACHE_ENABLED) {
      await setCache(
        cacheKey,
        { data: leaderboardData, generatedAt } satisfies CachedLeaderboardEntry,
        {
          namespace: CACHE_KEY_NAMESPACE,
          ttl: CACHE_TTL_SECONDS,
        }
      );
    }
  }

  let currentUser: LeaderboardPosition | null = null;
  if (effectiveUserId) {
    try {
      currentUser = await leaderboardService.getUserPosition(
        effectiveUserId,
        leaderboardType,
        pageSize
      );
    } catch (error) {
      logger.warn(
        'Failed to compute leaderboard currentUser; returning null',
        {
          effectiveUserId,
          leaderboardMetric,
          leaderboardType,
          pageSize,
          error: error instanceof Error ? error.message : String(error),
        },
        'GET /api/leaderboard'
      );
    }
  }

  const authUserId = authUser?.dbUserId ?? authUser?.userId;
  const canResolveFollowingUserIds =
    authUserId !== undefined && (!userId || effectiveUserId === authUserId);
  let followingUserIdsResolved = false;
  let followingUserIds: string[] = [];

  if (canResolveFollowingUserIds) {
    const leaderboardUserIds = leaderboardData.users
      .map((entry) => entry.id)
      .filter((id) => id !== authUserId);

    if (leaderboardUserIds.length > 0) {
      const followedUsers = await db
        .select({ followingId: follows.followingId })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, authUserId),
            inArray(follows.followingId, leaderboardUserIds)
          )
        );

      followingUserIds = followedUsers.map((follow) => follow.followingId);
    }

    followingUserIdsResolved = true;
  }

  const isPersonalizedResponse = Boolean(
    effectiveUserId || followingUserIdsResolved
  );

  logger.info(
    'Leaderboard fetched successfully',
    {
      page,
      pageSize,
      leaderboardMetric,
      leaderboardType,
      totalCount: leaderboardData.totalCount,
      cacheHit,
      hasUserId: !!effectiveUserId,
    },
    'GET /api/leaderboard'
  );

  return successResponse(
    sanitizeForJson({
      leaderboard: leaderboardData.users,
      pagination: {
        page: leaderboardData.page,
        pageSize: leaderboardData.pageSize,
        totalCount: leaderboardData.totalCount,
        totalPages: leaderboardData.totalPages,
      },
      leaderboardType,
      leaderboardMetric: leaderboardData.leaderboardMetric,
      currentUser,
      followingUserIds,
      followingUserIdsResolved,
      generatedAt,
    }),
    200,
    {
      'x-cache': cacheHit ? 'leaderboard-hit' : 'leaderboard-miss',
      'Cache-Control': isPersonalizedResponse
        ? 'private, no-store'
        : CACHE_ENABLED
          ? `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`
          : 'no-store',
      Vary: 'Accept-Encoding',
    }
  );
});
