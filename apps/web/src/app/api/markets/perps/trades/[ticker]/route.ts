/**
 * Perpetual Futures Trades API
 *
 * @route GET /api/markets/perps/trades/[ticker] - Get perp trades
 * @access Public
 *
 * @description
 * Returns all trades for a perpetual futures market with pagination and Redis
 * caching (30s TTL). Includes perp positions and balance transactions. Includes
 * NPC/agent trades with reasoning.
 *
 * @openapi
 * /api/markets/perps/trades/{ticker}:
 *   get:
 *     tags:
 *       - Markets
 *     summary: Get perpetual futures trades
 *     description: Returns all trades for a ticker with pagination and caching
 *     parameters:
 *       - in: path
 *         name: ticker
 *         required: true
 *         schema:
 *           type: string
 *         description: Ticker symbol (e.g., BTC, AAPL)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Trades per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Trades retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trades:
 *                   type: array
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *                 ticker:
 *                   type: string
 *                 organization:
 *                   type: object
 *
 * @example
 * ```typescript
 * const { trades, hasMore } = await fetch('/api/markets/perps/trades/BTC?limit=20')
 *   .then(r => r.json());
 * ```
 */

import type { JsonValue } from '@feed/api';
import {
  addPublicReadHeaders,
  getCache,
  publicRateLimit,
  setCache,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// One row of the balance-transaction subquery below. `$queryRaw` returns
// raw driver values, so `amount` (numeric) arrives as a string and
// `createdAt` (timestamp) arrives as a string; the formatter below applies
// Number() / new Date() exactly as the repository query's Date values did.
type BalanceTransactionRow = {
  id: string;
  type: string;
  amount: string | number;
  userId: string;
  createdAt: Date | string;
  relatedId: string | null;
  description: string | null;
};

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ ticker: string }> }
  ) => {
    const { error, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;

    const { ticker: tickerParam } = await context.params;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const queryParams = QuerySchema.parse({
      limit: searchParams.get('limit') || '50',
      offset: searchParams.get('offset') || '0',
    });

    logger.info(
      'Perp market trades requested',
      { ticker: tickerParam, queryParams },
      'GET /api/markets/perps/trades/[ticker]'
    );

    // Check Redis cache first (use lowercase for consistent cache keys)
    const cacheKey = `perp-trades:${tickerParam.toLowerCase()}:${queryParams.limit}:${queryParams.offset}`;
    const cached = await getCache<Record<string, JsonValue>>(cacheKey, {
      namespace: 'market-trades',
    });

    if (cached) {
      logger.debug(
        'Cache hit for perp trades',
        { ticker: tickerParam },
        'PerpTrades'
      );
      const cachedRes = successResponse(cached);
      if (rateLimitInfo) addPublicReadHeaders(cachedRes, rateLimitInfo);
      return cachedRes;
    }

    // Verify organization/ticker exists - search by ticker field OR id (case-insensitive)
    const staticOrg = StaticDataRegistry.getAllOrganizations().find(
      (org) =>
        org.ticker === tickerParam ||
        org.ticker === tickerParam.toUpperCase() ||
        org.ticker === tickerParam.toLowerCase() ||
        org.id === tickerParam ||
        org.id === tickerParam.toLowerCase()
    );

    if (!staticOrg) {
      logger.warn(
        'Perp market not found for ticker',
        { tickerParam },
        'GET /api/markets/perps/trades/[ticker]'
      );
      return NextResponse.json({ error: 'Market not found' }, { status: 404 });
    }

    const orgState = await db.organizationState.findUnique({
      where: { id: staticOrg.id },
    });

    const organization = {
      id: staticOrg.id,
      name: staticOrg.name,
      type: staticOrg.type,
      ticker: staticOrg.ticker ?? null,
      currentPrice: orgState?.currentPrice ?? null,
    };

    // Use the organization's actual ticker or derive from id for perp position lookups
    const perpTicker =
      organization.ticker ||
      organization.id.toUpperCase().replace(/-/g, '').substring(0, 12);

    // Paginate the merged feed, not each source independently. A source row
    // can appear in the requested merged window only if it is among the
    // first offset + limit rows of that source, so fetch that window (plus
    // one row, mirroring the prediction trades route) and slice after the
    // sources have been sorted together.
    const mergedWindowSize = queryParams.offset + queryParams.limit + 1;
    const positionWhere = {
      OR: [{ ticker: perpTicker }, { organizationId: organization.id }],
    };

    // Get perp positions for this ticker (try both the ticker and organizationId)
    const perpPositions = await db.perpPosition.findMany({
      where: positionWhere,
      orderBy: { openedAt: 'desc' },
      take: mergedWindowSize,
    });

    // Get total count for pagination
    const totalPositions = await db.perpPosition.count({
      where: positionWhere,
    });

    // Fetch users for perp positions
    const perpUserIds = [...new Set(perpPositions.map((p) => p.userId))];
    const perpUsers = await db.user.findMany({
      where: { id: { in: perpUserIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
        isActor: true,
      },
    });
    const perpUsersMap = new Map(perpUsers.map((u) => [u.id, u]));

    // Get NPC trades for this ticker (try multiple formats)
    const npcWhere = {
      marketType: 'perp',
      OR: [
        { ticker: perpTicker },
        { ticker: tickerParam },
        { ticker: tickerParam.toLowerCase() },
      ],
    };
    const npcTrades = await db.npcTrade.findMany({
      where: npcWhere,
      orderBy: { executedAt: 'desc' },
      take: mergedWindowSize,
    });
    const totalNpcTrades = await db.npcTrade.count({ where: npcWhere });

    // Fetch NPC actors - first try DB, then fallback to StaticDataRegistry
    const npcActorIds = [...new Set(npcTrades.map((t) => t.npcActorId))];
    const dbActors =
      npcActorIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: npcActorIds }, isActor: true },
            select: {
              id: true,
              username: true,
              displayName: true,
              profileImageUrl: true,
              isActor: true,
            },
          })
        : [];
    const dbActorsMap = new Map(dbActors.map((a) => [a.id, a]));

    // Build actorsMap with StaticDataRegistry fallback for actors not in DB
    const actorsMap = new Map<
      string,
      {
        id: string;
        username: string | null;
        displayName: string | null;
        profileImageUrl: string | null;
        isActor: boolean;
      }
    >();

    for (const actorId of npcActorIds) {
      const dbActor = dbActorsMap.get(actorId);
      const staticActor = StaticDataRegistry.getActor(actorId);

      if (dbActor) {
        // Prefer DB data, but fallback to static registry for displayName if missing
        actorsMap.set(actorId, {
          id: dbActor.id,
          username:
            dbActor.username ||
            dbActor.displayName?.toLowerCase().replace(/\s+/g, '-') ||
            actorId,
          displayName: dbActor.displayName || staticActor?.name || actorId,
          profileImageUrl: dbActor.profileImageUrl,
          isActor: true,
        });
      } else if (staticActor) {
        // Fallback to StaticDataRegistry when actor not in DB
        actorsMap.set(actorId, {
          id: staticActor.id,
          username: staticActor.name.toLowerCase().replace(/\s+/g, '-'),
          displayName: staticActor.name,
          profileImageUrl: staticActor.profileImageUrl ?? null,
          isActor: true,
        });
      }
    }

    // Get balance transactions for all matching perp positions. A close or
    // liquidation transaction can be recent even when its position opened
    // outside the position window above, so this source cannot be limited
    // to the IDs on an independently paginated position page. Match them
    // with a database-side subquery instead: loading every historical
    // position ID into one IN (...) list blows the database parameter
    // limit (66,000 positions returned 500 MAX_PARAMETERS_EXCEEDED for
    // limit=2, offset=0), while this query binds 3 parameters at any
    // history size.
    const balanceTransactions = await db.$queryRaw<BalanceTransactionRow>`
      SELECT bt.id, bt.type, bt.amount, bt."userId", bt."createdAt",
        bt."relatedId", bt.description
      FROM "BalanceTransaction" bt
      WHERE bt.type IN ('perp_open', 'perp_close', 'perp_liquidation')
        AND bt."relatedId" IN (
          SELECT pp.id FROM "PerpPosition" pp
          WHERE pp.ticker = ${perpTicker}
            OR pp."organizationId" = ${organization.id}
        )
      ORDER BY bt."createdAt" DESC
      LIMIT ${mergedWindowSize}
    `;
    const [{ total: totalBalanceTransactionsText }] = await db.$queryRaw<{
      total: string;
    }>`
        SELECT COUNT(*)::text AS total
        FROM "BalanceTransaction" bt
        WHERE bt.type IN ('perp_open', 'perp_close', 'perp_liquidation')
          AND bt."relatedId" IN (
            SELECT pp.id FROM "PerpPosition" pp
            WHERE pp.ticker = ${perpTicker}
              OR pp."organizationId" = ${organization.id}
          )
      `;
    const totalBalanceTransactions = Number(totalBalanceTransactionsText);

    // Fetch users for transactions
    const txUserIds = [...new Set(balanceTransactions.map((tx) => tx.userId))];
    const txUsers = await db.user.findMany({
      where: { id: { in: txUserIds } },
      select: {
        id: true,
        username: true,
        displayName: true,
        profileImageUrl: true,
        isActor: true,
      },
    });
    const txUsersMap = new Map(txUsers.map((u) => [u.id, u]));

    // Format trades
    const trades = [
      // Perp position trades
      ...perpPositions.map((pos) => ({
        id: pos.id,
        type: 'perp' as const,
        user: perpUsersMap.get(pos.userId) || null,
        side: pos.side,
        size: Number(pos.size),
        leverage: pos.leverage,
        entryPrice: Number(pos.entryPrice),
        currentPrice: Number(pos.currentPrice),
        unrealizedPnL: Number(pos.unrealizedPnL),
        liquidationPrice: Number(pos.liquidationPrice),
        timestamp: pos.openedAt,
        closedAt: pos.closedAt,
        ticker: pos.ticker,
      })),
      // NPC trades
      ...npcTrades.map((trade) => ({
        id: trade.id,
        type: 'npc' as const,
        user: actorsMap.get(trade.npcActorId) || null,
        marketType: trade.marketType,
        ticker: trade.ticker,
        action: trade.action,
        side: trade.side,
        amount: trade.amount,
        price: trade.price,
        sentiment: trade.sentiment,
        reason: trade.reason,
        timestamp: trade.executedAt,
      })),
      // Balance transaction trades
      ...balanceTransactions.map((tx) => ({
        id: tx.id,
        type: 'balance' as const,
        user: txUsersMap.get(tx.userId) || null,
        transactionType: tx.type,
        amount: Number(tx.amount),
        description: tx.description,
        relatedId: tx.relatedId,
        ticker: perpTicker,
        timestamp: new Date(tx.createdAt),
      })),
    ]
      // Sort by timestamp descending, then apply pagination to the merged
      // feed so each trade appears on exactly one page.
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(queryParams.offset, queryParams.offset + queryParams.limit);

    const total = totalPositions + totalNpcTrades + totalBalanceTransactions;
    const hasMore = queryParams.offset + trades.length < total;

    const result = {
      trades,
      total,
      hasMore,
      ticker: organization.id,
      organization: {
        name: organization.name,
        type: organization.type,
        currentPrice: Number(organization.currentPrice),
      },
    };

    // Cache for 30 seconds
    await setCache(cacheKey, result, { ttl: 30, namespace: 'market-trades' });

    logger.info(
      `Returned ${trades.length} trades for perp market ${tickerParam}`,
      { total, hasMore },
      'PerpTrades'
    );

    const res = successResponse(result);
    if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
    return res;
  }
);
