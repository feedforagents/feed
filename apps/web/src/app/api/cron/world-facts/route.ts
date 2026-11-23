/**
 * World Facts Update Cron Job API
 *
 * @route POST /api/cron/world-facts - Update world facts
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Consolidates world facts twice daily at 6 AM and 6 PM UTC. In localnet,
 * the authenticated ?mode=headlines job owns RSS and parodies on its own
 * five-minute schedule while the game is running.
 *
 * @openapi
 * /api/cron/world-facts:
 *   post:
 *     tags:
 *       - Cron
 *     summary: Update world facts
 *     description: Consolidates world facts (requires CRON_SECRET)
 *     security:
 *       - CronSecret: []
 *     responses:
 *       200:
 *         description: World facts updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 headlinesGenerated:
 *                   type: integer
 *                 headlinesCleaned:
 *                   type: integer
 *       403:
 *         description: Invalid or missing CRON_SECRET
 *
 * @example
 * ```typescript
 * await fetch('/api/cron/world-facts', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
 * });
 * ```
 *
 * @see {@link /lib/services/rss-feed-service} RSS feed service
 * @see {@link /lib/services/parody-headline-generator} Parody headline generator
 */

import {
  errorResponse,
  requireCronAuth,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  type DailyTopicContext,
  dailyTopicService,
  FeedLLMClient,
  rssFeedService,
  WorldFactsConsolidator,
  worldFactsGenerator,
} from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { refreshHeadlines, runScheduledHeadlines } from './headlines';

export const POST = withErrorHandling(async (request: NextRequest) => {
  requireCronAuth(request, { jobName: 'WorldFactsCron' });

  const mode = request.nextUrl.searchParams.get('mode');
  if (mode === 'headlines') return runScheduledHeadlines();
  if (mode !== null) {
    return errorResponse('Unknown world facts mode', 'INVALID_MODE', 400);
  }

  const startTime = Date.now();
  logger.info('🌍 World facts update started', undefined, 'Cron');
  const failedStages: string[] = [];
  // Hosted environments retain their existing pipeline until the spend cap is
  // deployed. The localnet headline schedule is the sole owner in localnet.
  const headlineStats =
    process.env.DEPLOYMENT_ENV === 'localnet'
      ? undefined
      : await refreshHeadlines(failedStages);

  // Clean up old headlines (older than 7 days)
  let cleaned = 0;
  try {
    logger.info('Cleaning up old headlines...', undefined, 'Cron');
    cleaned = await rssFeedService.cleanupOldHeadlines();
    logger.info(
      `Cleaned up ${cleaned} old headlines`,
      { count: cleaned },
      'Cron'
    );
  } catch (error) {
    failedStages.push('cleanup');
    logger.error('Error cleaning up old headlines', { error }, 'Cron');
  }

  let dailyTopic: DailyTopicContext | null = null;
  try {
    dailyTopic = await dailyTopicService.ensureTopicForDate(new Date());
  } catch (error) {
    failedStages.push('dailyTopic');
    logger.error('Error selecting daily topic', { error }, 'Cron');
  }

  // Generate new world facts from game activity
  // This creates fresh context based on events, markets, questions, and actor activity
  logger.info(
    'Generating new world facts from game activity...',
    undefined,
    'Cron'
  );
  let factsResult = {
    generated: 0,
    archived: 0,
    sources: { events: 0, markets: 0, questions: 0, actors: 0 },
  };
  try {
    factsResult = await worldFactsGenerator.generateNewWorldFacts();
    logger.info(
      `Generated ${factsResult.generated} new world facts, archived ${factsResult.archived}`,
      factsResult,
      'Cron'
    );
  } catch (error) {
    failedStages.push('worldFacts');
    logger.error('Error generating world facts', { error }, 'Cron');
  }

  // Consolidate similar world facts to reduce context bloat
  let consolidationResult = { consolidated: 0, archived: 0, skipped: 0 };
  try {
    const llm = FeedLLMClient.forGameTick();
    const consolidator = new WorldFactsConsolidator(llm);
    consolidationResult = await consolidator.consolidateFacts();
    logger.info('World facts consolidated', consolidationResult, 'Cron');
  } catch (error) {
    failedStages.push('consolidation');
    logger.error('Error consolidating world facts', { error }, 'Cron');
  }

  const duration = Date.now() - startTime;
  logger.info(
    '✅ World facts update completed',
    {
      duration: `${duration}ms`,
      ...headlineStats,
      headlinesCleaned: cleaned,
      dailyTopic: dailyTopic?.topicLabel ?? null,
      worldFactsGenerated: factsResult.generated,
      worldFactsArchived: factsResult.archived,
      factsConsolidated: consolidationResult.consolidated,
    },
    'Cron'
  );

  return successResponse({
    // Independent stages still run after a failure, but the run is only
    // reported successful when every stage succeeded.
    success: failedStages.length === 0,
    failedStages,
    duration,
    stats: {
      ...headlineStats,
      headlinesCleaned: cleaned,
      dailyTopic,
      worldFactsGenerated: factsResult.generated,
      worldFactsArchived: factsResult.archived,
      worldFactsSources: factsResult.sources,
      consolidation: consolidationResult,
    },
  });
});

// Cron schedulers may use GET; it runs the same authenticated handler.
export const GET = POST;
