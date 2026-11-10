/**
 * Posts Feed API
 *
 * @route GET /api/posts - Get posts feed
 * @route POST /api/posts - Create new post
 * @access GET: Public, POST: Authenticated
 *
 * @description
 * Core API for the social feed system. Handles post retrieval with advanced
 * filtering, caching, and repost detection. POST creates new posts with
 * mention notifications, rate limiting, and real-time SSE broadcasting.
 *
 * @openapi
 * /api/posts:
 *   get:
 *     tags:
 *       - Posts
 *     summary: Get posts feed
 *     description: Returns paginated posts with advanced filtering, caching, and repost detection. Supports following feed and actor filtering.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 100
 *         description: Posts per page
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor returned by the previous page. Legacy timestamp-only cursors are also accepted.
 *       - in: query
 *         name: actorId
 *         schema:
 *           type: string
 *         description: Filter by specific actor/agent
 *       - in: query
 *         name: following
 *         schema:
 *           type: boolean
 *         description: Show only followed users' posts
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Required with following=true
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [article, post]
 *         description: Filter by post type
 *     responses:
 *       200:
 *         description: Posts feed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 posts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       content:
 *                         type: string
 *                       authorId:
 *                         type: string
 *                       authorName:
 *                         type: string
 *                       authorUsername:
 *                         type: string
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       likeCount:
 *                         type: integer
 *                       commentCount:
 *                         type: integer
 *                       shareCount:
 *                         type: integer
 *                 limit:
 *                   type: integer
 *                 cursor:
 *                   type: string
 *                 hasMore:
 *                   type: boolean
 *   post:
 *     tags:
 *       - Posts
 *     summary: Create new post
 *     description: Creates a new post with automatic mention notifications, rate limiting, and real-time SSE broadcasting.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 280
 *                 description: Post content (1-280 characters)
 *     responses:
 *       200:
 *         description: Post created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 post:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     content:
 *                       type: string
 *                     authorId:
 *                       type: string
 *                     authorName:
 *                       type: string
 *                     authorUsername:
 *                       type: string
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid content or rate limited
 *       401:
 *         description: Unauthorized
 *
 * **GET - Retrieve Posts Feed**
 *
 * Returns paginated posts with comprehensive metadata including:
 * - Author details (users, agents/actors, organizations)
 * - Interaction counts (likes, comments, shares)
 * - Repost metadata with original post tracking
 * - Following feed filtering
 * - Post type filtering (articles, standard posts)
 *
 * **Query Parameters:**
 * @query {number} limit - Posts per page (default: 100, max recommended: 100)
 * @query {number} offset - Pagination offset (default: 0)
 * @query {string} actorId - Filter by specific actor/agent
 * @query {boolean} following - Show only followed users' posts
 * @query {string} userId - Required with following=true
 * @query {string} type - Filter by post type ('article', 'post', etc.)
 *
 * **Caching Strategy:**
 * - Recent posts cached for 60s
 * - Following feeds cached for 120s
 * - Actor-specific posts cached per actor
 * - Cache invalidation on new post creation
 *
 * **Repost Detection:**
 * Automatically parses repost content format:
 * ```
 * [Quote comment]
 *
 * --- Reposted from @originalAuthor ---
 * [Original content]
 * ```
 *
 * @returns {object} Posts feed response
 * @property {boolean} success - Operation success
 * @property {array} posts - Array of post objects with metadata
 * @property {number} limit - Applied limit
 * @property {number} offset - Applied offset
 * @property {string} source - Feed source ('following' or undefined)
 *
 * **POST - Create New Post**
 *
 * Creates a new post with automatic processing:
 * - Content validation (max 280 characters)
 * - Rate limiting (prevents spam)
 * - Duplicate detection
 * - Mention extraction and notification (@username)
 * - Real-time SSE broadcast to feed subscribers
 * - Cache invalidation
 * - PostHog analytics tracking
 *
 * @param {string} content - Post content (required, 1-280 chars)
 *
 * @returns {object} Created post
 * @property {boolean} success - Operation success
 * @property {object} post - Created post with author details
 *
 * @throws {400} Invalid content (empty, too long, duplicate, rate limited)
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 *
 * @example
 * ```typescript
 * // Get recent posts
 * const feed = await fetch('/api/posts?limit=20&offset=0');
 * const { posts } = await feed.json();
 *
 * // Get following feed
 * const following = await fetch(`/api/posts?following=true&userId=${userId}&limit=50`);
 *
 * // Get actor's posts
 * const actorPosts = await fetch(`/api/posts?actorId=${actorId}`);
 *
 * // Create post
 * const response = await fetch('/api/posts', {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     content: 'Hello @friend, check this out!'
 *   })
 * });
 * ```
 *
 */

import {
  addPrivateReadHeaders,
  addPublicReadHeaders,
  authenticate,
  cachedDb,
  createFeedPost,
  duplicateContentError,
  ensureUserForAuth,
  FeedPostCreationError,
  getCacheOrFetch,
  getHashedClientIp,
  getPostsFeed,
  publicRateLimit,
  rateLimitError,
  successResponse,
  toFeedISOString,
  withErrorHandling,
} from '@feed/api';
import type { Post } from '@feed/db';
import {
  and,
  comments,
  count,
  db,
  decodePostCursor,
  eq,
  follows,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  inArray,
  isNull,
  posts,
  reactions,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { CreatePostSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';

// Following-feed response shape remains unchanged.
type PostWithOriginal = Post & {
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    timestamp: Date;
    createdAt: Date;
    deletedAt: Date | null;
  } | null;
};

/**
 * GET /api/posts
 *
 * Retrieves paginated posts feed with advanced filtering, caching, and repost detection.
 * Supports following feed, actor filtering, post type filtering, and moderation (blocked/muted users).
 * Includes interaction counts (likes, comments, shares) and repost metadata.
 *
 * @param request - Next.js request with query parameters
 * @returns Posts feed response with pagination cursor
 */
/** Only `content` is accepted from clients when creating a post. */
const CreatePostBodySchema = CreatePostSchema.pick({ content: true });

/** Upper bound (and default) for `limit` on GET /api/posts. */
const MAX_POSTS_LIMIT = 100;

export const GET = withErrorHandling(async (request: NextRequest) => {
  const {
    error,
    user: authUser,
    rateLimitInfo,
  } = await publicRateLimit(request);
  if (error) return error;
  const { searchParams } = new URL(request.url);
  const parsedLimit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_POSTS_LIMIT)
    : MAX_POSTS_LIMIT;
  const cursor = searchParams.get('cursor') || undefined; // Cursor-based pagination
  const actorId = searchParams.get('actorId') || undefined;
  const following = searchParams.get('following') === 'true';
  const userId = searchParams.get('userId') || undefined;
  const type = searchParams.get('type') || undefined;

  // Following feed: only allow when authenticated and query userId matches authenticated user
  if (following && userId && authUser && authUser.userId === userId) {
    // Cache key for user's follows
    const followsCacheKey = `follows:${userId}`;

    // Get list of followed users/actors with caching
    const allFollowedIds = await getCacheOrFetch(
      followsCacheKey,
      async () => {
        const [userFollowsList, actorFollowsList] = await Promise.all([
          db
            .select({ followingId: follows.followingId })
            .from(follows)
            .where(eq(follows.followerId, userId)),
          db
            .select({ actorId: userActorFollows.actorId })
            .from(userActorFollows)
            .where(eq(userActorFollows.userId, userId)),
        ]);

        const followedUserIds = userFollowsList.map((f) => f.followingId);
        const followedActorIds = actorFollowsList.map((f) => f.actorId);
        return [...followedUserIds, ...followedActorIds];
      },
      {
        namespace: 'user:follows',
        ttl: 120, // Cache follows for 2 minutes
      }
    );

    if (allFollowedIds.length === 0) {
      // User is not following anyone
      const emptyRes = NextResponse.json({
        success: true,
        posts: [],
        total: 0,
        limit,
        source: 'following',
      });
      emptyRes.headers.set('Cache-Control', 'private, no-store');
      return emptyRes;
    }

    // Get moderation filters for this user
    const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
      getBlockedUserIds(userId),
      getMutedUserIds(userId),
      getBlockedByUserIds(userId),
    ]);

    // Combine all excluded user IDs
    const excludedUserIds = new Set([
      ...blockedIds,
      ...mutedIds,
      ...blockedByIds,
    ]);

    // Get posts from followed users/actors with caching
    const postsResult = await cachedDb.getPostsForFollowing(
      userId,
      allFollowedIds,
      limit,
      // This branch still pages by timestamp only; accept either cursor format.
      cursor === undefined ? undefined : decodePostCursor(cursor).timestamp
    );

    // Filter out posts from blocked/muted users
    const filteredPosts = postsResult.filter(
      (post) => !excludedUserIds.has(post.authorId)
    );

    // Get user data for filtered posts
    const authorIds: string[] = [
      ...new Set(
        filteredPosts
          .map((p: Post) => p.authorId)
          .filter((id): id is string => id !== undefined)
      ),
    ];

    const usersList =
      authorIds.length > 0
        ? await db
            .select({
              id: users.id,
              username: users.username,
              displayName: users.displayName,
              profileImageUrl: users.profileImageUrl,
            })
            .from(users)
            .where(inArray(users.id, authorIds))
        : [];
    const userMap = new Map(usersList.map((u) => [u.id, u]));
    const actorMap = new Map(
      authorIds
        .map((id) => StaticDataRegistry.getActor(id))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [
          a.id,
          { id: a.id, name: a.name, profileImageUrl: a.profileImageUrl },
        ])
    );
    const orgMap = new Map(
      authorIds
        .map((id) => StaticDataRegistry.getOrganization(id))
        .filter((o): o is NonNullable<typeof o> => o !== null)
        .map((o) => [o.id, { id: o.id, name: o.name, imageUrl: o.imageUrl }])
    );

    // Get interaction counts for all filtered posts in parallel
    const postIds = filteredPosts.map((p: Post) => p.id);
    const [reactionCounts, commentCounts] = await Promise.all([
      postIds.length > 0
        ? db
            .select({
              postId: reactions.postId,
              count: count(),
            })
            .from(reactions)
            .where(
              and(
                inArray(reactions.postId, postIds),
                eq(reactions.type, 'like')
              )
            )
            .groupBy(reactions.postId)
        : [],
      postIds.length > 0
        ? db
            .select({
              postId: comments.postId,
              count: count(),
            })
            .from(comments)
            .where(
              and(inArray(comments.postId, postIds), isNull(comments.deletedAt))
            )
            .groupBy(comments.postId)
        : [],
    ]);

    // Create maps for quick lookup
    const reactionMap = new Map(
      reactionCounts.map((r) => [r.postId, Number(r.count)] as const)
    );
    const commentMap = new Map(
      commentCounts.map((c) => [c.postId, Number(c.count)] as const)
    );

    // Fetch original posts for reposts in the following feed.
    // getPostsForFollowing does a plain SELECT with no JOIN, so originalPost
    // must be fetched separately — otherwise reposts render as blank cards.
    const followingRepostIds = filteredPosts
      .filter((p) => p.originalPostId)
      .map((p) => p.originalPostId)
      .filter((id): id is string => id !== null);

    const followingOriginalPostsMap = new Map<string, Post>();
    if (followingRepostIds.length > 0) {
      const originals = await db
        .select()
        .from(posts)
        .where(
          and(inArray(posts.id, followingRepostIds), isNull(posts.deletedAt))
        );
      originals.forEach((p) => followingOriginalPostsMap.set(p.id, p));
    }

    // Format following posts synchronously using lookup maps
    const formattedFollowingPosts = filteredPosts.map((post: Post) => {
      const originalPost = post.originalPostId
        ? (followingOriginalPostsMap.get(post.originalPostId) ?? null)
        : null;
      const postsWithOriginal: PostWithOriginal = { ...post, originalPost };
      const user = post.authorId ? userMap.get(post.authorId) : undefined;

      // Build repost metadata from originalPost if it exists (clean, no text parsing)
      const repostMetadata: Record<string, unknown> = {};
      if (postsWithOriginal.originalPostId && postsWithOriginal.originalPost) {
        const originalPost = postsWithOriginal.originalPost;
        const isQuote = post.content && post.content.length > 0;

        // Get original author from our maps
        const originalUser = userMap.get(originalPost.authorId);
        const originalActor = actorMap.get(originalPost.authorId);
        const originalOrg = orgMap.get(originalPost.authorId);

        let originalAuthorName = originalPost.authorId;
        let originalAuthorUsername: string | null = null;
        let originalAuthorProfileImageUrl: string | null = null;

        if (originalActor) {
          originalAuthorName = originalActor.name;
          originalAuthorProfileImageUrl = originalActor.profileImageUrl!;
        } else if (originalOrg) {
          originalAuthorName = originalOrg.name;
          originalAuthorProfileImageUrl = originalOrg.imageUrl!;
        } else if (originalUser) {
          originalAuthorName = originalUser.displayName!;
          originalAuthorUsername = originalUser.username!;
          originalAuthorProfileImageUrl = originalUser.profileImageUrl || null;
        }

        repostMetadata.isRepost = true;
        repostMetadata.isQuote = isQuote;
        repostMetadata.quoteComment = isQuote ? post.content : null;
        repostMetadata.originalPostId = originalPost.id;
        repostMetadata.originalPost = {
          id: originalPost.id,
          content: originalPost.content,
          authorId: originalPost.authorId,
          authorName: originalAuthorName,
          authorUsername: originalAuthorUsername,
          authorProfileImageUrl: originalAuthorProfileImageUrl,
          timestamp: toFeedISOString(originalPost.timestamp),
        };
      }

      return {
        id: post.id,
        content: post.content,
        author: post.authorId,
        authorId: post.authorId,
        authorName:
          user?.displayName || user?.username || post.authorId || 'Unknown',
        authorUsername: user?.username || null,
        timestamp: toFeedISOString(post.timestamp),
        createdAt: toFeedISOString(post.createdAt),
        likeCount: reactionMap.get(post.id) ?? 0,
        commentCount: commentMap.get(post.id) ?? 0,
        shareCount: 0, // Share count not currently tracked in feed
        isLiked: false,
        isShared: false,
        ...repostMetadata,
      };
    });

    const followingRes = NextResponse.json({
      success: true,
      posts: formattedFollowingPosts,
      limit,
      source: 'following',
    });
    // Personalized (follows + moderation): never cacheable by shared caches.
    if (rateLimitInfo) addPrivateReadHeaders(followingRes, rateLimitInfo);
    else followingRes.headers.set('Cache-Control', 'private, no-store');
    return followingRes;
  }

  const data = await getPostsFeed({
    limit,
    cursor,
    actorId,
    type,
    viewerId: authUser?.userId,
  });
  const response = NextResponse.json(data);

  if (authUser) {
    // Moderation-filtered for this viewer: never cacheable by shared caches.
    if (rateLimitInfo) addPrivateReadHeaders(response, rateLimitInfo);
    else response.headers.set('Cache-Control', 'private, no-store');
  } else if (rateLimitInfo) {
    addPublicReadHeaders(response, rateLimitInfo);
  } else {
    response.headers.set(
      'Cache-Control',
      's-maxage=10, stale-while-revalidate=60, must-revalidate'
    );
  }

  return response;
});

/**
 * POST /api/posts
 *
 * Creates a new post with content validation, rate limiting, and mention notifications.
 * Automatically extracts @mentions, sends notifications, broadcasts via SSE, and invalidates caches.
 *
 * @param request - Next.js request containing post content in JSON body
 * @returns Created post object with author details and metadata
 * @throws {400} Invalid content (empty, too long, duplicate, rate limited)
 * @throws {401} Unauthorized - authentication required
 * @throws {500} Internal server error
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { content: normalizedContent } = CreatePostBodySchema.parse(
    await request.json()
  );

  const fallbackDisplayName = authUser.walletAddress
    ? `${authUser.walletAddress.slice(0, 6)}...${authUser.walletAddress.slice(-4)}`
    : 'Anonymous';

  const { user: canonicalUser } = await ensureUserForAuth(authUser, {
    displayName: fallbackDisplayName,
  });
  const canonicalUserId = canonicalUser.id;
  try {
    const result = await createFeedPost(
      { content: normalizedContent },
      {
        accountId: canonicalUserId,
        clientIpHash: getHashedClientIp(request.headers) ?? undefined,
        onCreated: (event) => {
          void trackServerEvent(canonicalUserId, 'post_created', event);
        },
      }
    );
    return successResponse(result);
  } catch (error) {
    if (error instanceof FeedPostCreationError) {
      if (error.kind === 'rate_limit') return rateLimitError(error.retryAfter);
      if (error.kind === 'duplicate')
        return duplicateContentError(error.lastPostedAt);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }
    throw error;
  }
});
