/**
 * Trending Tag Detail API
 *
 * @route GET /api/trending/[tag] - Get posts by tag
 * @access Public (optional authentication for RLS)
 *
 * @description
 * Returns posts with a specific tag. Supports pagination. Optional authentication
 * applies RLS for personalized results.
 *
 * @openapi
 * /api/trending/{tag}:
 *   get:
 *     tags:
 *       - Trending
 *     summary: Get posts by tag
 *     description: Returns posts with specific tag (optional auth for RLS)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tag
 *         required: true
 *         schema:
 *           type: string
 *         description: Tag name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Posts per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Posts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *       401:
 *         description: Unauthorized (optional)
 *
 * @example
 * ```typescript
 * const { posts } = await fetch('/api/trending/crypto?limit=20')
 *   .then(r => r.json());
 * ```
 */

import {
  addPrivateReadHeaders,
  addPublicReadHeaders,
  countReachablePostComments,
  countVisiblePostComments,
  publicRateLimit,
  withErrorHandling,
} from '@feed/api';
import { asPublic, asUser } from '@feed/db';
import { getPostsByTag, StaticDataRegistry } from '@feed/engine';
import { toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const TagPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const GET = withErrorHandling(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;

  const { tag } = await params;
  const url = new URL(request.url);
  const query = TagPostsQuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!query.success) {
    return NextResponse.json(
      {
        success: false,
        error:
          'limit must be an integer 1-100 and offset a non-negative integer',
      },
      { status: 400 }
    );
  }
  const { limit, offset } = query.data;

  if (!tag) {
    return NextResponse.json(
      {
        success: false,
        error: 'Tag parameter is required',
      },
      { status: 400 }
    );
  }

  const result = await getPostsByTag(tag, { limit, offset });

  if (!result.tag) {
    return NextResponse.json(
      {
        success: false,
        error: 'Tag not found',
        posts: [],
        total: 0,
      },
      { status: 404 }
    );
  }

  // Enrich posts with author information and engagement stats with RLS
  const enrichedPosts = await Promise.all(
    result.posts.map(async (post) => {
      // Get author info (could be User, Actor, or Organization)
      const actor = StaticDataRegistry.getActor(post.authorId);
      const org = StaticDataRegistry.getOrganization(post.authorId);

      // The card must promise only the comments the detail screen can
      // show for this viewer (#1994 rule): the raw row count also includes
      // soft-deleted comments and replies under a hidden parent.
      const reachableCommentCount = await countReachablePostComments(
        post.id,
        []
      );

      // Compute the viewer-adjusted count outside the per-post transaction
      // below: countVisiblePostComments queries the global client (the
      // viewer's blocks/mutes plus the reachable walk), while asUser holds
      // one pool connection for its transaction. A signed page with as many
      // posts as the pool has connections deadlocks otherwise — every
      // connection is held by a transaction waiting on a count query that
      // can never get one (test pool 5, prod 8/10, default limit 20).
      const visibleCommentCount =
        authUser && authUser.userId
          ? await countVisiblePostComments(
              post.id,
              authUser.userId,
              reachableCommentCount
            )
          : reachableCommentCount;

      const [user, likeCount, commentCount, shareCount, userLike, userShare] =
        authUser && authUser.userId
          ? await asUser(authUser, async (db) => {
              return await Promise.all([
                db.user.findUnique({
                  where: { id: post.authorId },
                  select: {
                    id: true,
                    username: true,
                    displayName: true,
                    profileImageUrl: true,
                    isActor: true,
                  },
                }),
                db.reaction.count({
                  where: { postId: post.id, type: 'like' },
                }),
                visibleCommentCount,
                db.share.count({
                  where: { postId: post.id },
                }),
                db.reaction.findFirst({
                  where: {
                    postId: post.id,
                    userId: authUser.userId,
                    type: 'like',
                  },
                  select: { id: true },
                }),
                db.share.findFirst({
                  where: { postId: post.id, userId: authUser.userId },
                  select: { id: true },
                }),
              ]);
            })
          : await asPublic(async (db) => {
              return await Promise.all([
                db.user.findUnique({
                  where: { id: post.authorId },
                  select: {
                    id: true,
                    username: true,
                    displayName: true,
                    profileImageUrl: true,
                    isActor: true,
                  },
                }),
                db.reaction.count({
                  where: { postId: post.id, type: 'like' },
                }),
                visibleCommentCount,
                db.share.count({
                  where: { postId: post.id },
                }),
                null, // No user context for public requests
                null, // No user context for public requests
              ]);
            });

      // Determine author info
      const authorName =
        user?.displayName ||
        user?.username ||
        actor?.name ||
        org?.name ||
        'Unknown';
      const authorUsername = user?.username || null;
      const authorProfileImageUrl =
        user?.profileImageUrl ||
        actor?.profileImageUrl ||
        org?.imageUrl ||
        null;

      return {
        id: post.id,
        content: post.content,
        authorId: post.authorId,
        authorName,
        authorUsername,
        authorProfileImageUrl,
        timestamp: toISO(post.timestamp),
        likeCount,
        commentCount,
        shareCount,
        isLiked: !!userLike,
        isShared: !!userShare,
      };
    })
  );

  const res = NextResponse.json({
    success: true,
    tag: {
      name: result.tag.name,
      displayName: result.tag.displayName,
      category: result.tag.category,
    },
    posts: enrichedPosts,
    total: result.total,
  });
  // Signed counts are viewer-dependent (blocks/mutes), so they must never
  // sit in a shared cache; anonymous counts are the same for everyone.
  if (authUser) {
    if (rateLimitInfo) addPrivateReadHeaders(res, rateLimitInfo);
    else res.headers.set('Cache-Control', 'private, no-store');
  } else if (rateLimitInfo) {
    addPublicReadHeaders(res, rateLimitInfo);
  }
  return res;
});
