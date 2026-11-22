/**
 * Trending Tags Widget API
 *
 * @route GET /api/feed/widgets/trending - Get trending tags
 * @access Public
 *
 * @description
 * Returns current trending tags with post counts, summaries, and recent post
 * samples. Uses cached trending data from tag storage service. Includes AI-generated
 * summaries for each trending tag. Groups related tags together using LLM analysis.
 *
 * @openapi
 * /api/feed/widgets/trending:
 *   get:
 *     tags:
 *       - Feed
 *     summary: Get trending tags (grouped)
 *     description: Returns current trending tags with summaries and post counts, intelligently grouped
 *     responses:
 *       200:
 *         description: Trending tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 trending:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       tags:
 *                         type: array
 *                         items:
 *                           type: string
 *                       tagSlugs:
 *                         type: array
 *                         items:
 *                           type: string
 *                       tagIds:
 *                         type: array
 *                         items:
 *                           type: string
 *                       category:
 *                         type: string
 *                       totalPostCount:
 *                         type: integer
 *                       summary:
 *                         type: string
 *                       rank:
 *                         type: integer
 *                 message:
 *                   type: string
 *                   nullable: true
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/feed/widgets/trending');
 * const { trending } = await response.json();
 * // trending[0] might have tags: ["OpenAGI", "Sam Altman"]
 * ```
 *
 * @see {@link /lib/services/tag-service} Tag service
 * @see {@link /lib/services/trending-summary-service} Trending summary service
 * @see {@link /lib/services/trending-grouping-service} Trending grouping service
 */

import { withErrorHandling } from '@feed/api';
import {
  and,
  asPublic,
  desc,
  eq,
  isNull,
  lte,
  posts,
  postTags,
} from '@feed/db';
import {
  generateTrendingSummary,
  getCurrentTrendingTags,
  getLatestTrendingCalculation,
  groupTrendingTags,
  type TrendingTag,
} from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Server-side cache with longer TTL
type TrendingResponse = Awaited<ReturnType<typeof groupTrendingTags>>;
interface CachedTrendingData {
  batch: string;
  data: TrendingResponse;
  timestamp: number;
}

let trendingCache: CachedTrendingData | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Request deduplication: prevent concurrent requests from all running expensive LLM calls
let ongoingRequest: {
  batch: string;
  promise: Promise<TrendingResponse>;
} | null = null;

export const GET = withErrorHandling(async (_request: NextRequest) => {
  const startTime = Date.now();

  const calculation = await getLatestTrendingCalculation();
  if (!calculation?.hasTags) {
    return NextResponse.json({
      success: true,
      trending: [],
      message: 'No trending data yet - check back after first game tick',
    });
  }
  const batch = calculation.batch;

  if (
    trendingCache?.batch === batch &&
    Date.now() - trendingCache.timestamp < CACHE_TTL_MS
  ) {
    logger.debug(
      'Returning cached trending data',
      {
        age: Date.now() - trendingCache.timestamp,
        durationMs: Date.now() - startTime,
      },
      'GET /api/feed/widgets/trending'
    );

    return NextResponse.json({
      success: true,
      trending: trendingCache.data,
    });
  }

  // Request deduplication: if another request is already processing, wait for it
  if (ongoingRequest?.batch === batch) {
    logger.debug(
      'Waiting for ongoing trending request to complete',
      undefined,
      'GET /api/feed/widgets/trending'
    );
    const result = await ongoingRequest.promise;
    return NextResponse.json({
      success: true,
      trending: result,
    });
  }

  // Create the processing promise
  const processingPromise = (async () => {
    // Get trending tags from cache (get more tags for better grouping)
    const trending = await getCurrentTrendingTags(10, calculation);

    if (trending.length === 0) {
      logger.info(
        'No trending tags available',
        undefined,
        'GET /api/feed/widgets/trending'
      );
      return [];
    }

    // The result is cached globally and served to every viewer, so it is
    // always built from public, visible (non-deleted, published) posts.
    const now = new Date();
    const trendingItems: TrendingTag[] = await Promise.all(
      trending.map(async (item) => {
        const recentPosts = await asPublic(async (db) => {
          return await db
            .select({
              postId: postTags.postId,
              postContent: posts.content,
            })
            .from(postTags)
            .innerJoin(posts, eq(postTags.postId, posts.id))
            .where(
              and(
                eq(postTags.tagId, item.tag.id),
                isNull(posts.deletedAt),
                lte(posts.timestamp, now)
              )
            )
            .orderBy(desc(postTags.createdAt))
            .limit(3);
        });

        const postContents = recentPosts.map((pt) => pt.postContent);

        const summary = await generateTrendingSummary(
          item.tag.displayName,
          item.tag.category,
          postContents
        );

        return {
          id: item.tag.id, // Use actual tag ID, not trending record ID
          tag: item.tag.displayName,
          tagSlug: item.tag.name,
          category: item.tag.category,
          postCount: item.postCount,
          summary,
          rank: item.rank,
        };
      })
    );

    // Group related tags using LLM analysis
    const groupedTrending = await groupTrendingTags(trendingItems);

    // Return top 5 groups
    const topGroups = groupedTrending.slice(0, 5);

    const duration = Date.now() - startTime;
    logger.info(
      'Generated trending data',
      {
        groups: topGroups.length,
        durationMs: duration,
      },
      'GET /api/feed/widgets/trending'
    );

    return topGroups;
  })();

  // Always release the shared promise (success, empty or failure) so an
  // expired cache or a rejected attempt cannot poison later requests.
  const sharedRequest: Promise<TrendingResponse> = processingPromise
    .then((data) => {
      if (ongoingRequest?.promise === sharedRequest) {
        trendingCache = { batch, data, timestamp: Date.now() };
      }
      return data;
    })
    .finally(() => {
      if (ongoingRequest?.promise === sharedRequest) ongoingRequest = null;
    });
  ongoingRequest = { batch, promise: sharedRequest };

  const result = await sharedRequest;

  if (result.length === 0) {
    return NextResponse.json({
      success: true,
      trending: [],
      message: 'No trending data yet - check back after first game tick',
    });
  }

  return NextResponse.json({
    success: true,
    trending: result,
  });
});
