/**
 * Organization Tick Cron Job API
 *
 * @route POST /api/cron/organization-tick - Execute organization autonomous tick
 * @access Cron (CRON_SECRET required)
 *
 * @description
 * Dedicated cron job for ALL organization types to generate SHORT POSTS
 * (social media style updates). Each org type has distinct posting behavior:
 *
 * - media: News outlets (AINBC, AIxios, BloombAIrg) - breaking news, commentary
 * - company: Tech companies (NvidAI, TeslAI, OpenAGI) - product updates, PR
 * - vc: Venture capital (SequoAI, Founders FAInd) - investment theses, market views
 * - government: Agencies (CIAI, Dept of War) - policy statements, official announcements
 * - organization: Foundations (Ethereum FoundAItion) - community updates, initiatives
 * - financial: Institutions (Block Rock) - market analysis, economic commentary
 *
 * Article generation is handled separately by /api/cron/article-tick.
 * This separation provides:
 * 1. Organizations post frequently (social media presence)
 * 2. Articles are rate-limited and event-driven
 * 3. Clear separation of concerns
 *
 * Architecture:
 * - game-tick: Game engine (markets, events, world state)
 * - npc-tick: Actor NPCs (Sam AIltman, AIlon Musk, etc.)
 * - organization-tick: ALL org POSTS (type-specific content)
 * - article-tick: ALL article generation (centralized, rate-limited)
 */

import {
  DistributedLockService,
  getCacheOrFetch,
  recordCronExecution,
  relayCronToStaging,
  verifyCronAuth,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  db,
  eq,
  games,
  generateSnowflakeId,
  gte,
  inArray,
  posts,
} from '@feed/db';
import {
  FeedLLMClient,
  getActiveEventsForPosting,
  StaticDataRegistry,
  secureRandom,
  worldFactsService,
} from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureEngineServices } from '@/lib/engine/ensure-engine-services';
import {
  type OrgType,
  selectWeightedOrganizations,
} from './select-organizations';

/**
 * Read a positive integer env var. Unset/empty uses the default; any other
 * non-positive-integer value (0, negative, fractional, NaN) is a
 * configuration error rather than being silently replaced.
 */
function positiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Maximum consecutive errors before aborting the tick (circuit breaker).
 * Prevents cascading failures if there's a systemic issue.
 * Mirrors the same pattern used in npc-tick.
 */
const MAX_CONSECUTIVE_ERRORS = positiveIntEnv('ORG_TICK_MAX_ERRORS', 5);

/**
 * Zod schema for validating LLM response formats.
 * Handles both direct { post: string } and wrapped { response: { post: string } } formats.
 */
const LLMPostResponseSchema = z.union([
  z.object({ post: z.string().min(1) }),
  z.object({ response: z.object({ post: z.string().min(1) }) }),
]);

/**
 * Extract post content from validated LLM response.
 * Returns the post string or null if extraction fails.
 */
function extractPostFromResponse(
  response: z.infer<typeof LLMPostResponseSchema>
): string {
  if ('response' in response && response.response?.post) {
    return response.response.post;
  }
  if ('post' in response) {
    return response.post;
  }
  // This shouldn't happen after Zod validation, but TypeScript needs it
  throw new Error('Unexpected response structure after validation');
}

/** Game state shape for cache */
interface GameState {
  id: string;
  isRunning: boolean;
  isContinuous: boolean;
  currentDay: number | null;
}

export const dynamic = 'force-dynamic';

/**
 * Base number of organizations to process per tick.
 * Actual count varies by ±1 for organic pacing (2-4 orgs per tick).
 * Configurable via ORG_TICK_BATCH_SIZE environment variable.
 * Each org generates 1 short post per tick.
 *
 * With 60 orgs and weighted stratified selection, ~3 per tick ensures:
 * - Good type diversity (typically 2-3 different org types per tick)
 * - Each org posts roughly every 20 ticks
 * - Variable batch size feels more natural than fixed counts
 */
const BASE_ORGS_PER_TICK = positiveIntEnv('ORG_TICK_BATCH_SIZE', 3);

/**
 * Calculate organizations per tick with random variance.
 * Returns BASE ± 1 (range: 2-4 with default base of 3).
 * Called per-request to ensure fresh randomness each tick.
 */
function getOrgsPerTick(): number {
  const variance = Math.floor(secureRandom() * 3) - 1; // -1, 0, or +1
  return Math.max(1, BASE_ORGS_PER_TICK + variance);
}

/**
 * Minimum time in minutes between posts from the same organization.
 * Prevents back-to-back posting that looks robotic.
 * Default: 45 minutes (reasonable for social media cadence)
 *
 * @env ORG_MIN_MINUTES_BETWEEN_POSTS
 */
const ORG_MIN_MINUTES_BETWEEN_POSTS = positiveIntEnv(
  'ORG_MIN_MINUTES_BETWEEN_POSTS',
  45
);

/**
 * GET /api/cron/organization-tick
 * Alias for POST endpoint to support GET requests from cron services.
 */
export const GET = withErrorHandling(async function GET(req: NextRequest) {
  return POST(req);
});

/**
 * POST /api/cron/organization-tick
 *
 * Executes organization autonomous tick for media orgs.
 */
export const POST = withErrorHandling(async function POST(_req: NextRequest) {
  // Verify cron authorization
  if (!verifyCronAuth(_req, { jobName: 'OrganizationTick' })) {
    logger.warn(
      'Unauthorized organization-tick request attempt',
      undefined,
      'OrganizationTick'
    );
    return NextResponse.json(
      { error: 'Unauthorized cron request' },
      { status: 401 }
    );
  }

  // Initialize engine services only after the caller is authorized.
  ensureEngineServices();

  const startTime = Date.now();
  const processId = `org-tick-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  logger.info('Organization tick started', { processId }, 'OrganizationTick');

  // Relay to staging if configured (fan-out)
  const relayResult = await relayCronToStaging(_req, 'organization-tick');
  if (relayResult.forwarded) {
    logger.info(
      'Cron execution relayed to staging (fan-out: continuing local execution)',
      { status: relayResult.status, error: relayResult.error },
      'OrganizationTick'
    );
  }

  // Acquire global lock to prevent overlapping cron invocations
  // 300s lock duration prevents overlap when ticks take longer than cron interval
  const globalLockAcquired = await DistributedLockService.acquireLock({
    lockId: 'organization-tick-global',
    durationMs: 300 * 1000, // 300 seconds (5 minutes)
    operation: 'organization-tick-global',
    processId,
  });
  if (!globalLockAcquired) {
    logger.info(
      'Organization tick skipped - previous tick still running',
      { processId },
      'OrganizationTick'
    );
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'Previous tick still running',
      processed: 0,
    });
  }

  // Wrap remaining logic in try-finally to ensure global lock release
  try {
    // Check GAME_START environment variable
    const gameStartEnv = process.env.GAME_START?.toLowerCase();
    if (gameStartEnv === 'false' || gameStartEnv === '0') {
      logger.info(
        'Game disabled via GAME_START env var - skipping organization tick',
        { GAME_START: process.env.GAME_START },
        'OrganizationTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game disabled via GAME_START environment variable',
        processed: 0,
      });
    }

    // Check Game status from database (cached for 60s to reduce DB load)
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
      { namespace: 'organization-tick', ttl: 60 }
    );

    if (!gameState) {
      logger.info(
        'Organization tick skipped (No continuous game found)',
        {},
        'OrganizationTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No continuous game found',
        duration: Date.now() - startTime,
        processed: 0,
      });
    }

    if (!gameState.isRunning) {
      logger.info(
        'Organization tick paused (Game is not running)',
        { gameId: gameState.id },
        'OrganizationTick'
      );
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Game is paused',
        gameId: gameState.id,
        duration: Date.now() - startTime,
        processed: 0,
      });
    }

    // Get all organizations that can post (all types: media, company, vc, government, etc.)
    // Media orgs act as news outlets, companies/VCs post corporate updates and influence narratives
    const allOrgs = StaticDataRegistry.getAllOrganizations().filter(
      (org) => org.canBeInvolved !== false
    );

    if (allOrgs.length === 0) {
      logger.warn('No organizations found in registry', {}, 'OrganizationTick');
      return NextResponse.json({
        success: true,
        processed: 0,
        duration: Date.now() - startTime,
        warning: 'No organizations found in registry',
      });
    }

    // Query recent posts to enforce cooldown (prevents back-to-back robotic posting)
    const cooldownThreshold = new Date(
      Date.now() - ORG_MIN_MINUTES_BETWEEN_POSTS * 60 * 1000
    );
    const orgIds = allOrgs.map((o) => o.id);

    // Find every org that has a post inside the cooldown window (including
    // scheduled future timestamps). This is evaluated per org, so a prolific
    // org cannot crowd another org's recent post out of a global top-N.
    const orgsInCooldown = await db
      .selectDistinct({ authorId: posts.authorId })
      .from(posts)
      .where(
        and(
          inArray(posts.authorId, orgIds),
          gte(posts.timestamp, cooldownThreshold)
        )
      );
    const cooldownOrgIds = new Set(orgsInCooldown.map((row) => row.authorId));

    // Filter out orgs that are still in cooldown
    const eligibleOrgs = allOrgs.filter((org) => !cooldownOrgIds.has(org.id));

    // Log cooldown filtering stats
    const inCooldown = allOrgs.length - eligibleOrgs.length;
    if (inCooldown > 0) {
      logger.debug(
        'Organizations in cooldown',
        {
          total: allOrgs.length,
          eligible: eligibleOrgs.length,
          inCooldown,
          cooldownMinutes: ORG_MIN_MINUTES_BETWEEN_POSTS,
        },
        'OrganizationTick'
      );
    }

    // If all orgs are in cooldown, skip this tick
    if (eligibleOrgs.length === 0) {
      logger.info(
        'All organizations in cooldown, skipping tick',
        { cooldownMinutes: ORG_MIN_MINUTES_BETWEEN_POSTS },
        'OrganizationTick'
      );
      return NextResponse.json({
        success: true,
        processed: 0,
        duration: Date.now() - startTime,
        skipped: true,
        reason: 'All organizations in cooldown',
      });
    }

    // Get active events for context
    const activeEventsData = await getActiveEventsForPosting();

    // Get world facts for context
    const worldFactsContext = await worldFactsService.generatePromptContext();

    // Select organizations using weighted stratified sampling (from eligible orgs only)
    // This ensures a balanced mix of org types that mirrors real-world posting patterns
    const orgsPerTick = getOrgsPerTick(); // Fresh randomness per request
    const orgsThisTick = selectWeightedOrganizations(eligibleOrgs, orgsPerTick);

    logger.info(
      `Organization tick processing ${orgsThisTick.length} orgs`,
      {
        totalOrgs: allOrgs.length,
        selectedOrgs: orgsThisTick.map((o) => o.name),
      },
      'OrganizationTick'
    );

    const results: Array<{
      orgId: string;
      name: string;
      status: string;
      error?: string;
      duration: number;
    }> = [];
    let postsCreated = 0;
    let errors = 0;
    let consecutiveOrgErrors = 0;
    let abortedDueToCircuitBreaker = false;

    // Create LLM client for organization posts
    const llmClient = FeedLLMClient.forGameTick();

    for (const org of orgsThisTick) {
      // Circuit breaker: abort if too many consecutive errors
      if (consecutiveOrgErrors >= MAX_CONSECUTIVE_ERRORS) {
        abortedDueToCircuitBreaker = true;
        logger.error(
          `Circuit breaker triggered after ${consecutiveOrgErrors} consecutive errors`,
          { processId, orgsRemaining: orgsThisTick.length - results.length },
          'OrganizationTick'
        );
        break;
      }

      const orgStartTime = Date.now();

      try {
        // Generate content based on active events and world context
        const eventContext =
          activeEventsData.activeEvents.length > 0
            ? `Recent events: ${activeEventsData.activeEvents
                .slice(0, 3)
                .map((e) => e.questionId)
                .join(', ')}`
            : '';

        // Build prompt for organization POST (not article - articles are handled by article-tick)
        const prompt = buildOrgPostPrompt(org, worldFactsContext, eventContext);

        // Generate content using LLM
        const rawResponse = await llmClient.generateJSON<
          { post: string } | { response: { post: string } }
        >(
          prompt,
          {
            properties: { post: { type: 'string' } },
            required: ['post'],
          },
          {
            maxTokens: 280,
            temperature: 0.8,
          }
        );

        // Validate LLM response with Zod schema
        const parseResult = LLMPostResponseSchema.safeParse(rawResponse);
        if (!parseResult.success) {
          logger.warn(
            'LLM response failed schema validation',
            {
              orgId: org.id,
              orgName: org.name,
              errors: parseResult.error.issues,
              rawResponse: JSON.stringify(rawResponse).slice(0, 200),
            },
            'OrganizationTick'
          );
          throw new Error(
            `Invalid LLM response format: ${parseResult.error.issues.map((e: z.ZodIssue) => e.message).join(', ')}`
          );
        }

        // Extract post content from validated response
        const rawPost = extractPostFromResponse(parseResult.data);

        if (rawPost.trim().length === 0) {
          throw new Error('Empty post content from LLM');
        }

        // Parse response and create post
        const content = rawPost.trim();
        const now = new Date();

        // Spread timestamp randomly within the NEXT 5-minute window (until next tick)
        // Posts become visible gradually as their timestamp passes
        // This prevents all posts from appearing at the exact same time
        // making the feed feel more organic rather than batch-generated
        const TICK_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
        const randomOffset = Math.floor(secureRandom() * TICK_WINDOW_MS);
        const postTimestamp = new Date(now.getTime() + randomOffset);

        // Create the post in database (always type: 'post', never 'article')
        const postId = await generateSnowflakeId();
        await db.insert(posts).values({
          id: postId,
          content,
          authorId: org.id,
          gameId: gameState.id,
          dayNumber: gameState.currentDay ?? 1,
          timestamp: postTimestamp, // Staggered for organic feel
          createdAt: now, // Actual creation time
          type: 'post',
        });

        postsCreated++;
        consecutiveOrgErrors = 0; // Reset on success
        results.push({
          orgId: org.id,
          name: org.name,
          status: 'success',
          duration: Date.now() - orgStartTime,
        });

        logger.info(
          `Organization ${org.name} created post`,
          {
            orgId: org.id,
            postId,
            duration: Date.now() - orgStartTime,
          },
          'OrganizationTick'
        );
      } catch (error) {
        errors++;
        consecutiveOrgErrors++;
        logger.error(
          `Error processing organization ${org.name}`,
          {
            orgId: org.id,
            error: error instanceof Error ? error.message : String(error),
            consecutiveOrgErrors,
          },
          'OrganizationTick'
        );

        results.push({
          orgId: org.id,
          name: org.name,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - orgStartTime,
        });
      }
    }

    const duration = Date.now() - startTime;

    logger.info(
      `Organization tick completed in ${duration}ms`,
      {
        orgsProcessed: orgsThisTick.length,
        postsCreated,
        errors,
      },
      'OrganizationTick'
    );

    // Record metrics
    // Consider success if there were no errors OR if some work succeeded (partial success)
    recordCronExecution('organization-tick', new Date(startTime), {
      success: errors === 0 || postsCreated > 0,
      processed: orgsThisTick.length,
      postsCreated,
      errorCount: errors,
      abortedDueToCircuitBreaker,
    });

    return NextResponse.json({
      success: errors === 0 && !abortedDueToCircuitBreaker,
      processed: orgsThisTick.length,
      postsCreated,
      duration,
      errors,
      abortedDueToCircuitBreaker,
      results,
    });
  } finally {
    // Always release global lock
    await DistributedLockService.releaseLock(
      'organization-tick-global',
      processId
    );
  }
});

/**
 * Build a prompt for organization POST generation (not articles).
 * Articles are handled by the separate article-tick cron job.
 *
 * Different organization types have different posting behaviors:
 * - media: Breaking news, commentary, defending editorial positions
 * - company: Product announcements, PR statements, corporate messaging
 * - vc: Investment theses, portfolio wins, market commentary
 * - government: Policy statements, official announcements, spin
 * - organization: Foundation updates, initiatives, community building
 * - financial: Market analysis, economic commentary, institutional views
 */
function buildOrgPostPrompt(
  org: { id: string; name: string; description?: string; type?: string },
  worldFacts: string,
  eventContext: string
): string {
  const orgStyle = getOrgStyle(org.id);
  const orgType = (org.type || 'media') as OrgType;

  // Base context for all org types
  const baseContext = `You are posting as ${org.name}.
${org.description ? `About: ${org.description}` : ''}

${worldFacts}

${eventContext}

${orgStyle}`;

  // Type-specific instructions
  const typeInstructions: Record<OrgType, string> = {
    media: `Write a short news post (1-2 sentences, under 280 characters) as a news outlet.

The post should:
- Be breaking news, an update, or commentary on current events
- Use your publication's voice and editorial stance
- Defend your reporting or take shots at competitors when appropriate
- Include relevant hashtags if appropriate
- Be attention-grabbing but factual
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,

    company: `Write a short corporate post (1-2 sentences, under 280 characters) as a company.

The post should:
- Announce product updates, milestones, or corporate news
- Shape the narrative around your company favorably
- Respond to industry events that affect your business
- Project confidence and forward momentum
- Use corporate voice but stay human and engaging
- Subtly position against competitors when relevant
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,

    vc: `Write a short investment/thought leadership post (1-2 sentences, under 280 characters) as a VC firm.

The post should:
- Share investment theses or market observations
- Celebrate portfolio company wins
- Comment on industry trends and where the smart money is going
- Project insider knowledge and pattern recognition
- Influence founders and LPs subtly
- Take contrarian or consensus positions strategically
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,

    government: `Write a short official post (1-2 sentences, under 280 characters) as a government entity.

The post should:
- Announce policy positions or official statements
- Respond to news that affects your jurisdiction
- Project authority and legitimacy
- Spin events favorably for your agenda
- Use bureaucratic-but-accessible language
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,

    organization: `Write a short organizational post (1-2 sentences, under 280 characters) as a foundation/org.

The post should:
- Share updates on initiatives or community activities
- Respond to events relevant to your mission
- Build community and rally supporters
- Project your organization's values and vision
- Balance professionalism with mission-driven passion
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,

    financial: `Write a short market post (1-2 sentences, under 280 characters) as a financial institution.

The post should:
- Share market analysis or economic observations
- Comment on major financial events or trends
- Project expertise and institutional authority
- Influence market sentiment subtly
- Balance insight with appropriate disclaimers
- Reference specific parody names (AIlon Musk, Sam AIltman, etc.) when relevant`,
  };

  return `${baseContext}

${typeInstructions[orgType] || typeInstructions.media}`;
}

/**
 * Get the editorial style for an organization.
 * Uses the postStyle from StaticDataRegistry if available,
 * otherwise falls back to a default professional style.
 */
function getOrgStyle(orgId: string): string {
  const org = StaticDataRegistry.getOrganization(orgId);
  if (org?.postStyle) {
    return org.postStyle;
  }

  return 'Professional news reporting style.';
}
