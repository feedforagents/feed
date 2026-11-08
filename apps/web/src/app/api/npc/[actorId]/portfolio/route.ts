/**
 * NPC Portfolio API
 *
 * @route GET /api/npc/[actorId]/portfolio - Get NPC portfolio
 * @access Public
 *
 * @description
 * Returns comprehensive portfolio data for an NPC actor including total
 * portfolio value, PnL, position count, and risk metrics.
 *
 * @openapi
 * /api/npc/{actorId}/portfolio:
 *   get:
 *     tags:
 *       - NPC
 *     summary: Get NPC portfolio
 *     description: Returns comprehensive portfolio data for NPC actor
 *     parameters:
 *       - in: path
 *         name: actorId
 *         required: true
 *         schema:
 *           type: string
 *         description: NPC actor ID
 *     responses:
 *       200:
 *         description: Portfolio retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalValue:
 *                   type: number
 *                 unrealizedPnl:
 *                   type: number
 *                 realizedPnl:
 *                   type: number
 *                 positionCount:
 *                   type: integer
 *                 riskScore:
 *                   type: number
 *       404:
 *         description: NPC actor not found
 *
 * @example
 * ```typescript
 * const portfolio = await fetch(`/api/npc/${actorId}/portfolio`)
 *   .then(r => r.json());
 * ```
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  requireUserByIdentifier,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { NPCInvestmentManager } from '@feed/engine';
import { toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface RouteParams {
  params: Promise<{
    actorId: string;
  }>;
}

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { actorId } = await params;

  const actor = await requireUserByIdentifier(actorId);

  const pool = await db.pool.findFirst({
    where: {
      npcActorId: actor.id,
      isActive: true,
    },
  });

  if (!pool) {
    return NextResponse.json(
      { error: 'No active pool found for actor' },
      { status: 404 }
    );
  }

  const metrics = await NPCInvestmentManager.getPortfolioMetrics(pool.id);

  // The aggregates above merge two position tables: NPC prediction trades
  // are mirrored into PoolPosition, but NPC perp trades live only in
  // PerpPosition (TradeExecutionService opens them through PerpMarketService
  // with no pool mirror). Listing only PoolPosition hid every open perp
  // position while positionCount and unrealizedPnL still included it, so
  // list the same merged set the metrics count. Pool rows for perps are
  // legacy mirrors of PerpPosition rows; drop a pool row whose id exists in
  // PerpPosition, exactly as getPortfolioMetrics does, to avoid listing the
  // same position twice.
  const [poolPositionsList, perpPositionsList] = await Promise.all([
    db.poolPosition.findMany({
      where: {
        poolId: pool.id,
        closedAt: null,
      },
      select: {
        id: true,
        marketType: true,
        ticker: true,
        marketId: true,
        side: true,
        size: true,
        entryPrice: true,
        currentPrice: true,
        unrealizedPnL: true,
        leverage: true,
        openedAt: true,
      },
      orderBy: {
        openedAt: 'desc',
      },
    }),
    db.perpPosition.findMany({
      where: {
        userId: pool.id,
      },
      select: {
        id: true,
        ticker: true,
        side: true,
        size: true,
        entryPrice: true,
        currentPrice: true,
        unrealizedPnL: true,
        leverage: true,
        openedAt: true,
        closedAt: true,
      },
    }),
  ]);

  const perpPositionIds = new Set(perpPositionsList.map((pos) => pos.id));

  const formattedPositions = [
    ...poolPositionsList
      .filter(
        (pos) => pos.marketType !== 'perp' || !perpPositionIds.has(pos.id)
      )
      .map((pos) => ({
        id: pos.id,
        marketType: pos.marketType,
        ticker: pos.ticker,
        marketId: pos.marketId,
        side: pos.side,
        size: Number(pos.size),
        entryPrice: Number(pos.entryPrice),
        currentPrice: Number(pos.currentPrice),
        unrealizedPnL: Number(pos.unrealizedPnL),
        leverage: pos.leverage,
        createdAt: toISO(pos.openedAt),
        openedAt: pos.openedAt,
      })),
    ...perpPositionsList
      .filter((pos) => pos.closedAt === null)
      .map((pos) => ({
        id: pos.id,
        marketType: 'perp',
        ticker: pos.ticker,
        marketId: null,
        side: pos.side,
        size: Number(pos.size),
        entryPrice: Number(pos.entryPrice),
        currentPrice: Number(pos.currentPrice),
        unrealizedPnL: Number(pos.unrealizedPnL),
        leverage: pos.leverage,
        createdAt: toISO(pos.openedAt),
        openedAt: pos.openedAt,
      })),
  ]
    .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
    .map(({ openedAt: _openedAt, ...position }) => position);

  const res = NextResponse.json({
    success: true,
    actorId: actor.id,
    actorName: actor.displayName!,
    poolId: pool.id,
    portfolio: {
      totalValue: metrics.totalValue,
      availableBalance: metrics.availableBalance,
      unrealizedPnL: metrics.unrealizedPnL,
      realizedPnL: metrics.realizedPnL,
      positionCount: metrics.positionCount,
      utilization: metrics.utilization,
      riskScore: metrics.riskScore,
    },
    positions: formattedPositions,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
