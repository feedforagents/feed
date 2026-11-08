/**
 * Admin Market Action API
 *
 * @route POST /api/admin/markets/[marketId] - Perform market actions
 * @route GET /api/admin/markets/[marketId] - Get market details
 * @access Admin
 *
 * @description
 * Allows admins to resolve markets, extend end dates, or cancel markets.
 */

import type { JsonValue } from '@feed/api';
import {
  broadcastToChannel,
  checkProgress,
  checkRateLimitAndDuplicates,
  errorResponse,
  getClientIp,
  invalidateMarketsApiPredictionsList,
  invalidateMarketsApiPredictionsListAndAllPositions,
  logAdminModify,
  RATE_LIMIT_CONFIGS,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  db,
  desc,
  eq,
  markets,
  positions,
  questions,
  timeframedMarkets,
} from '@feed/db';
import {
  FEE_CONFIG,
  invalidateAfterPredictionTrade,
  type PredictionSettlementOptions,
  withPredictionSettlement,
} from '@feed/engine';
import { logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { notifyResolvedMarketOwners } from '@/lib/services/market-resolution-notifications';

const serviceOptions = (marketId: string): PredictionSettlementOptions => ({
  broadcast: {
    emit: (channel, payload) =>
      broadcastToChannel(channel, payload as Record<string, JsonValue>),
  },
  cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
  clock: { now: () => new Date() },
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
});

const Reason = z.string().trim().min(1).max(500).optional();

const MarketActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve'),
    resolution: z.boolean({ message: 'Resolution required' }), // true = YES
    reason: Reason,
  }),
  z.object({
    action: z.literal('extend'),
    // Must carry an explicit offset (e.g. toISOString()) so the server never
    // reinterprets a browser-local wall-clock time in its own timezone.
    newEndDate: z.iso.datetime({
      offset: true,
      message: 'New end date must be an ISO datetime with offset',
    }),
    reason: Reason,
  }),
  z.object({ action: z.literal('void'), reason: Reason }),
]);

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ marketId: string }> }
  ) => {
    await requireAdmin(request);
    const { marketId } = await params;

    logger.info(
      'Admin market details requested',
      { marketId },
      'GET /api/admin/markets/[marketId]'
    );

    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);

    if (!market) {
      return errorResponse('Market not found', 'NOT_FOUND', 404);
    }

    // Get positions for this market
    const marketPositions = await db
      .select({
        id: positions.id,
        userId: positions.userId,
        side: positions.side,
        shares: positions.shares,
        avgPrice: positions.avgPrice,
        amount: positions.amount,
        status: positions.status,
        createdAt: positions.createdAt,
      })
      .from(positions)
      .where(eq(positions.marketId, marketId))
      .orderBy(desc(positions.createdAt))
      .limit(100);

    // Calculate stats
    const yesShares = parseFloat(String(market.yesShares));
    const noShares = parseFloat(String(market.noShares));
    const totalShares = yesShares + noShares;
    const yesPrice = totalShares > 0 ? noShares / totalShares : 0.5;

    return successResponse({
      market: {
        ...market,
        yesPrice: Math.round(yesPrice * 100),
        noPrice: Math.round((1 - yesPrice) * 100),
        status: market.resolved
          ? 'resolved'
          : new Date(market.endDate) <= new Date()
            ? 'expired'
            : 'active',
      },
      positions: marketPositions,
      trades: [],
      stats: {
        totalPositions: marketPositions.length,
        totalTrades: 0,
        yesPositionCount: marketPositions.filter((p) => p.side === true).length,
        noPositionCount: marketPositions.filter((p) => p.side === false).length,
      },
    });
  }
);

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ marketId: string }> }
  ) => {
    const admin = await requireAdmin(request);

    // Rate limit admin actions to prevent abuse
    const rateLimitResponse = await checkRateLimitAndDuplicates(
      admin.userId,
      null,
      RATE_LIMIT_CONFIGS.ADMIN_ACTION
    );
    if (rateLimitResponse) return rateLimitResponse;

    const { marketId } = await params;

    // Validate request body with Zod schema
    const parseResult = MarketActionSchema.safeParse(await request.json());
    if (!parseResult.success) {
      return errorResponse(
        parseResult.error.issues[0]?.message ?? 'Invalid request',
        'VALIDATION_ERROR',
        400
      );
    }
    const body = parseResult.data;
    const { action, reason } = body;
    const ipAddress = getClientIp(request.headers) ?? undefined;

    logger.info(
      'Admin market action',
      { marketId, action, adminId: admin.userId },
      'POST /api/admin/markets/[marketId]'
    );

    const [market] = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);

    if (!market) {
      return errorResponse('Market not found', 'NOT_FOUND', 404);
    }

    if (body.action === 'resolve') {
      const { resolution } = body;
      if (market.resolved) {
        return errorResponse(
          'Market already resolved',
          'ALREADY_RESOLVED',
          400
        );
      }

      // Use transaction to ensure atomic updates of market, positions, questions, and timeframedMarkets
      const resolvedAt = new Date();
      await withPredictionSettlement(
        marketId,
        { system: 'admin_prediction_resolve' },
        async (service, tx) => {
          await service.resolve({
            marketId,
            winningSide: resolution ? 'yes' : 'no',
            resolvedAt,
            resolutionDescription:
              reason || `Resolved by admin as ${resolution ? 'YES' : 'NO'}`,
          });
          await tx
            .update(questions)
            .set({
              status: 'resolved',
              resolvedOutcome: resolution,
              resolutionReviewedAt: resolvedAt,
              resolutionReviewedBy: admin.userId,
              updatedAt: resolvedAt,
            })
            .where(eq(questions.id, marketId));

          // Update timeframedMarkets linked to this question
          await tx
            .update(timeframedMarkets)
            .set({
              isActive: false,
              isResolved: true,
              resolvedAt,
              updatedAt: resolvedAt,
            })
            .where(eq(timeframedMarkets.questionId, marketId));
        },
        serviceOptions(marketId)
      );

      // Track prediction_win for achievement/challenge progress
      // (fire-and-forget), mirroring the markets-tick cron: winners of
      // admin-resolved markets must advance the same win-based rewards as
      // winners of cron-resolved markets. Without this, the rewards page
      // shows their win challenges at full progress (counted from the
      // settled positions) but they never complete and the reputation is
      // never credited.
      try {
        const winners = await db
          .select({ userId: positions.userId })
          .from(positions)
          .where(
            and(eq(positions.marketId, marketId), eq(positions.outcome, true))
          );
        for (const w of winners) {
          void checkProgress(w.userId, { type: 'prediction_win' });
        }
      } catch {
        // Non-critical — don't block resolution flow
      }

      let notificationsCreated = 0;

      try {
        notificationsCreated = await notifyResolvedMarketOwners(marketId);
      } catch (notificationError) {
        logger.error(
          'Market resolution succeeded but notification delivery failed',
          {
            marketId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          },
          'POST /api/admin/markets/[marketId]'
        );
      }

      await logAdminModify({
        adminId: admin.userId,
        resourceType: 'market',
        resourceId: marketId,
        previousValue: { resolved: false },
        newValue: { resolved: true, resolution, reason: reason ?? null },
        ipAddress,
        userAgent: request.headers.get('user-agent') ?? undefined,
        metadata: { action: 'resolve', question: market.question },
      });

      void invalidateMarketsApiPredictionsListAndAllPositions();

      return successResponse({
        success: true,
        action: 'resolve',
        resolution,
        marketId,
        notificationsCreated,
      });
    }

    if (body.action === 'extend') {
      const newEnd = new Date(body.newEndDate);
      if (market.resolved) {
        return errorResponse(
          'Resolved markets cannot be extended',
          'ALREADY_RESOLVED',
          400
        );
      }
      if (newEnd <= new Date()) {
        return errorResponse(
          'New end date must be in the future',
          'INVALID_END_DATE',
          400
        );
      }
      if (newEnd <= new Date(market.endDate)) {
        return errorResponse(
          'New end date must be later than the current end date',
          'INVALID_END_DATE',
          400
        );
      }
      // Compare-and-set: only extend a market that is still unresolved and
      // still has the end date this decision was based on.
      const extended = await db
        .update(markets)
        .set({
          endDate: newEnd,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(markets.id, marketId),
            eq(markets.resolved, false),
            eq(markets.endDate, market.endDate)
          )
        )
        .returning({ id: markets.id });

      if (extended.length === 0) {
        return errorResponse(
          'Market changed concurrently; reload and retry',
          'MARKET_CONFLICT',
          409
        );
      }

      await logAdminModify({
        adminId: admin.userId,
        resourceType: 'market',
        resourceId: marketId,
        previousValue: { endDate: toISO(market.endDate) },
        newValue: { endDate: toISO(newEnd), reason: reason ?? null },
        ipAddress,
        userAgent: request.headers.get('user-agent') ?? undefined,
        metadata: { action: 'extend', question: market.question },
      });

      void invalidateMarketsApiPredictionsList();

      return successResponse({
        success: true,
        action: 'extend',
        newEndDate: toISO(newEnd),
        marketId,
      });
    }

    // body.action === 'void'
    // Use PredictionMarketService.cancel() to properly refund all positions
    const cancelledAt = new Date();
    const result = await withPredictionSettlement(
      marketId,
      { system: 'admin_prediction_cancel' },
      async (service, tx) => {
        const cancelled = await service.cancel({
          marketId,
          reason: reason || 'Market voided by admin',
        });
        // Update the question table (market.id matches question.id)
        await tx
          .update(questions)
          .set({
            status: 'cancelled',
            updatedAt: cancelledAt,
          })
          .where(eq(questions.id, marketId));

        // Update timeframedMarkets linked to this question
        await tx
          .update(timeframedMarkets)
          .set({
            isActive: false,
            isResolved: true,
            resolvedAt: cancelledAt,
            updatedAt: cancelledAt,
          })
          .where(eq(timeframedMarkets.questionId, marketId));
        return cancelled;
      },
      serviceOptions(marketId)
    );

    logger.info(
      'Market voided via cancel()',
      {
        marketId,
        positionsRefunded: result.positionsRefunded,
        totalRefunded: result.totalRefunded,
        adminId: admin.userId,
      },
      'POST /api/admin/markets/[marketId]'
    );

    await logAdminModify({
      adminId: admin.userId,
      resourceType: 'market',
      resourceId: marketId,
      previousValue: { status: 'active' },
      newValue: {
        status: 'cancelled',
        reason: reason ?? null,
        positionsRefunded: result.positionsRefunded,
        totalRefunded: result.totalRefunded,
      },
      ipAddress,
      userAgent: request.headers.get('user-agent') ?? undefined,
      metadata: { action: 'void', question: market.question },
    });

    void invalidateMarketsApiPredictionsListAndAllPositions();

    return successResponse({
      success: true,
      action: 'void',
      marketId,
      positionsRefunded: result.positionsRefunded,
      totalRefunded: result.totalRefunded,
    });
  }
);
