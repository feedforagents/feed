import {
  DistributedLockService,
  recordCronExecution,
  successResponse,
} from '@feed/api';
import { dbWrite, eq, games } from '@feed/db';
import { createParodyHeadlineGenerator, rssFeedService } from '@feed/engine';
import { logger } from '@feed/shared';

const HEADLINE_LOCK = 'world-headlines';
const HEADLINE_LEASE_MS = 120_000;
const HEADLINE_DEADLINE_MS = 85_000;
const RSS_DEADLINE_MS = 45_000;

export async function refreshHeadlines(
  failedStages: string[],
  signal?: AbortSignal
) {
  let feed = { fetched: 0, stored: 0, errors: 0 };
  try {
    feed = await rssFeedService.fetchAllFeeds(
      signal
        ? {
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(RSS_DEADLINE_MS),
            ]),
            timeoutMs: 4_000,
            attempts: 1,
          }
        : undefined
    );
    if (signal && feed.fetched === 0) failedStages.push('rss');
    logger.info('RSS feed sweep finished', feed, 'Cron');
  } catch (error) {
    failedStages.push('rss');
    logger.error('Error fetching RSS feeds', { error }, 'Cron');
  }

  let parodiesGenerated = 0;
  try {
    signal?.throwIfAborted();
    const headlines = await rssFeedService.getUntransformedHeadlines(
      signal ? 1 : 20
    );
    if (headlines.length > 0) {
      const generator = createParodyHeadlineGenerator();
      const parodies = await generator.processHeadlines(headlines, signal);
      parodiesGenerated = parodies.length;
    }
    logger.info(
      'Parody headline generation finished',
      { parodiesGenerated },
      'Cron'
    );
  } catch (error) {
    failedStages.push('parodies');
    logger.error('Error generating parody headlines', { error }, 'Cron');
  }

  return {
    feedsFetched: feed.fetched,
    newHeadlines: feed.stored,
    feedErrors: feed.errors,
    parodiesGenerated,
  };
}

export async function runScheduledHeadlines() {
  if (process.env.DEPLOYMENT_ENV !== 'localnet') {
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Headline refresh is enabled only in localnet',
    });
  }

  const startTime = Date.now();
  const gameStart = process.env.GAME_START?.toLowerCase();
  if (gameStart === 'pause' || gameStart === 'false' || gameStart === '0') {
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Game disabled via GAME_START environment variable',
    });
  }

  const [game] = await dbWrite
    .select({ isRunning: games.isRunning })
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);
  if (!game?.isRunning) {
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Continuous game is not running',
    });
  }

  const processId = crypto.randomUUID();
  const acquired = await DistributedLockService.acquireLock({
    lockId: HEADLINE_LOCK,
    durationMs: HEADLINE_LEASE_MS,
    operation: HEADLINE_LOCK,
    processId,
  });
  if (!acquired) {
    return successResponse({
      success: true,
      skipped: true,
      reason: 'Previous headline refresh is still running',
    });
  }

  try {
    const failedStages: string[] = [];
    const stats = await refreshHeadlines(
      failedStages,
      AbortSignal.timeout(HEADLINE_DEADLINE_MS)
    );
    const success = failedStages.length === 0;
    recordCronExecution(HEADLINE_LOCK, new Date(startTime), {
      success,
      failedStages,
      ...stats,
    });
    return successResponse({
      success,
      failedStages,
      duration: Date.now() - startTime,
      stats,
    });
  } finally {
    await DistributedLockService.releaseLock(HEADLINE_LOCK, processId);
  }
}
