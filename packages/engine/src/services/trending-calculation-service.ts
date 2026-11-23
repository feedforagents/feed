/**
 * Trending Calculation Service
 *
 * Calculates trending tags using time-weighted algorithm
 * Similar to X/Twitter trending topics
 */

import { logger } from '@feed/shared';
import {
  getCurrentTrendingTags,
  getLatestTrendingCalculation,
  getRelatedTags,
  getTagStatistics,
  storeTrendingTags,
} from './tag-service';

const CALCULATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours (6x per day)
const TRENDING_WINDOW_DAYS = 7; // Look at last 7 days

/**
 * Check if we should recalculate trending tags
 */
export async function shouldRecalculateTrending(): Promise<boolean> {
  const lastCalculation = await getLatestTrendingCalculation();

  if (!lastCalculation) {
    return true; // Never calculated before
  }

  const timeSinceLastCalc = Date.now() - lastCalculation.calculatedAt.getTime();
  return timeSinceLastCalc >= CALCULATION_INTERVAL_MS;
}

/**
 * Calculate trending score for a tag
 *
 * Algorithm:
 * - Time decay: More recent posts weighted higher
 * - Volume boost: More posts = higher score
 * - Velocity boost: Rapid increase in last 24h = higher score
 */
function calculateTrendingScore(
  postCount: number,
  recentPostCount: number,
  oldestPostDate: Date,
  newestPostDate: Date,
  windowEnd: Date
): number {
  // Base score from total post count
  let score = postCount;

  // Time decay factor. Age proxy: half the age of the oldest post in the
  // window (not a true average). exp(-t/3) has a 3-day e-folding time.
  const ageProxyMs = (windowEnd.getTime() - oldestPostDate.getTime()) / 2;
  const ageProxyDays = ageProxyMs / (1000 * 60 * 60 * 24);
  const decayFactor = Math.exp(-ageProxyDays / 3);
  score *= decayFactor;

  // Velocity boost (recent activity)
  if (postCount > 0) {
    const recentRatio = recentPostCount / postCount;
    const velocityBoost = 1 + recentRatio * 2; // Up to 3x multiplier for very recent activity
    score *= velocityBoost;
  }

  // Recency boost (how fresh is the newest post)
  const hoursSinceNewest =
    (windowEnd.getTime() - newestPostDate.getTime()) / (1000 * 60 * 60);
  if (hoursSinceNewest < 1) {
    score *= 1.5; // 50% boost for posts in last hour
  } else if (hoursSinceNewest < 6) {
    score *= 1.2; // 20% boost for posts in last 6 hours
  }

  return score;
}

/**
 * Calculate trending tags
 */
export async function calculateTrendingTags(): Promise<void> {
  const startTime = Date.now();
  logger.info(
    'Starting trending tags calculation',
    undefined,
    'TrendingCalculationService'
  );

  // Define time window (last 7 days)
  const windowEnd = new Date();
  const windowStart = new Date(
    windowEnd.getTime() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  // Get tag statistics
  const tagStats = await getTagStatistics(windowStart, windowEnd);

  logger.debug(
    'Retrieved tag statistics',
    {
      tagCount: tagStats.length,
    },
    'TrendingCalculationService'
  );

  // Calculate scores for each tag
  const scoredTags = tagStats.map((tag) => ({
    tagId: tag.tagId,
    tagName: tag.tagName,
    tagDisplayName: tag.tagDisplayName,
    tagCategory: tag.tagCategory,
    postCount: tag.postCount,
    score: calculateTrendingScore(
      tag.postCount,
      tag.recentPostCount,
      tag.oldestPostDate,
      tag.newestPostDate,
      windowEnd
    ),
  }));

  // Sort by score (deterministic tiebreak on tag name) and assign ranks
  scoredTags.sort(
    (a, b) => b.score - a.score || a.tagName.localeCompare(b.tagName)
  );

  // Take top 20 trending tags
  const topTrending = scoredTags.slice(0, 20);

  // Get related tags for context (async)
  const trendingWithContext = await Promise.all(
    topTrending.map(async (tag, index) => {
      // "Trending with" context for the top 10 tags
      let relatedContext: string | undefined;
      if (index < 10) {
        const relatedTags = await getRelatedTags(tag.tagId, 1);
        if (relatedTags.length > 0) {
          relatedContext = `Trending with ${relatedTags[0]}`;
        }
      }

      return {
        tagId: tag.tagId,
        score: tag.score,
        postCount: tag.postCount,
        rank: index + 1,
        relatedContext,
      };
    })
  );

  // Store trending tags
  await storeTrendingTags(trendingWithContext, windowStart, windowEnd);

  const duration = Date.now() - startTime;
  logger.info(
    'Trending tags calculation completed',
    {
      duration: `${duration}ms`,
      tagsCalculated: topTrending.length,
      topTag: topTrending[0]?.tagDisplayName,
    },
    'TrendingCalculationService'
  );
}

/**
 * Calculate trending tags if needed (called from cron)
 */
export async function calculateTrendingIfNeeded(): Promise<boolean> {
  const shouldCalculate = await shouldRecalculateTrending();

  if (!shouldCalculate) {
    logger.debug(
      'Trending calculation not needed yet',
      undefined,
      'TrendingCalculationService'
    );
    return false;
  }

  await calculateTrendingTags();
  return true;
}

/**
 * Get trending topics context for agent prompts
 *
 * Returns a formatted string of current trending topics that can be
 * injected into agent prompts to make posts more relevant and timely.
 */
export async function getTrendingPromptContext(): Promise<string> {
  // Only the latest calculation; rows whose tag no longer exists are omitted
  // rather than shown with a fabricated label.
  const topTrending = (await getCurrentTrendingTags(10)).filter(
    (trend) => trend.tag
  );

  if (topTrending.length === 0) {
    return '';
  }

  const trendingLines = topTrending.map((trend) => {
    const name = trend.tag.displayName || trend.tag.name;
    const context = trend.relatedContext ? ` (${trend.relatedContext})` : '';
    const postInfo =
      trend.postCount > 1 ? ` - ${trend.postCount} posts` : ' - 1 post';
    return `${trend.rank}. ${name}${context}${postInfo}`;
  });

  return `
=== TRENDING TOPICS (What people are talking about) ===
${trendingLines.join('\n')}

Consider referencing these trends in your post if relevant to your perspective.
=======================================================
`;
}
