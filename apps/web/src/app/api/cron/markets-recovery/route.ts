/** Drain due prediction market work and fill vacant slots outside the minute tick. */

import {
  CACHE_KEYS,
  checkProgress,
  DEFAULT_TTLS,
  DistributedLockService,
  getCacheOrFetch,
  invalidateCache,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import {
  PredictionDbAdapter as CorePredictionDbAdapter,
  PredictionMarketService as CorePredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  type ArcStateType,
  and,
  db,
  eq,
  games,
  generateSnowflakeId,
  gt,
  isNotNull,
  isNull,
  listDuePredictionRecoveryMarkets,
  type MarketCategory,
  type MarketTimeframe,
  max,
  ownsPredictionRecoveryLease,
  PREDICTION_RECOVERY_LEASE_ID,
  positions,
  posts,
  questions,
  sql,
  timeframedMarketRoles,
  timeframedMarkets,
} from '@feed/db';
import {
  type DailyTopicContext,
  dailyTopicService,
  deriveTopicFromText,
  FeedLLMClient,
  getCurrentArcState,
  getMaxSubMarketDuration,
  getPredictionMarketInitialization,
  isEligibleActor,
  MAX_SUB_MARKETS,
  mapGranularToDbTimeframe,
  normalizeTopicDate,
  processPredictionMarketRecovery,
  QuestionManager,
  StaticDataRegistry,
  SUB_MARKET_MIN_DURATION_MS,
  secureRandom,
  timeframeArcPlanner,
  weightedPick,
  writeSubMarket,
} from '@feed/engine';
import { isStringArray, logger, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { notifyResolvedMarketOwners } from '@/lib/services/market-resolution-notifications';

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

export const dynamic = 'force-dynamic';

// ============================================================================
// Market Creation Configuration
// ============================================================================

/**
 * Default scenario ID for new questions.
 * Consistent with QuestionManager defaults.
 */
const DEFAULT_SCENARIO_ID = 1;

/**
 * Stop starting new recovery work after this budget. In-flight provider calls
 * have their own timeouts and do not block the minute markets tick.
 */
const DEFAULT_TICK_BUDGET_MS = 45_000;
const LEASE_MS = 90_000;
const MAX_RESOLUTIONS_PER_PASS = 2;
const MAX_MAIN_DRAFTS_PER_PASS = 2;
const LOCK = PREDICTION_RECOVERY_LEASE_ID;

/**
 * Recovery deadline for starting new work in milliseconds.
 * Configurable via MARKETS_TICK_BUDGET_MS environment variable for tuning.
 * Falls back to DEFAULT_TICK_BUDGET_MS if env value is invalid (NaN or <= 0).
 */
const TICK_BUDGET_MS = (() => {
  const parsed = parseInt(process.env.MARKETS_TICK_BUDGET_MS || '', 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_TICK_BUDGET_MS;
  }
  return parsed;
})();

/**
 * Mock wallet for market creation operations.
 * The markets-recovery cron creates markets without real wallet operations
 * since it's a system-level process, not user-initiated.
 *
 * These no-op stubs satisfy the CorePredictionMarketService interface
 * while preventing any actual balance changes.
 */
const MOCK_WALLET = {
  debit: async () => {},
  credit: async () => {},
  recordPnL: async () => {},
  getBalance: async () => ({ balance: 0 }),
} as const;

/**
 * Default fee configuration for system-created markets.
 * Zero fees since these are automated market creation operations.
 */
const SYSTEM_MARKET_FEES = {
  tradingFeeRate: 0,
  platformShare: 0,
  referrerShare: 0,
  minFeeAmount: 0,
} as const;

/**
 * Market structure configuration - maintains exactly 10 active markets
 * with staggered timeframes for constant activity.
 */
const MARKET_STRUCTURE: Record<
  string,
  { count: number; durationMs: number; label: string }
> = {
  '3d': {
    count: 1,
    durationMs: 3 * 24 * 60 * 60 * 1000,
    label: '3-day',
  },
  '2d': {
    count: 1,
    durationMs: 2 * 24 * 60 * 60 * 1000,
    label: '2-day',
  },
  '1d': {
    count: 1,
    durationMs: 24 * 60 * 60 * 1000,
    label: '1-day',
  },
  '12h': {
    count: 1,
    durationMs: 12 * 60 * 60 * 1000,
    label: '12-hour',
  },
  '6h': {
    count: 1,
    durationMs: 6 * 60 * 60 * 1000,
    label: '6-hour',
  },
  '1h': {
    count: 1,
    durationMs: 60 * 60 * 1000,
    label: '1-hour',
  },
  '30m': {
    count: 2,
    durationMs: 30 * 60 * 1000,
    label: '30-minute',
  },
  '15m': {
    count: 2,
    durationMs: 15 * 60 * 1000,
    label: '15-minute',
  },
};

// Total: 10 markets (1+1+1+1+1+1+2+2)

// ============================================================================
// Sub-Market Configuration
// ============================================================================

/**
 * Maximum sub-markets to create per tick.
 * Allows faster ramp-up while preventing overload in a single tick.
 */
const MAX_SUB_MARKETS_PER_TICK = 1;

/**
 * Generate a random sub-market duration that fits within the parent's remaining time.
 * Returns null if the parent doesn't have enough remaining time.
 *
 * @param parentEndTime - The end time of the parent market
 * @param now - Current timestamp (defaults to Date.now())
 * @returns Duration in ms, or null if parent doesn't have enough time
 */
function getConstrainedSubMarketDuration(
  parentEndTime: Date,
  now: number = Date.now()
): number | null {
  const maxDuration = getMaxSubMarketDuration(parentEndTime, now);

  if (maxDuration === null) {
    return null;
  }

  // Generate random duration between MIN and the constrained MAX
  return (
    Math.floor(secureRandom() * (maxDuration - SUB_MARKET_MIN_DURATION_MS)) +
    SUB_MARKET_MIN_DURATION_MS
  );
}

/**
 * Infer the appropriate timeframe label for a sub-market based on duration.
 * Sub-markets can range from 15min to 3 hours (SUB_MARKET_MAX_DURATION_MS).
 *
 * Only returns keys that exist in GRANULAR_TO_DB_TIMEFRAME to prevent
 * mapGranularToDbTimeframe from throwing:
 * - 15m: up to 22.5 minutes (midpoint between 15m and 30m)
 * - 30m: 22.5 to 45 minutes (midpoint between 30m and 1h)
 * - 1h: 45 minutes to 3 hours (capped at 1h since 2h/3h unsupported)
 */
function inferSubMarketTimeframe(durationMs: number): '15m' | '30m' | '1h' {
  const minutes = durationMs / (60 * 1000);
  if (minutes <= 22.5) return '15m';
  if (minutes <= 45) return '30m';
  return '1h'; // All durations > 45min map to 1h (closest supported key)
}

// ============================================================================
// Type Guards and Helpers
// ============================================================================

/**
 * Safely extract a string array from unknown JSONB data.
 * Returns empty array if data is null, undefined, or invalid.
 */
function toStringArray(value: unknown): string[] {
  if (isStringArray(value)) return value;
  if (value === null || value === undefined) return [];

  // Log warning for unexpected types in production
  logger.warn(
    'Invalid string array in JSONB field',
    { actualType: typeof value, isArray: Array.isArray(value) },
    'TypeValidation'
  );
  return [];
}

// ============================================================================
// Media Organization Selection
// ============================================================================

/**
 * Select a relevant media organization for market announcements.
 * Uses affiliation scoring to prefer orgs connected to the market's narrative.
 * Falls back to random selection if no relevance signals exist.
 *
 * Scoring:
 * - Base weight: 1.0 (all media orgs eligible)
 * - +2.0 if org has actors affiliated with market's actors (shared narrative)
 * - +1.5 if org has actors in market's affiliated orgs
 * - +0.5 if org's actors cover the market category
 * - +1.0 random variance (prevents deterministic selection)
 */
function selectRelevantMediaOrg(
  affiliatedActorIds: string[],
  affiliatedOrgIds: string[],
  category: MarketCategory
): ReturnType<typeof StaticDataRegistry.getOrganization> {
  const mediaOrgs = StaticDataRegistry.getOrganizationsByType('media');

  if (mediaOrgs.length === 0) return null;
  if (mediaOrgs.length === 1) return mediaOrgs[0] ?? null;

  // Build a set of actor IDs affiliated with the market
  const marketActorSet = new Set(affiliatedActorIds);

  // Score each media org by relevance
  const scored = mediaOrgs.map((org) => {
    let weight = 1.0; // Base weight - everyone has a chance

    // Check if any actors affiliated with this media org are also in the market
    const orgActors = StaticDataRegistry.getActorsByAffiliation(org.id);
    for (const actor of orgActors) {
      // Direct involvement: actor is affiliated with both market and this org
      if (marketActorSet.has(actor.id)) {
        weight += 2.0;
        break; // Cap the bonus
      }

      // Indirect involvement: actor shares affiliations with market orgs
      for (const actorOrgId of actor.affiliations) {
        if (affiliatedOrgIds.includes(actorOrgId) && actorOrgId !== org.id) {
          weight += 1.5;
          break;
        }
      }
    }

    // Category relevance: check if org's actors cover this domain
    for (const actor of orgActors) {
      if (actor.domain.includes(category)) {
        weight += 0.5;
        break;
      }
    }

    // Add random variance to prevent deterministic selection
    weight += secureRandom() * 1.0;

    return { org, weight };
  });

  // Build weight map for O(1) lookup instead of O(n) find per org
  const weightMap = new Map(scored.map((s) => [s.org.id, s.weight]));

  // Use weighted selection
  return weightedPick(
    scored.map((s) => s.org),
    (org) => weightMap.get(org.id) ?? 1.0
  );
}

export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  if (!verifyCronAuth(request, { jobName: 'MarketsRecovery' })) {
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  // Only the isolated laptop runtime is approved until D-25 provider
  // reservations and reconciliation are verified for paid deployment.
  if (process.env.DEPLOYMENT_ENV !== 'localnet') {
    return NextResponse.json(
      {
        success: false,
        error: 'Market recovery requires verified D-25 spend enforcement',
      },
      { status: 503 }
    );
  }

  const startTime = Date.now();
  await relayCronToStaging(request, 'markets-recovery');
  const processId = crypto.randomUUID();
  const acquired = await DistributedLockService.acquireLock({
    lockId: LOCK,
    durationMs: LEASE_MS,
    operation: LOCK,
    processId,
  });

  if (!acquired) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous recovery pass still running',
    });
  }

  const deadline = startTime + TICK_BUDGET_MS;
  let leaseHeld = true;
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (!leaseHeld || renewal) return;
    renewal = DistributedLockService.renewLock(LOCK, processId, LEASE_MS)
      .then((renewed) => {
        leaseHeld = renewed;
      })
      .catch((error: unknown) => {
        leaseHeld = false;
        logger.error(
          'Market recovery lease renewal failed',
          {
            error: error instanceof Error ? error.message : String(error),
          },
          'MarketsRecovery'
        );
      })
      .finally(() => {
        renewal = undefined;
      });
  }, LEASE_MS / 3);
  const canStartWork = () => leaseHeld && Date.now() < deadline;

  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping markets tick',
        { GAME_START: process.env.GAME_START },
        'MarketsRecovery'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled',
      });
    }

    // Get or fetch game state
    const gameState = await getCacheOrFetch<GameState>(
      'markets-tick:game-state',
      async () => {
        const [game] = await db
          .select({
            id: games.id,
            isRunning: games.isRunning,
            isContinuous: games.isContinuous,
            currentDay: games.currentDay,
          })
          .from(games)
          .where(eq(games.isContinuous, true))
          .limit(1);

        if (!game) {
          // Log warning so operators are alerted to missing game configuration
          // This could indicate a DB issue or missing game setup
          logger.warn(
            'No continuous game found in database - using fallback state',
            {
              attemptedQuery: 'games.isContinuous = true',
              fallbackId: 'continuous',
              action: 'Markets tick will be skipped (isRunning: false)',
            },
            'MarketsRecovery'
          );
          return {
            id: 'continuous',
            isRunning: false,
            isContinuous: true,
            currentDay: 1,
          };
        }

        return {
          id: game.id,
          isRunning: game.isRunning ?? false,
          isContinuous: game.isContinuous ?? true,
          currentDay: game.currentDay,
        };
      },
      { ttl: 30 }
    );

    if (!gameState.isRunning) {
      logger.info(
        'Game not running - skipping markets tick',
        { gameId: gameState.id },
        'MarketsRecovery'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game not running',
      });
    }

    // Initialize LLM client for question generation
    const llmClient = FeedLLMClient.forGameTick();

    // Results tracking with detailed performance metrics
    const results = {
      marketsResolved: 0,
      marketsCreated: 0,
      subMarketsCreated: 0,
      positionsSettled: 0,
      marketsByTimeframe: {} as Record<string, number>,
    };

    // Performance metrics for monitoring bottlenecks
    const metrics = {
      getActiveMarketsMs: 0,
      resolutionMs: 0,
      creationMs: 0,
      subMarketCreationMs: 0,
      totalDbQueries: 0,
      totalLlmCalls: 0,
    };

    const now = new Date();
    // Fetch multiple topic candidates to spread markets across themes
    const topicCandidates = await dailyTopicService.getTopicCandidatesForDate(
      now,
      3
    );
    let topicRotationIndex = 0;

    if (topicCandidates.length === 0) {
      logger.warn(
        'No daily topic available - new main market creation will be skipped',
        { date: toISO(now) },
        'MarketsRecovery'
      );
    } else {
      logger.info(
        'Multi-topic candidates ready',
        {
          count: topicCandidates.length,
          topics: topicCandidates.map((t) => t.topicLabel),
        },
        'MarketsRecovery'
      );
    }

    // Step 1: Get current market distribution
    const activeMarketsStart = Date.now();
    const activeMarkets = await getActiveMarketsByTimeframe();
    metrics.getActiveMarketsMs = Date.now() - activeMarketsStart;
    results.marketsByTimeframe = Object.fromEntries(
      Object.entries(activeMarkets).map(([tf, markets]) => [tf, markets.length])
    );

    logger.info(
      'Current market distribution',
      {
        ...results.marketsByTimeframe,
        queryTimeMs: metrics.getActiveMarketsMs,
      },
      'MarketsRecovery'
    );

    // HARD CAP CHECK: Calculate total active markets from source of truth
    // The expected total is 10 (sum of all counts in MARKET_STRUCTURE)
    const expectedTotalMarkets = Object.values(MARKET_STRUCTURE).reduce(
      (sum, config) => sum + config.count,
      0
    );
    const actualTotalMarkets = Object.values(activeMarkets).reduce(
      (sum, markets) => sum + markets.length,
      0
    );

    // Log warning if we're over the expected limit (indicates a bug or data issue)
    if (actualTotalMarkets > expectedTotalMarkets) {
      logger.warn(
        'Active market count exceeds expected limit',
        {
          actual: actualTotalMarkets,
          expected: expectedTotalMarkets,
          distribution: results.marketsByTimeframe,
        },
        'MarketsRecovery'
      );
    }

    const resolutionStart = Date.now();
    const dueMarkets = canStartWork()
      ? await listDuePredictionRecoveryMarkets(now, MAX_RESOLUTIONS_PER_PASS)
      : [];
    const settlements = await Promise.allSettled(
      dueMarkets.map(async (market) => {
        if (!canStartWork()) return false;
        const outcome = await processPredictionMarketRecovery(
          market,
          llmClient,
          gameState,
          processId
        );
        if (outcome !== 'settled') return false;

        try {
          await notifyResolvedMarketOwners(market.marketId);
        } catch (error) {
          logger.error(
            'Market recovery notification failed',
            {
              marketId: market.marketId,
              error: error instanceof Error ? error.message : String(error),
            },
            'MarketsRecovery'
          );
        }

        // Achievement work follows the single committed settlement.
        try {
          const winners = await db
            .select({ userId: positions.userId })
            .from(positions)
            .where(
              and(
                eq(positions.marketId, market.marketId),
                eq(positions.outcome, market.outcome)
              )
            );
          await Promise.all(
            winners.map((winner) =>
              checkProgress(winner.userId, { type: 'prediction_win' })
            )
          );
        } catch (error) {
          logger.warn(
            'Market recovery achievement update failed',
            {
              marketId: market.marketId,
              error: error instanceof Error ? error.message : String(error),
            },
            'MarketsRecovery'
          );
        }

        return true;
      })
    );
    for (const settlement of settlements) {
      if (settlement.status === 'fulfilled') {
        if (settlement.value) results.marketsResolved++;
      } else {
        logger.error(
          'Market recovery failed',
          {
            error:
              settlement.reason instanceof Error
                ? settlement.reason.message
                : String(settlement.reason),
          },
          'MarketsRecovery'
        );
      }
    }
    metrics.resolutionMs = Date.now() - resolutionStart;

    // Step 3: Ensure market structure (fill any gaps)
    // IMPORTANT: Re-query active markets AFTER resolution phase to get accurate counts
    // A completed settlement can have freed a main-market slot.
    const updatedActiveMarkets = await getActiveMarketsByTimeframe();
    const updatedTotalMarkets = Object.values(updatedActiveMarkets).reduce(
      (sum, markets) => sum + markets.length,
      0
    );

    logger.info(
      'Updated market distribution after resolution phase',
      {
        distribution: Object.fromEntries(
          Object.entries(updatedActiveMarkets).map(([tf, markets]) => [
            tf,
            markets.length,
          ])
        ),
        total: updatedTotalMarkets,
        expected: expectedTotalMarkets,
      },
      'MarketsRecovery'
    );

    const creationStart = Date.now();
    let mainDraftsStarted = 0;

    // Skip gap-filling if we're already at or over the hard cap
    if (updatedTotalMarkets >= expectedTotalMarkets) {
      logger.info(
        'Skipping gap-filling phase - already at market limit',
        { total: updatedTotalMarkets, expected: expectedTotalMarkets },
        'MarketsRecovery'
      );
    } else {
      // Iterate over MARKET_STRUCTURE keys (granular timeframes like '15m', '30m', etc.)
      // getActiveMarketsByTimeframe() now groups by granular timeframe derived from duration
      for (const [timeframe, config] of Object.entries(MARKET_STRUCTURE)) {
        if (!canStartWork() || mainDraftsStarted >= MAX_MAIN_DRAFTS_PER_PASS)
          break;

        const currentCount = updatedActiveMarkets[timeframe]?.length || 0;
        const needed = config.count - currentCount;

        if (needed > 0) {
          logger.info(
            `Creating ${needed} missing ${timeframe} market(s)`,
            { currentCount, target: config.count },
            'MarketsRecovery'
          );

          for (let i = 0; i < needed; i++) {
            if (
              !canStartWork() ||
              mainDraftsStarted >= MAX_MAIN_DRAFTS_PER_PASS
            )
              break;
            mainDraftsStarted++;

            try {
              // Rotate across topic candidates for diversity
              const topicForGap =
                topicCandidates.length > 0
                  ? (topicCandidates[
                      topicRotationIndex % topicCandidates.length
                    ] ?? null)
                  : null;
              topicRotationIndex++;

              const created = await createMarketForTimeframe(
                timeframe,
                config.durationMs,
                llmClient,
                gameState,
                topicForGap,
                topicCandidates,
                processId
              );

              if (created) {
                results.marketsCreated++;
              }
            } catch (error) {
              logger.error(
                'Failed to create market',
                {
                  timeframe,
                  error: error instanceof Error ? error.message : String(error),
                },
                'MarketsRecovery'
              );
            }
          }
        }
      }
    }
    metrics.creationMs = Date.now() - creationStart;

    // Step 4: Manage sub-markets (maintain up to 10)
    // Sub-markets are shorter-duration markets with random 15min-3hour durations
    // The final write transaction rechecks the cap and parent after inference.
    const subMarketStart = Date.now();
    let gapFillingSkippedDueToMax = false;

    if (canStartWork()) {
      const [subMarketCountResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(timeframedMarkets)
        .where(
          and(
            eq(timeframedMarkets.isActive, true),
            gt(timeframedMarkets.endTime, new Date()),
            isNotNull(timeframedMarkets.parentMarketId)
          )
        );
      const activeSubMarketCount = subMarketCountResult?.count ?? 0;
      const subMarketsNeeded = Math.max(
        0,
        MAX_SUB_MARKETS - activeSubMarketCount
      );

      logger.info(
        'Sub-market status',
        {
          activeSubMarkets: activeSubMarketCount,
          needed: subMarketsNeeded,
          max: MAX_SUB_MARKETS,
        },
        'MarketsRecovery'
      );

      gapFillingSkippedDueToMax = activeSubMarketCount >= MAX_SUB_MARKETS;

      const createCount = Math.min(subMarketsNeeded, MAX_SUB_MARKETS_PER_TICK);
      if (createCount > 0)
        logger.info(
          `Creating up to ${createCount} sub-markets this tick`,
          { needed: subMarketsNeeded, creating: createCount },
          'MarketsRecovery'
        );

      const parentMarkets =
        createCount > 0 && canStartWork()
          ? await db
              .select({
                id: timeframedMarkets.id,
                questionId: timeframedMarkets.questionId,
                questionText: questions.text,
                category: timeframedMarkets.category,
                arcState: timeframedMarkets.arcState,
                affiliatedActorIds: timeframedMarkets.affiliatedActorIds,
                affiliatedOrgIds: timeframedMarkets.affiliatedOrgIds,
                rootMarketId: timeframedMarkets.rootMarketId,
                topicKey: timeframedMarkets.topicKey,
                topicLabel: timeframedMarkets.topicLabel,
                topicDate: timeframedMarkets.topicDate,
                endTime: timeframedMarkets.endTime,
              })
              .from(timeframedMarkets)
              .leftJoin(
                questions,
                eq(questions.id, timeframedMarkets.questionId)
              )
              .where(
                and(
                  eq(timeframedMarkets.isActive, true),
                  gt(timeframedMarkets.endTime, new Date()),
                  isNull(timeframedMarkets.parentMarketId)
                )
              )
              .orderBy(sql`RANDOM()`)
              .limit(createCount)
          : [];

      // Create sub-markets for each parent, respecting deadline and parent's remaining time
      let skippedDueToInsufficientTime = 0;
      for (const parentMarket of parentMarkets) {
        if (!canStartWork()) {
          logger.info(
            'Deadline reached, stopping sub-market creation',
            { created: results.subMarketsCreated },
            'MarketsRecovery'
          );
          break;
        }

        try {
          // Check if parent has enough remaining time for a sub-market
          // Sub-market must end before parent resolves (with buffer)
          const nowMs = Date.now();
          const duration = getConstrainedSubMarketDuration(
            parentMarket.endTime,
            nowMs
          );

          if (duration === null) {
            // Parent doesn't have enough remaining time for a sub-market
            const remainingMinutes = Math.round(
              (parentMarket.endTime.getTime() - nowMs) / 60000
            );
            logger.debug(
              'Skipping parent market - insufficient remaining time',
              {
                parentId: parentMarket.id,
                remainingMinutes,
                minRequired: SUB_MARKET_MIN_DURATION_MS / 60000,
              },
              'MarketsRecovery'
            );
            skippedDueToInsufficientTime++;
            continue;
          }

          // Extract parent market data with proper typing for arc relevance
          // Use toStringArray for type-safe JSONB extraction
          const parentMarketData: ParentMarketData = {
            id: parentMarket.id,
            questionId: parentMarket.questionId,
            questionText: parentMarket.questionText,
            category: parseMarketCategory(
              parentMarket.category,
              `parent market ${parentMarket.id}`
            ),
            arcState: parentMarket.arcState,
            affiliatedActorIds: toStringArray(parentMarket.affiliatedActorIds),
            affiliatedOrgIds: toStringArray(parentMarket.affiliatedOrgIds),
            rootMarketId: parentMarket.rootMarketId,
            topicKey: parentMarket.topicKey,
            topicLabel: parentMarket.topicLabel,
            topicDate: parentMarket.topicDate,
          };
          const created = await createSubMarket(
            parentMarketData,
            duration,
            llmClient,
            gameState,
            processId
          );

          if (created) {
            results.subMarketsCreated++;
            logger.info(
              'Created sub-market',
              {
                parentId: parentMarket.id,
                duration: Math.round(duration / 60000),
                timeframe: inferSubMarketTimeframe(duration),
                parentEndsInMinutes: Math.round(
                  (parentMarket.endTime.getTime() - nowMs) / 60000
                ),
              },
              'MarketsRecovery'
            );
          }
        } catch (error) {
          logger.error(
            'Failed to create sub-market',
            {
              error: error instanceof Error ? error.message : String(error),
            },
            'MarketsRecovery'
          );
        }
      }

      // Log if we skipped any parents due to time constraints
      if (skippedDueToInsufficientTime > 0) {
        logger.info(
          'Some parent markets skipped due to insufficient remaining time',
          {
            skipped: skippedDueToInsufficientTime,
            created: results.subMarketsCreated,
          },
          'MarketsRecovery'
        );
      }

      // Invalidate cache after sub-market creation to ensure consistency
      if (results.subMarketsCreated > 0) {
        await invalidateCache('sub_markets', {
          namespace: CACHE_KEYS.ACTIVE_MARKETS,
        });
      }
    }
    metrics.subMarketCreationMs = Date.now() - subMarketStart;

    const durationMs = Date.now() - startTime;

    // Track sub-market specific metrics for monitoring
    const subMarketMetrics = {
      createdCount: results.subMarketsCreated,
      gapFillingSkippedDueToMax,
      creationTimeMs: metrics.subMarketCreationMs,
    };

    // Record execution for monitoring with detailed metrics
    recordCronExecution('markets-recovery', new Date(startTime), {
      success: true,
      durationMs,
      ...results,
      metrics,
      subMarketMetrics,
    });

    // Emit structured log for metrics aggregation (log drain / Datadog integration)
    logger.info(
      'sub_market_metrics',
      {
        '@type': 'metric',
        metric_name: 'sub_market_creation',
        created: subMarketMetrics.createdCount,
        skipped_due_to_cap: subMarketMetrics.gapFillingSkippedDueToMax ? 1 : 0,
        creation_time_ms: subMarketMetrics.creationTimeMs,
      },
      'MarketsRecovery'
    );

    // Log detailed performance breakdown for monitoring
    logger.info(
      'Markets recovery completed',
      {
        durationMs,
        ...results,
        performanceBreakdown: {
          activeMarketsQueryMs: metrics.getActiveMarketsMs,
          resolutionPhaseMs: metrics.resolutionMs,
          creationPhaseMs: metrics.creationMs,
          subMarketCreationPhaseMs: metrics.subMarketCreationMs,
          overheadMs:
            durationMs -
            metrics.getActiveMarketsMs -
            metrics.resolutionMs -
            metrics.creationMs -
            metrics.subMarketCreationMs,
        },
        subMarketMetrics,
      },
      'MarketsRecovery'
    );

    // Warn if execution is taking too long (over 2 minutes)
    if (durationMs > 120000) {
      logger.warn(
        'Markets recovery execution time exceeds 2 minutes',
        {
          durationMs,
          resolutionMs: metrics.resolutionMs,
          creationMs: metrics.creationMs,
          marketsResolved: results.marketsResolved,
          marketsCreated: results.marketsCreated,
        },
        'MarketsRecovery'
      );
    }

    return NextResponse.json({
      success: true,
      durationMs,
      ...results,
      metrics,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'Markets recovery failed',
      { error: errorMessage },
      'MarketsRecovery'
    );

    recordCronExecution('markets-recovery', new Date(startTime), {
      success: false,
      error: errorMessage,
    });

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  } finally {
    clearInterval(heartbeat);
    await renewal;
    await DistributedLockService.releaseLock(LOCK, processId);
  }
});

/**
 * Get active markets grouped by GRANULAR timeframe (e.g., '15m', '30m', '1h')
 *
 * IMPORTANT: Groups by granular timeframe derived from (endTime - startTime) duration,
 * NOT by the stored DB bucket timeframe ('flash', 'intraday', etc.).
 * This allows accurate gap-filling with correct durations for each MARKET_STRUCTURE key.
 *
 * Expired markets leave trading slots vacant while their proofs are pending.
 * Sub-markets are tracked separately.
 */
async function getActiveMarketsByTimeframe(): Promise<
  Record<
    string,
    Array<{ id: string; questionId: string | null; endTime: Date }>
  >
> {
  // Include granularTimeframe for direct grouping, with startTime as fallback for legacy markets.
  const activeTimeframedMarkets = await db
    .select({
      id: timeframedMarkets.id,
      questionId: timeframedMarkets.questionId,
      granularTimeframe: timeframedMarkets.granularTimeframe,
      startTime: timeframedMarkets.startTime,
      endTime: timeframedMarkets.endTime,
    })
    .from(timeframedMarkets)
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        gt(timeframedMarkets.endTime, new Date()),
        isNull(timeframedMarkets.parentMarketId)
      )
    );

  // Group by stored granularTimeframe, falling back to inference for legacy markets
  const grouped: Record<
    string,
    Array<{ id: string; questionId: string | null; endTime: Date }>
  > = {};

  for (const m of activeTimeframedMarkets) {
    // Use stored granularTimeframe if available, otherwise infer from duration (legacy fallback)
    const tf =
      m.granularTimeframe ??
      inferGranularTimeframe(m.endTime.getTime() - m.startTime.getTime());

    if (!grouped[tf]) {
      grouped[tf] = [];
    }
    grouped[tf].push({
      id: m.id,
      questionId: m.questionId,
      endTime: m.endTime,
    });
  }

  return grouped;
}

/**
 * Create a new market for a specific timeframe.
 *
 * SCALABILITY FOR 300K+ USERS:
 * - Uses QuestionManager with comprehensive game context (world events, trending)
 * - Stores arc metadata in timeframedMarkets table (single source of truth)
 * - No inline NPC trading - handled by npc-tick for decoupled processing
 * - Event generation handled by existing timeframe-arc-processor.ts
 */
async function createMarketForTimeframe(
  timeframe: string,
  durationMs: number,
  llmClient: FeedLLMClient,
  gameState: GameState,
  dailyTopic: DailyTopicContext | null,
  allTopics: DailyTopicContext[],
  leaseOwner: string
): Promise<boolean> {
  const now = new Date();
  const resolutionDate = new Date(now.getTime() + durationMs);

  try {
    if (!dailyTopic) {
      logger.warn(
        'Skipping main market creation because no daily topic is available',
        { timeframe },
        'MarketsRecovery'
      );
      return false;
    }

    // IDEMPOTENCY CHECK: Verify we haven't exceeded the limit for this GRANULAR timeframe
    // This prevents duplicate creation from concurrent cron executions or stale counts
    // Count markets by duration to match the granular timeframe (e.g., 15m vs 30m)
    const config = MARKET_STRUCTURE[timeframe];
    if (!config) {
      logger.warn(`Unknown timeframe: ${timeframe}`, {}, 'MarketsRecovery');
      return false;
    }

    // Invalidate cache before idempotency check to prevent race conditions
    // If two cron ticks start within the cache TTL window, both could read stale counts
    // and attempt to create duplicate markets for the same timeframe
    await invalidateCache('main_markets', {
      namespace: CACHE_KEYS.ACTIVE_MARKETS,
    });

    // Query active main markets with Redis caching for performance
    // Cache reduces DB queries from up to 10 (one per timeframe) to 1 per TTL window
    const activeMarkets = await getCacheOrFetch(
      'main_markets',
      async () => {
        return db
          .select({
            id: timeframedMarkets.id,
            granularTimeframe: timeframedMarkets.granularTimeframe,
            startTime: timeframedMarkets.startTime,
            endTime: timeframedMarkets.endTime,
          })
          .from(timeframedMarkets)
          .where(
            and(
              eq(timeframedMarkets.isActive, true),
              isNull(timeframedMarkets.parentMarketId) // Only count main markets, not sub-markets
            )
          );
      },
      {
        namespace: CACHE_KEYS.ACTIVE_MARKETS,
        ttl: DEFAULT_TTLS.ACTIVE_MARKETS,
      }
    );

    // Count markets matching this granular timeframe
    // Use stored granularTimeframe if available, fall back to inference for legacy markets
    const currentCount = activeMarkets.filter((m) => {
      if (m.endTime.getTime() <= now.getTime()) return false;
      const tf =
        m.granularTimeframe ??
        inferGranularTimeframe(m.endTime.getTime() - m.startTime.getTime());
      return tf === timeframe;
    }).length;

    const targetCount = config.count;

    if (currentCount >= targetCount) {
      logger.info(
        `Skipping ${timeframe} market creation - already at limit`,
        { currentCount, targetCount, timeframe },
        'MarketsRecovery'
      );
      return false;
    }

    const dbTimeframe = mapTimeframeToDbType(timeframe);

    logger.info(
      `Creating ${timeframe} market (stored as ${dbTimeframe})`,
      {
        resolutionDate: toISO(resolutionDate),
        durationMs,
        currentCount,
        targetCount,
      },
      'MarketsRecovery'
    );

    // Use QuestionManager for narrative-connected question generation
    // This queries world events, trending topics, and active questions for context
    const questionManager = new QuestionManager(llmClient);
    const questionData = await questionManager.generateTimeframeQuestion(
      timeframe,
      durationMs,
      dailyTopic,
      allTopics
    );

    if (!questionData) {
      logger.warn(
        `Failed to generate question for ${timeframe}`,
        {},
        'MarketsRecovery'
      );
      return false;
    }

    const questionTopic = questionData.topic ?? dailyTopic;

    // Pre-generate IDs before transaction to track for potential cleanup
    const questionId = await generateSnowflakeId();
    const questionNumber = await getNextQuestionNumber();
    const timeframedMarketId = await generateSnowflakeId();

    // Create timeframe-appropriate arc plan before transaction
    // Arc plan is used for:
    // 1. Determining signal direction in events (via timeframe-arc-processor)
    // 2. Identifying insider/deceiver NPCs for authentic posting
    // Filter actors by role or tier (fallback for actors without role defined)
    const actors = StaticDataRegistry.getAllActors()
      .filter(isEligibleActor)
      .slice(0, 30)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        tier: a.tier ?? undefined,
        role: a.role,
        personality: a.personality,
        domain: a.domain,
        affiliations: a.affiliations,
      }));

    const organizations = StaticDataRegistry.getAllOrganizations()
      .filter((o) => o.type === 'company')
      .slice(0, 20)
      .map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: o.type as
          | 'company'
          | 'media'
          | 'government'
          | 'vc'
          | 'organization'
          | 'financial',
        canBeInvolved: o.canBeInvolved ?? true,
      }));

    const arcPlan = timeframeArcPlanner.planTimeframeArc(
      questionId,
      questionData.text,
      timeframe,
      durationMs,
      questionData.expectedOutcome,
      actors,
      organizations,
      questionData.affiliatedActorIds,
      questionData.affiliatedOrgIds
    );

    // Wrap all DB writes in a transaction to prevent orphaned rows
    // If any step fails, the entire transaction rolls back
    let market!: { id: string };

    const committed = await db.transaction(async (tx) => {
      if (!(await ownsPredictionRecoveryLease(tx, leaseOwner))) return false;

      // Step 1: Create the question in the database
      await tx.insert(questions).values({
        id: questionId,
        questionNumber,
        text: questionData.text,
        scenarioId: DEFAULT_SCENARIO_ID,
        outcome: questionData.expectedOutcome,
        rank: 1,
        resolutionDate,
        status: 'active',
        topicKey: questionTopic.topicKey,
        topicLabel: questionTopic.topicLabel,
        topicDate: questionTopic.date,
        updatedAt: now,
      });

      // Step 2: Create corresponding market using CorePredictionMarketService
      // Uses MOCK_WALLET since this is system-level creation, not user-initiated
      // IMPORTANT: Pass tx to CorePredictionDbAdapter so market creation uses the same
      // transaction - ensures atomicity with question + timeframedMarket inserts
      const marketService = new CorePredictionMarketService({
        db: new CorePredictionDbAdapter(tx),
        wallet: MOCK_WALLET,
        fees: SYSTEM_MARKET_FEES,
      });
      const marketInitialization = getPredictionMarketInitialization({
        marketId: questionId,
        question: questionData.text,
        endDate: resolutionDate,
      });

      market = await marketService.ensureMarketExists({
        marketId: questionId,
        initialLiquidity: marketInitialization.initialLiquidity,
        initialYesProbability: marketInitialization.initialYesProbability,
        description: questionData.resolutionCriteria,
        gameId: gameState.id,
        dayNumber: gameState.currentDay,
      });

      // Step 3: Register in timeframedMarkets table - this is the SINGLE SOURCE OF TRUTH
      // for timeframe-based market state. The timeframe-arc-processor.ts reads from this
      // table to:
      // - Advance arc state (e.g., setup -> active -> climax)
      // - Generate events with appropriate signal direction
      // - Spawn sub-markets if configured
      await tx.insert(timeframedMarkets).values({
        id: timeframedMarketId,
        questionId,
        timeframe: dbTimeframe,
        granularTimeframe: timeframe, // Store precise timeframe key ('15m', '30m', etc.)
        category: inferCategory(questionData.text),
        topicKey: questionTopic.topicKey,
        topicLabel: questionTopic.topicLabel,
        topicDate: questionTopic.date,
        startTime: now,
        endTime: resolutionDate,
        arcState: getCurrentArcState(now, resolutionDate, dbTimeframe, now),
        arcStateEnteredAt: now,
        // Store affiliated actors/orgs for context in NPC behavior
        affiliatedActorIds: arcPlan.affiliatedActorIds,
        affiliatedOrgIds: arcPlan.affiliatedOrgIds,
      });
      await tx.insert(timeframedMarketRoles).values({
        timeframedMarketId,
        insiderActorIds: arcPlan.insiders,
        deceiverActorIds: arcPlan.deceivers,
      });
      return true;
    });
    if (!committed) return false;

    logger.info(
      `Created ${timeframe} market`,
      {
        questionNumber,
        questionId,
        marketId: market.id,
        timeframedMarketId,
        resolutionDate: toISO(resolutionDate),
        topicKey: questionTopic.topicKey,
        topicLabel: questionTopic.topicLabel,
        arcPhases: arcPlan.phaseOrder.length,
        insiders: arcPlan.insiders.length,
        deceivers: arcPlan.deceivers.length,
      },
      'MarketsRecovery'
    );

    // NPC trading on new markets is handled by npc-tick
    // This decoupling provides better scalability:
    // - markets-recovery focuses on market lifecycle
    // - npc-tick handles all NPC behavior independently
    // - No inline LLM calls for NPC decisions

    // Invalidate active markets cache so next creation uses fresh data
    await invalidateCache('main_markets', {
      namespace: CACHE_KEYS.ACTIVE_MARKETS,
    });

    return true;
  } catch (error) {
    logger.error(
      `Failed to create ${timeframe} market`,
      { error: error instanceof Error ? error.message : String(error) },
      'MarketsRecovery'
    );
    return false;
  }
}

/**
 * Infer market category from question text.
 * Used for filtering and organization in the UI.
 */
function inferCategory(questionText: string): MarketCategory {
  const text = questionText.toLowerCase();

  if (
    text.includes('bitcoin') ||
    text.includes('crypto') ||
    text.includes('eth') ||
    text.includes('token') ||
    text.includes('blockchain')
  ) {
    return 'crypto';
  }
  if (
    text.includes('tech') ||
    text.includes('software') ||
    text.includes('ai') ||
    text.includes('stock') ||
    text.includes('share') ||
    text.includes('ticker')
  ) {
    return 'tech';
  }
  if (
    text.includes('president') ||
    text.includes('congress') ||
    text.includes('vote') ||
    text.includes('election') ||
    text.includes('senate')
  ) {
    return 'politics';
  }
  if (
    text.includes('movie') ||
    text.includes('album') ||
    text.includes('celebrity') ||
    text.includes('award') ||
    text.includes('music')
  ) {
    return 'entertainment';
  }
  if (
    text.includes('game') ||
    text.includes('match') ||
    text.includes('championship') ||
    text.includes('score') ||
    text.includes('team')
  ) {
    return 'sports';
  }
  if (
    text.includes('research') ||
    text.includes('study') ||
    text.includes('discovery') ||
    text.includes('experiment')
  ) {
    return 'science';
  }
  if (
    text.includes('ceo') ||
    text.includes('company') ||
    text.includes('merger') ||
    text.includes('deal') ||
    text.includes('earnings')
  ) {
    return 'business';
  }

  return 'general';
}

/**
 * Map our timeframe strings to database MarketTimeframe enum values.
 * Delegates to the shared mapping function from @feed/engine which
 * throws on unknown timeframes to fail fast.
 */
function mapTimeframeToDbType(timeframe: string): MarketTimeframe {
  return mapGranularToDbTimeframe(timeframe);
}

/**
 * Infer the granular timeframe key (e.g., '15m', '30m', '1h') from a duration in milliseconds.
 * This is used to properly group active markets by their intended MARKET_STRUCTURE key,
 * allowing accurate gap-filling with correct durations.
 *
 * Uses threshold-based matching with 10% tolerance to handle minor variations.
 */
function inferGranularTimeframe(durationMs: number): string {
  // Sort entries by duration ascending to find the best match
  const sortedEntries = Object.entries(MARKET_STRUCTURE).sort(
    (a, b) => a[1].durationMs - b[1].durationMs
  );

  // Find the closest matching timeframe with 10% tolerance
  for (const [key, config] of sortedEntries) {
    const tolerance = config.durationMs * 0.1;
    if (Math.abs(durationMs - config.durationMs) <= tolerance) {
      return key;
    }
  }

  // If no match found, find the closest one
  let closestKey = '1h'; // Default fallback
  let closestDiff = Infinity;

  for (const [key, config] of sortedEntries) {
    const diff = Math.abs(durationMs - config.durationMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestKey = key;
    }
  }

  return closestKey;
}

/**
 * Get the next question number using an efficient MAX query.
 * Uses a single SQL aggregation instead of fetching all rows.
 */
async function getNextQuestionNumber(): Promise<number> {
  const result = await db
    .select({ maxNumber: max(questions.questionNumber) })
    .from(questions);

  // Handle null/undefined case (no questions exist yet)
  const rawMaxNumber = result[0]?.maxNumber;

  // Coerce to JS number - DB may return string, bigint, or number
  let maxNumber: number;
  if (rawMaxNumber === null || rawMaxNumber === undefined) {
    maxNumber = 0;
  } else if (typeof rawMaxNumber === 'bigint') {
    maxNumber = Number(rawMaxNumber);
  } else if (typeof rawMaxNumber === 'string') {
    maxNumber = parseInt(rawMaxNumber, 10);
    if (Number.isNaN(maxNumber)) {
      maxNumber = 0;
    }
  } else {
    maxNumber = Number(rawMaxNumber);
  }

  return maxNumber + 1;
}

// Old generateTimeframeQuestion and buildQuestionPrompt removed - now using QuestionManager.generateTimeframeQuestion()

// ============================================================================
// Sub-Market Creation
// ============================================================================

/**
 * Valid MarketCategory values for runtime validation
 */
const VALID_MARKET_CATEGORIES: readonly MarketCategory[] = [
  'tech',
  'crypto',
  'politics',
  'sports',
  'business',
  'entertainment',
  'science',
  'general',
] as const;

/**
 * Type guard to check if a string is a valid MarketCategory
 */
function isMarketCategory(value: unknown): value is MarketCategory {
  return (
    typeof value === 'string' &&
    VALID_MARKET_CATEGORIES.includes(value as MarketCategory)
  );
}

/**
 * Parse a string to MarketCategory with validation.
 * Returns the validated category or 'general' as fallback.
 * - null, undefined, or empty string: silently returns 'general' (missing data)
 * - invalid non-empty string: logs warning and returns 'general'
 */
function parseMarketCategory(
  value: string | null | undefined,
  context?: string
): MarketCategory {
  if (isMarketCategory(value)) {
    return value;
  }
  // Treat null, undefined, and empty string as missing data - no warning needed
  if (value === null || value === undefined || value === '') {
    return 'general';
  }
  // Only warn for invalid non-empty strings (likely a bug or data corruption)
  logger.warn(
    `Invalid MarketCategory "${value}"${context ? ` in ${context}` : ''}, defaulting to "general"`,
    { invalidValue: value, context },
    'MarketsRecovery'
  );
  return 'general';
}

/**
 * Full parent market data needed for arc-relevant sub-market creation
 */
interface ParentMarketData {
  id: string;
  questionId: string | null;
  questionText?: string | null;
  category: MarketCategory;
  arcState: string;
  affiliatedActorIds: string[];
  affiliatedOrgIds: string[];
  rootMarketId: string | null;
  topicKey?: string | null;
  topicLabel?: string | null;
  topicDate?: Date | null;
}

function resolveTopicForMarket(
  market: {
    topicKey?: string | null;
    topicLabel?: string | null;
    topicDate?: Date | string | null;
    questionText?: string | null;
  },
  fallbackDate = new Date()
): DailyTopicContext {
  if (market.topicKey && market.topicLabel) {
    return {
      date: market.topicDate
        ? normalizeTopicDate(new Date(market.topicDate))
        : normalizeTopicDate(fallbackDate),
      topicKey: market.topicKey,
      topicLabel: market.topicLabel,
      summary: market.questionText?.trim() || market.topicLabel,
      sourceType: 'fallback_previous_day',
      sourceHeadlineIds: [],
      selectionReason: 'Inherited from parent market topic',
      isLocked: false,
    };
  }

  return deriveTopicFromText(
    market.questionText?.trim() || 'Legacy parent market topic',
    fallbackDate
  );
}

/**
 * Create a sub-market linked to a parent market.
 * Sub-markets inherit the parent's category and affiliations to maintain arc relevance.
 * The question is generated based on the parent's context (actors, orgs, category).
 */
async function createSubMarket(
  parentMarket: ParentMarketData,
  durationMs: number,
  llmClient: FeedLLMClient,
  gameState: GameState,
  leaseOwner: string
): Promise<boolean> {
  const timeframe = inferSubMarketTimeframe(durationMs);
  const inheritedTopic = resolveTopicForMarket(parentMarket);

  try {
    // Get parent's affiliated entities for context - inherit these for arc relevance
    const parentOrgIds = parentMarket.affiliatedOrgIds ?? [];
    const parentActorIds = parentMarket.affiliatedActorIds ?? [];

    // Build context from parent's affiliations for logging
    let contextOrg: { name: string; ticker?: string } | undefined;
    let contextActor: { name: string; id: string } | undefined;

    const firstOrgId = parentOrgIds[0];
    if (firstOrgId) {
      const org = StaticDataRegistry.getOrganization(firstOrgId);
      if (org) {
        contextOrg = { name: org.name, ticker: org.ticker };
      }
    }

    const firstActorId = parentActorIds[0];
    if (firstActorId) {
      const actor = StaticDataRegistry.getActor(firstActorId);
      if (actor) {
        contextActor = { name: actor.name, id: actor.id };
      }
    }

    logger.debug(
      'Creating arc-relevant sub-market',
      {
        parentId: parentMarket.id,
        parentCategory: parentMarket.category,
        parentArcState: parentMarket.arcState,
        contextOrg: contextOrg?.name,
        contextActor: contextActor?.name,
      },
      'MarketsRecovery'
    );

    // Generate question for sub-market using QuestionManager
    // The question will be generated based on timeframe, but we'll inherit
    // the parent's affiliations and category to maintain arc relevance
    const questionManager = new QuestionManager(llmClient);
    const questionData = await questionManager.generateTimeframeQuestion(
      timeframe,
      durationMs,
      inheritedTopic
    );

    if (!questionData) {
      logger.warn(
        'Failed to generate question for sub-market',
        {
          parentId: parentMarket.id,
          timeframe,
          category: parentMarket.category,
        },
        'MarketsRecovery'
      );
      return false;
    }

    // Pre-generate IDs
    const questionId = await generateSnowflakeId();
    const questionNumber = await getNextQuestionNumber();
    const timeframedMarketId = await generateSnowflakeId();

    // Create arc plan for the sub-market - inherit parent's affiliations if question didn't specify
    const finalAffiliatedActorIds = questionData.affiliatedActorIds?.length
      ? questionData.affiliatedActorIds
      : parentActorIds;
    const finalAffiliatedOrgIds = questionData.affiliatedOrgIds?.length
      ? questionData.affiliatedOrgIds
      : parentOrgIds;

    const actors = StaticDataRegistry.getAllActors()
      .filter(isEligibleActor)
      .slice(0, 30)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        tier: a.tier ?? undefined,
        role: a.role,
        personality: a.personality,
        domain: a.domain,
        affiliations: a.affiliations,
      }));

    const organizations = StaticDataRegistry.getAllOrganizations()
      .filter((o) => o.type === 'company')
      .slice(0, 20)
      .map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: o.type as
          | 'company'
          | 'media'
          | 'government'
          | 'vc'
          | 'organization'
          | 'financial',
        canBeInvolved: o.canBeInvolved ?? true,
      }));

    const arcPlan = timeframeArcPlanner.planTimeframeArc(
      questionId,
      questionData.text,
      timeframe,
      durationMs,
      questionData.expectedOutcome,
      actors,
      organizations,
      finalAffiliatedActorIds,
      finalAffiliatedOrgIds
    );

    const created = await writeSubMarket({
      parentId: parentMarket.id,
      category: parentMarket.category,
      questionId,
      questionNumber,
      questionText: questionData.text,
      expectedOutcome: questionData.expectedOutcome,
      resolutionCriteria: questionData.resolutionCriteria,
      timeframedMarketId,
      durationMs,
      timeframe,
      topic: inheritedTopic,
      arcState: (arcPlan.phaseOrder[0] || 'setup') as ArcStateType,
      roles: {
        insiderActorIds: arcPlan.insiders,
        deceiverActorIds: arcPlan.deceivers,
      },
      affiliatedActorIds: finalAffiliatedActorIds,
      affiliatedOrgIds: finalAffiliatedOrgIds,
      gameId: gameState.id,
      dayNumber: gameState.currentDay,
      leaseOwner,
    });
    if (!created) return false;

    // Create announcement post for the sub-market with market context
    await createSubMarketPost(questionId, questionData.text, gameState, {
      affiliatedActorIds: finalAffiliatedActorIds,
      affiliatedOrgIds: finalAffiliatedOrgIds,
      category: parentMarket.category,
      topicLabel: inheritedTopic.topicLabel,
    });

    logger.info(
      `Created arc-relevant sub-market Q${questionNumber}`,
      {
        questionId,
        parentId: parentMarket.id,
        category: parentMarket.category,
        topicKey: inheritedTopic.topicKey,
        timeframe,
        durationMinutes: Math.round(durationMs / 60000),
        inheritedOrgs: finalAffiliatedOrgIds.length,
        inheritedActors: finalAffiliatedActorIds.length,
      },
      'MarketsRecovery'
    );

    return true;
  } catch (error) {
    logger.error(
      'Failed to create sub-market',
      {
        parentId: parentMarket.id,
        error: error instanceof Error ? error.message : String(error),
      },
      'MarketsRecovery'
    );
    return false;
  }
}

/**
 * Create a feed post announcing a new sub-market.
 * Uses relevance-based media organization selection for announcements.
 * Links the post to the question via relatedQuestion for analytics/filtering.
 * Sets gameId and dayNumber for consistency with other cron jobs.
 */
async function createSubMarketPost(
  questionId: string,
  questionText: string,
  gameState: GameState,
  parentMarketContext?: {
    affiliatedActorIds: string[];
    affiliatedOrgIds: string[];
    category: MarketCategory;
    topicLabel?: string;
  }
): Promise<void> {
  try {
    // Select a relevant media organization based on market context
    // Falls back to random selection if no context provided
    const mediaOrgs = StaticDataRegistry.getOrganizationsByType('media');
    const mediaOrg = parentMarketContext
      ? selectRelevantMediaOrg(
          parentMarketContext.affiliatedActorIds,
          parentMarketContext.affiliatedOrgIds,
          parentMarketContext.category
        )
      : (mediaOrgs[Math.floor(secureRandom() * mediaOrgs.length)] ?? null);

    if (!mediaOrg) {
      logger.warn(
        'No media organization found for sub-market announcement',
        {},
        'MarketsRecovery'
      );
      return;
    }

    // Query the questionNumber to link the post to the question
    const [questionData] = await db
      .select({ questionNumber: questions.questionNumber })
      .from(questions)
      .where(eq(questions.id, questionId))
      .limit(1);

    const postId = await generateSnowflakeId();
    const durationLabel = 'short-term';

    await db.insert(posts).values({
      id: postId,
      authorId: mediaOrg.id,
      content: `NEW MARKET: "${questionText}"\n\nA new ${durationLabel} prediction market is now open${parentMarketContext?.topicLabel ? ` as part of today's ${parentMarketContext.topicLabel} storyline` : ''}. Trade now before it closes!`,
      timestamp: new Date(),
      type: 'market_announcement',
      gameId: gameState.id,
      dayNumber: gameState.currentDay ?? 1,
      relatedQuestion: questionData?.questionNumber ?? null,
    });

    logger.debug(
      'Created sub-market announcement post',
      {
        postId,
        questionId,
        questionNumber: questionData?.questionNumber,
        orgId: mediaOrg.id,
      },
      'MarketsRecovery'
    );
  } catch (error) {
    // Non-critical error - log but don't fail market creation
    logger.warn(
      'Failed to create sub-market announcement post',
      { error: error instanceof Error ? error.message : String(error) },
      'MarketsRecovery'
    );
  }
}
