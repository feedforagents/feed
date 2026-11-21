/**
 * Article Tick Cron Job API
 *
 * @route POST /api/cron/article-tick - Execute article generation tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Centralized cron job for ALL article generation. Runs independently from
 * organization-tick which handles short social media posts.
 *
 * This separation provides:
 * 1. Clear rate limiting control (2 articles/hour max)
 * 2. Event-driven article generation (arc events, question milestones)
 * 3. Proper pacing without flooding the feed
 * 4. Organizations can be aware of their own articles for context
 *
 * Architecture:
 * - game-tick: Game engine (markets, events, world state)
 * - npc-tick: Actor NPCs (Sam AIltman, AIlon Musk, etc.)
 * - organization-tick: Media org POSTS only (short news updates)
 * - article-tick: ALL article generation (centralized)
 */

import {
  DistributedLockService,
  getCacheOrFetch,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import { db, eq, games } from '@feed/db';
import {
  type Article,
  ArticleGenerator,
  articleRateLimiter,
  FeedLLMClient,
  getActiveEventsForPosting,
  hasEventBeenCovered,
  markEventAsCovered,
  persistArticle,
  type StaticActor,
  StaticDataRegistry,
  type StaticOrganization,
  secureRandom,
  worldFactsService,
} from '@feed/engine';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

/** Valid values for Actor.initialLuck field */
const VALID_INITIAL_LUCK = ['low', 'medium', 'high'] as const;
type InitialLuck = (typeof VALID_INITIAL_LUCK)[number];

/**
 * Type guard to validate initialLuck values at runtime.
 * Ensures the string value is one of the allowed union members.
 */
function isValidInitialLuck(value: unknown): value is InitialLuck {
  return (
    typeof value === 'string' &&
    VALID_INITIAL_LUCK.includes(value as InitialLuck)
  );
}

/**
 * Map StaticActor[] to Actor[] interface expected by ArticleGenerator.
 * Extracted to module-scope helper to avoid duplication between
 * generateEventArticle and generateBaselineArticle.
 */
function mapStaticActorsToActors(actorsList: StaticActor[]) {
  return actorsList.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    domain: a.domain,
    personality: a.personality,
    tier: a.tier ?? undefined,
    affiliations: a.affiliations,
    postStyle: a.postStyle,
    postExample: a.postExample, // Keep as string[] to match Actor interface
    role: a.role,
    // Validate initialLuck at runtime - use validated value or default to 'medium'
    initialLuck: isValidInitialLuck(a.initialLuck) ? a.initialLuck : 'medium',
    initialMood: a.initialMood,
  }));
}

/**
 * Map StaticOrganization to Organization interface expected by ArticleGenerator.
 */
function mapStaticOrgToOrganization(org: StaticOrganization) {
  return {
    id: org.id,
    name: org.name,
    description: org.description,
    type: org.type,
    canBeInvolved: org.canBeInvolved,
  };
}

/**
 * Create a standardized question object for ArticleGenerator.
 * Centralizes question construction to ensure consistency between
 * event articles and baseline articles.
 *
 * @param id - Question identifier (event questionId or synthetic baseline ID)
 * @param text - Question/topic text for the article
 */
function createQuestionForArticle(id: string, text: string) {
  return {
    id,
    text,
    scenario: 1, // Default - article-tick articles don't have scenario context
    outcome: false,
    rank: 1, // Default - article-tick articles don't have ranking context
    createdDate: new Date().toISOString().split('T')[0]!,
    resolutionDate: '',
    status: 'active' as const,
  };
}

/**
 * Result type for article generation helpers.
 * Distinguishes between success, skip (rate limit), and error for accurate metrics.
 */
type ArticleGenerationResult =
  | { status: 'success'; id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

export const dynamic = 'force-dynamic';

// Leave room before the internal scheduler's 30-second request deadline.
const RATE_LIMIT_WAIT_MS = 25_000;
// The queued Worker has a longer request deadline.
const WORKER_RATE_LIMIT_WAIT_MS = 120_000;

/**
 * Helper to persist an article using the shared persistence service.
 * Converts Article from ArticleGenerator to ArticlePersistInput format.
 *
 * @param article - The Article from ArticleGenerator (already has parody names)
 * @param gameState - Current game state for context
 * @returns Result from the persistence service
 */
async function persistArticleFromGenerator(
  article: Article,
  gameState: GameState,
  rateLimitWaitUntil: number
) {
  // Validate required fields before calling persistence service
  if (!article.id?.trim()) {
    throw new Error('Missing article id');
  }
  if (!article.title?.trim()) {
    throw new Error('Missing article title');
  }
  if (!article.summary?.trim()) {
    throw new Error('Missing article summary');
  }
  if (!article.content?.trim()) {
    throw new Error('Missing article body');
  }
  if (!article.authorOrgId) {
    throw new Error('Missing authorOrgId');
  }
  if (!gameState?.id) {
    throw new Error('Missing gameState.id');
  }

  // Use the shared persistence service
  return persistArticle(
    {
      id: article.id,
      title: article.title,
      summary: article.summary,
      content: article.content,
      authorOrgId: article.authorOrgId,
      gameId: gameState.id,
      dayNumber: gameState.currentDay ?? 1,
      byline: article.byline,
      biasScore: article.biasScore,
      sentiment: article.sentiment,
      slant: article.slant,
      category: article.category,
      relatedQuestion: article.relatedQuestion,
    },
    { rateLimitWaitUntil }
  );
}

/**
 * GET /api/cron/article-tick
 * Alias for POST endpoint to support GET requests from cron services.
 */
export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

/**
 * POST /api/cron/article-tick
 *
 * Generates articles based on active events and questions.
 * Rate limited to prevent feed flooding.
 */
export const POST = withErrorHandling(async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: 'ArticleTick' })) {
    logger.warn(
      'Unauthorized article-tick request attempt',
      undefined,
      'ArticleTick'
    );
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  const startTime = Date.now();
  const processId = `article-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info('Article tick started', { processId }, 'ArticleTick');

  // Relay to staging if configured (fan-out)
  const relayResult = await relayCronToStaging(_req, 'article-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      { status: relayResult.status, error: relayResult.error },
      'ArticleTick'
    );
  }

  // Acquire global lock to prevent overlapping cron invocations
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: 'article-tick-global',
    durationMs: 300 * 1000, // 5 minutes
    operation: 'article-tick-global',
    processId,
  });
  if (!globalLockAcquired) {
    logger.info(
      'Article tick skipped - previous tick still running',
      { processId },
      'ArticleTick'
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous tick still running',
      articlesCreated: 0,
    });
  }

  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping article tick',
        { GAME_START: process.env.GAME_START },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled via GAME_START environment variable',
        articlesCreated: 0,
      });
    }

    // Check Game status from database
    const gameState = await getCacheOrFetch<GameState | null>(
      'continuous-game',
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
        return game ?? null;
      },
      { namespace: 'article-tick', ttl: 60 }
    );

    if (!gameState) {
      logger.info(
        'Article tick skipped (No continuous game found)',
        {},
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No continuous game found',
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    if (!gameState.isRunning) {
      logger.info(
        'Article tick paused (Game is not running)',
        { gameId: gameState.id },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game is paused',
        gameId: gameState.id,
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    // The internal scheduler also sends a cron timestamp on localnet.
    const scheduledTime = Number(_req.headers.get('x-cloudflare-cron-time'));
    const fromQueuedWorker =
      _req.method === 'GET' &&
      Number.isSafeInteger(scheduledTime) &&
      scheduledTime > 0 &&
      !_req.headers
        .get('user-agent')
        ?.startsWith('feed-internal-cron-scheduler/');
    // Generate during a short wait for capacity, then enforce the cap at publication.
    const rateLimitWaitUntil =
      startTime +
      (fromQueuedWorker ? WORKER_RATE_LIMIT_WAIT_MS : RATE_LIMIT_WAIT_MS);
    const { allowed, currentCount, maxAllowed, remaining } =
      await articleRateLimiter.canGenerateArticle();

    if (
      !allowed &&
      (await articleRateLimiter.getNextAvailableAt()) > rateLimitWaitUntil
    ) {
      logger.info(
        'Article tick skipped - rate limit reached',
        { currentCount, maxAllowed },
        'ArticleTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Rate limit reached',
        currentCount,
        maxAllowed,
        duration: Date.now() - startTime,
        articlesCreated: 0,
      });
    }

    logger.info(
      'Article tick admitted to generation',
      { currentCount, maxAllowed, remaining },
      'ArticleTick'
    );

    // Get news organizations from static registry
    const newsOrgs = StaticDataRegistry.getOrganizationsByType('media');
    const actorsList = StaticDataRegistry.getTopActors(50);

    if (newsOrgs.length === 0) {
      logger.warn('No news organizations found', {}, 'ArticleTick');
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No news organizations available',
        articlesCreated: 0,
      });
    }

    // Get active events for article generation
    const activeEventsData = await getActiveEventsForPosting();

    // Get world facts context with graceful fallback if service fails
    let worldFactsContext = '';
    try {
      worldFactsContext = await worldFactsService.generatePromptContext();
    } catch (error) {
      logger.warn(
        'Failed to fetch world facts context - proceeding without',
        { error: error instanceof Error ? error.message : String(error) },
        'ArticleTick'
      );
    }

    // Create LLM client for article generation
    const llmClient = FeedLLMClient.forGameTick();

    let result: ArticleGenerationResult | undefined;

    // Generate articles based on active events. Events are tried in random
    // order until an uncovered one is found, so an already-covered random
    // pick does not fall through to a baseline article while other events
    // still need coverage.
    const candidates = activeEventsData.activeEvents.filter(
      (event) => event.visibility === 'public' || event.visibility === 'leaked'
    );
    while (candidates.length > 0) {
      const [event] = candidates.splice(
        Math.floor(secureRandom() * candidates.length),
        1
      );
      if (!event) break;

      const eventId = event.questionId;
      if (await hasEventBeenCovered(eventId)) {
        logger.debug(
          'Event already covered - skipping',
          { eventId },
          'ArticleTick'
        );
        continue;
      }

      const org = newsOrgs[Math.floor(secureRandom() * newsOrgs.length)]!;
      result = await generateEventArticle(
        event,
        org,
        actorsList,
        worldFactsContext,
        gameState,
        llmClient,
        rateLimitWaitUntil
      );
      if (result.status === 'success') {
        await markEventAsCovered(eventId, org.id, result.id);
        logger.info(
          `Article created by ${org.name}`,
          { eventId, articleId: result.id },
          'ArticleTick'
        );
      }
      break;
    }

    // A tick makes one article attempt. Editorials fill slots with no uncovered event.
    if (!result) {
      const org = newsOrgs[Math.floor(secureRandom() * newsOrgs.length)]!;
      result = await generateBaselineArticle(
        org,
        actorsList,
        worldFactsContext,
        gameState,
        llmClient,
        rateLimitWaitUntil
      );
      if (result.status === 'success') {
        logger.info(
          `Baseline article created by ${org.name}`,
          { articleId: result.id },
          'ArticleTick'
        );
      }
    }

    const articlesCreated = result.status === 'success' ? 1 : 0;
    const errorCount = result.status === 'error' ? 1 : 0;
    const skipped = result.status === 'skipped';
    const duration = Date.now() - startTime;
    const success = errorCount === 0;

    logger.info(
      `Article tick completed in ${duration}ms`,
      { articlesCreated, errorCount, success, skipped },
      'ArticleTick'
    );

    recordCronExecution('article-tick', new Date(startTime), {
      success,
      articlesCreated,
      errorCount,
      skipped,
    });

    return NextResponse.json({
      success,
      skipped,
      ...(result.status === 'skipped' ? { reason: result.reason } : {}),
      articlesCreated,
      errorCount,
      duration,
      rateLimit: { currentCount, maxAllowed, remaining },
    });
  } finally {
    await DistributedLockService.releaseLock('article-tick-global', processId);
  }
});

/**
 * Generate an article about a specific event using ArticleGenerator.
 * Returns structured result for accurate metrics tracking.
 */
async function generateEventArticle(
  event: { questionId: string; text?: string },
  org: StaticOrganization,
  actorsList: StaticActor[],
  worldFactsContext: string,
  gameState: GameState,
  llmClient: FeedLLMClient,
  rateLimitWaitUntil: number
): Promise<ArticleGenerationResult> {
  // Create ArticleGenerator instance
  const articleGen = new ArticleGenerator(llmClient);

  // Use helper functions to map static data to expected interfaces
  const organization = mapStaticOrgToOrganization(org);
  const actors = mapStaticActorsToActors(actorsList);

  // Create standardized question object using factory helper
  const question = createQuestionForArticle(
    event.questionId,
    event.text || `Market activity for ${event.questionId}`
  );

  try {
    // Generate article using ArticleGenerator (handles character mapping internally)
    // Pass worldFactsContext for current game state awareness
    const article = await articleGen.generateArticleForQuestion(
      question,
      organization,
      'breaking', // Event articles are breaking news
      actors,
      [], // Recent events (empty - world context provides this info)
      worldFactsContext // World facts context for current game state
    );

    // Persist the article using shared persistence service (includes rate limit check)
    const result = await persistArticleFromGenerator(
      article,
      gameState,
      rateLimitWaitUntil
    );

    // Handle persistence failures - distinguish rate limiting from actual errors
    if (!result.success) {
      if (result.rateLimited) {
        return { status: 'skipped', reason: 'rate_limit_at_persist' };
      }
      // Actual persistence error (DB failure, validation, etc.)
      return {
        status: 'error',
        error: result.error || 'Unknown persistence error',
      };
    }

    // With discriminated union, articleId is guaranteed present when success is true
    return { status: 'success', id: result.articleId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'ArticleGenerator failed for event article',
      {
        eventId: event.questionId,
        orgId: org.id,
        error: errorMessage,
      },
      'ArticleTick'
    );
    return { status: 'error', error: errorMessage };
  }
}

/**
 * Generate a baseline article (not tied to a specific event) using ArticleGenerator.
 * Returns structured result for accurate metrics tracking.
 */
async function generateBaselineArticle(
  org: StaticOrganization,
  actorsList: StaticActor[],
  worldFactsContext: string,
  gameState: GameState,
  llmClient: FeedLLMClient,
  rateLimitWaitUntil: number
): Promise<ArticleGenerationResult> {
  // Pick a random actor to focus on
  const actorIndex = Math.floor(
    secureRandom() * Math.min(10, actorsList.length)
  );
  const actor = actorsList[actorIndex];

  const topic = actor
    ? `${actor.name} and recent developments`
    : 'AI industry trends and market movements';

  // Create ArticleGenerator instance
  const articleGen = new ArticleGenerator(llmClient);

  // Use helper functions to map static data to expected interfaces
  const organization = mapStaticOrgToOrganization(org);
  const actors = mapStaticActorsToActors(actorsList);

  // Create synthetic question for baseline article (topic-based)
  // Use snowflake ID to prevent collisions if multiple baselines generated simultaneously.
  // The "baseline-" prefix distinguishes synthetic IDs from real question IDs (which are
  // numeric snowflakes) to avoid conflicts in logging, analytics, and caching systems.
  const questionId = await generateSnowflakeId();
  const question = createQuestionForArticle(`baseline-${questionId}`, topic);

  try {
    // Generate article using ArticleGenerator (handles character mapping internally)
    // Pass worldFactsContext for current game state awareness
    const article = await articleGen.generateArticleForQuestion(
      question,
      organization,
      'commentary', // Baseline articles are commentary/analysis
      actors,
      [], // Recent events (empty - world context provides this info)
      worldFactsContext // World facts context for current game state
    );

    // Persist the article using shared persistence service (includes rate limit check)
    const result = await persistArticleFromGenerator(
      article,
      gameState,
      rateLimitWaitUntil
    );

    // Handle persistence failures - distinguish rate limiting from actual errors
    if (!result.success) {
      if (result.rateLimited) {
        return { status: 'skipped', reason: 'rate_limit_at_persist' };
      }
      // Actual persistence error (DB failure, validation, etc.)
      return {
        status: 'error',
        error: result.error || 'Unknown persistence error',
      };
    }

    // With discriminated union, articleId is guaranteed present when success is true
    return { status: 'success', id: result.articleId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      'ArticleGenerator failed for baseline article',
      {
        topic,
        orgId: org.id,
        error: errorMessage,
      },
      'ArticleTick'
    );
    return { status: 'error', error: errorMessage };
  }
}
