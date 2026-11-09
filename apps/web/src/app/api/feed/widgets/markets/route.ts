/**
 * Markets Widget API
 *
 * @route GET /api/feed/widgets/markets - Get trending markets
 * @access Public (optional authentication for RLS)
 *
 * @description
 * Returns trending prediction markets for sidebar widget. Includes caching
 * for performance. Optional authentication applies RLS for personalized results.
 *
 * @openapi
 * /api/feed/widgets/markets:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get trending markets
 *     description: Returns trending prediction markets for widget (optional auth for RLS)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Markets retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 markets:
 *                   type: array
 *       401:
 *         description: Unauthorized (optional)
 *
 * @example
 * ```typescript
 * const { markets } = await fetch('/api/feed/widgets/markets')
 *   .then(r => r.json());
 * ```
 */

import {
  type AuthenticatedUser,
  CACHE_KEYS,
  DEFAULT_TTLS,
  getCacheOrFetch,
  optionalAuth,
  withErrorHandling,
} from '@feed/api';
import { PredictionPricing } from '@feed/core/markets/prediction';
import {
  and,
  asPublic,
  asUser,
  desc,
  getDbInstance,
  inArray,
  lte,
  predictionPriceHistories,
} from '@feed/db';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Disable static generation for this route - it requires database access
export const dynamic = 'force-dynamic';
// Next.js segment revalidation (60s). The widget's own application cache
// is separate: DEFAULT_TTLS.WIDGET (300s, five minutes).
export const revalidate = 60;

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  // Optional auth - markets are public but RLS still applies
  const authUser: AuthenticatedUser | null = await optionalAuth(request).catch(
    () => null
  );

  // For unauthenticated users, use cached widget data
  if (!authUser || !authUser.userId) {
    const formattedMarkets = await getCacheOrFetch(
      'markets-widget-v3', // v3 to invalidate v2 cache (24h change now reads price history)
      async () => {
        const questions = await getDbInstance().getActiveQuestions();

        if (questions.length === 0) {
          return [];
        }

        const marketIds = questions.map((q) => String(q.id));
        const markets = await asPublic(async (database) => {
          return await database.market.findMany({
            where: {
              id: { in: marketIds },
            },
            orderBy: {
              createdAt: 'desc',
            },
          });
        });

        const marketMap = new Map(markets.map((m) => [m.id, m]));

        // 24h change from the canonical recorded price history: the
        // latest snapshot at or before 24h ago is the baseline. A
        // market with no snapshot that old reports no change — the
        // past pool is never reconstructed from positions, because
        // held shares are not the inverse pool delta (a real YES buy
        // would read as a move in the wrong direction).
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const historyRows = await asPublic(async (database) => {
          return await database.predictionPriceHistories.findMany({
            where: and(
              inArray(predictionPriceHistories.marketId, marketIds),
              lte(predictionPriceHistories.createdAt, twentyFourHoursAgo)
            ),
            orderBy: [desc(predictionPriceHistories.createdAt)],
          });
        });

        const priceChangeMap = new Map<string, number>();
        const baselineSeen = new Set<string>();

        for (const row of historyRows) {
          // Rows arrive newest-first, so the first row per market is
          // the latest snapshot at or before 24h ago.
          if (baselineSeen.has(row.marketId)) continue;
          baselineSeen.add(row.marketId);
          const market = marketMap.get(row.marketId);
          if (!market) continue;
          const baselineYesPrice = Number(row.yesPrice);
          if (!(baselineYesPrice > 0)) continue;
          const currentYesPrice = PredictionPricing.getCurrentPrice(
            Number(market.yesShares),
            Number(market.noShares),
            'yes'
          );
          priceChangeMap.set(
            row.marketId,
            ((currentYesPrice - baselineYesPrice) / baselineYesPrice) * 100
          );
        }

        return (
          questions
            // Don't filter out questions without markets - show all active questions
            .filter((q) => q.status === 'active')
            .map((q) => {
              const market = marketMap.get(String(q.id));
              const yesShares = market ? Number(market.yesShares) : 0;
              const noShares = market ? Number(market.noShares) : 0;
              const totalShares = yesShares + noShares;

              const yesPrice = PredictionPricing.getCurrentPrice(
                yesShares,
                noShares,
                'yes'
              );
              const noPrice = PredictionPricing.getCurrentPrice(
                yesShares,
                noShares,
                'no'
              );
              const changePercent24h = priceChangeMap.get(String(q.id));

              return {
                id: String(q.id),
                question: q.text,
                yesPrice,
                noPrice,
                volume: totalShares,
                endDate: q.resolutionDate,
                changePercent24h:
                  changePercent24h !== undefined ? changePercent24h : undefined,
              };
            })
            .sort((a, b) => {
              const aTime = a.endDate
                ? new Date(a.endDate).getTime()
                : Date.now();
              const bTime = b.endDate
                ? new Date(b.endDate).getTime()
                : Date.now();
              const now = Date.now();

              const aRecency = Math.max(
                0,
                1 - (aTime - now) / (30 * 24 * 60 * 60 * 1000)
              );
              const bRecency = Math.max(
                0,
                1 - (bTime - now) / (30 * 24 * 60 * 60 * 1000)
              );

              const aScore = a.volume * 0.7 + aRecency * 1000 * 0.3;
              const bScore = b.volume * 0.7 + bRecency * 1000 * 0.3;

              return bScore - aScore;
            })
            .slice(0, 10)
        ); // Get top 10 instead of 5 to have more for top movers
      },
      {
        namespace: CACHE_KEYS.WIDGET,
        ttl: DEFAULT_TTLS.WIDGET,
      }
    );

    return NextResponse.json({
      success: true,
      markets: formattedMarkets,
    });
  }

  // For authenticated users, bypass cache (user-specific data)
  const questions = await getDbInstance().getActiveQuestions();

  if (questions.length === 0) {
    return NextResponse.json({
      success: true,
      markets: [],
    });
  }

  const marketIds = questions.map((q) => String(q.id));
  const markets = await asUser(authUser, async (database) => {
    return await database.market.findMany({
      where: {
        id: { in: marketIds },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  });

  const marketMap = new Map(markets.map((m) => [m.id, m]));

  // 24h change from the canonical recorded price history: the latest
  // snapshot at or before 24h ago is the baseline. A market with no
  // snapshot that old reports no change — the past pool is never
  // reconstructed from positions, because held shares are not the
  // inverse pool delta (a real YES buy would read as a move in the
  // wrong direction).
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const historyRows = await asUser(authUser, async (database) => {
    return await database.predictionPriceHistories.findMany({
      where: and(
        inArray(predictionPriceHistories.marketId, marketIds),
        lte(predictionPriceHistories.createdAt, twentyFourHoursAgo)
      ),
      orderBy: [desc(predictionPriceHistories.createdAt)],
    });
  });

  const priceChangeMap = new Map<string, number>();
  const baselineSeen = new Set<string>();

  for (const row of historyRows) {
    // Rows arrive newest-first, so the first row per market is the
    // latest snapshot at or before 24h ago.
    if (baselineSeen.has(row.marketId)) continue;
    baselineSeen.add(row.marketId);
    const market = marketMap.get(row.marketId);
    if (!market) continue;
    const baselineYesPrice = Number(row.yesPrice);
    if (!(baselineYesPrice > 0)) continue;
    const currentYesPrice = PredictionPricing.getCurrentPrice(
      Number(market.yesShares),
      Number(market.noShares),
      'yes'
    );
    priceChangeMap.set(
      row.marketId,
      ((currentYesPrice - baselineYesPrice) / baselineYesPrice) * 100
    );
  }

  const formattedMarkets = questions
    // Don't filter out questions without markets - show all active questions
    .filter((q) => q.status === 'active')
    .map((q) => {
      const market = marketMap.get(String(q.id));
      const yesShares = market ? Number(market.yesShares) : 0;
      const noShares = market ? Number(market.noShares) : 0;
      const totalShares = yesShares + noShares;

      const yesPrice = PredictionPricing.getCurrentPrice(
        yesShares,
        noShares,
        'yes'
      );
      const noPrice = PredictionPricing.getCurrentPrice(
        yesShares,
        noShares,
        'no'
      );
      const changePercent24h = priceChangeMap.get(String(q.id));

      return {
        id: String(q.id),
        question: q.text,
        yesPrice,
        noPrice,
        volume: totalShares,
        endDate: q.resolutionDate,
        changePercent24h:
          changePercent24h !== undefined ? changePercent24h : undefined,
      };
    })
    .sort((a, b) => {
      const aTime = a.endDate ? new Date(a.endDate).getTime() : Date.now();
      const bTime = b.endDate ? new Date(b.endDate).getTime() : Date.now();
      const now = Date.now();

      const aRecency = Math.max(
        0,
        1 - (aTime - now) / (30 * 24 * 60 * 60 * 1000)
      );
      const bRecency = Math.max(
        0,
        1 - (bTime - now) / (30 * 24 * 60 * 60 * 1000)
      );

      const aScore = a.volume * 0.7 + aRecency * 1000 * 0.3;
      const bScore = b.volume * 0.7 + bRecency * 1000 * 0.3;

      return bScore - aScore;
    })
    .slice(0, 10); // Get top 10 instead of 5 to have more for top movers

  return NextResponse.json({
    success: true,
    markets: formattedMarkets,
  });
});
