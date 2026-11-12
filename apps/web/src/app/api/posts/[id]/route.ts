/**
 * API Route: /api/posts/[id]
 * Methods: GET (get single post details), DELETE (soft delete post)
 *
 * @openapi
 * /api/posts/{id}:
 *   get:
 *     tags:
 *       - Posts
 *     summary: Get single post
 *     description: Returns a single post by ID with full details including author, interactions, and repost metadata.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Post details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 content:
 *                   type: string
 *                 authorId:
 *                   type: string
 *                 likeCount:
 *                   type: integer
 *                 commentCount:
 *                   type: integer
 *                 shareCount:
 *                   type: integer
 *       404:
 *         description: Post not found
 *   delete:
 *     tags:
 *       - Posts
 *     summary: Delete post
 *     description: Soft deletes a post (author only). Post is marked as deleted but data is retained.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Post deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not the post author
 *       404:
 *         description: Post not found
 */

import {
  addPrivateReadHeaders,
  addPublicReadHeaders,
  authenticate,
  BusinessLogicError,
  getCanonicalUserId,
  NotFoundError,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  comments,
  count,
  db,
  eq,
  isNull,
  lte,
  posts,
  reactions,
  shares,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, PostIdParamSchema, toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { loadViewerExcludedAuthorIds } from '@/app/api/feed/_lib/viewer-moderation';
import { POST as likePost } from './like/route';

/**
 * GET /api/posts/[id]
 * Get a single post by ID
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { error, user, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;
    const withHeaders = (res: ReturnType<typeof successResponse>) => {
      if (user) {
        // Includes the viewer's isLiked/isShared: never shared-cacheable.
        if (rateLimitInfo) addPrivateReadHeaders(res, rateLimitInfo);
        else res.headers.set('Cache-Control', 'private, no-store');
      } else if (rateLimitInfo) {
        addPublicReadHeaders(res, rateLimitInfo);
      }
      return res;
    };

    const { id: postId } = PostIdParamSchema.parse(await context.params);

    const now = new Date();

    // Get post from database
    const [post] = await db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, postId),
          lte(posts.timestamp, now) // No future posts
        )
      )
      .limit(1);

    // Get counts and user interactions
    const userId = user?.userId;
    const canonicalUserId = user ? getCanonicalUserId(user) : undefined;

    // Unknown (or not-yet-published) IDs are simply not found. This route
    // never creates posts on read.
    if (!post) {
      throw new NotFoundError('Post', postId);
    }

    // Check if post is deleted
    if (post.deletedAt) {
      throw new BusinessLogicError(
        'This post has been deleted',
        'POST_DELETED'
      );
    }

    // Get counts
    const [[likeCountResult], commentRows, [shareCountResult]] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(reactions)
          .where(and(eq(reactions.postId, postId), eq(reactions.type, 'like'))),
        db
          .select({
            id: comments.id,
            authorId: comments.authorId,
            parentCommentId: comments.parentCommentId,
          })
          .from(comments)
          .where(and(eq(comments.postId, postId), isNull(comments.deletedAt))),
        db
          .select({ count: count() })
          .from(shares)
          .where(eq(shares.postId, postId)),
      ]);

    const likeCount = Number(likeCountResult?.count ?? 0);
    // Count only the comments the comment list below can actually show.
    // That list omits replies whose parent is not visible (e.g. a parent
    // soft-deleted by moderation takes its whole subtree out of the tree),
    // so count the comments reachable from a top-level comment, mirroring
    // the tree rule in GET /api/posts/[id]/comments.
    //
    // The list also applies the signed viewer's block/mute policy before
    // building its tree, through the same loadViewerExcludedAuthorIds
    // definition used here: comments by authors the viewer blocked or
    // muted — or who blocked the viewer — are excluded, and their replies
    // go with them because the hidden parent is unreachable from the root.
    // Anonymous reads have no moderation set and stay unfiltered, exactly
    // like the list route.
    let visibleCommentRows = commentRows;
    if (canonicalUserId && commentRows.length > 0) {
      const excludedAuthorIds =
        await loadViewerExcludedAuthorIds(canonicalUserId);
      if (excludedAuthorIds.size > 0) {
        visibleCommentRows = commentRows.filter(
          (row) => !excludedAuthorIds.has(row.authorId)
        );
      }
    }
    const childrenByParent = new Map<string | null, string[]>();
    for (const row of visibleCommentRows) {
      const siblings = childrenByParent.get(row.parentCommentId);
      if (siblings) siblings.push(row.id);
      else childrenByParent.set(row.parentCommentId, [row.id]);
    }
    let commentCount = 0;
    const stack = [...(childrenByParent.get(null) ?? [])];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      commentCount += 1;
      stack.push(...(childrenByParent.get(id) ?? []));
    }
    const shareCount = Number(shareCountResult?.count ?? 0);

    // Get user interactions
    let isLiked = false;
    let isShared = false;

    if (userId) {
      const [[likedResult], [sharedResult]] = await Promise.all([
        db
          .select({ id: reactions.id })
          .from(reactions)
          .where(
            and(
              eq(reactions.postId, postId),
              eq(reactions.userId, userId),
              eq(reactions.type, 'like')
            )
          )
          .limit(1),
        db
          .select({ id: shares.id })
          .from(shares)
          .where(and(eq(shares.postId, postId), eq(shares.userId, userId)))
          .limit(1),
      ]);
      isLiked = !!likedResult;
      isShared = !!sharedResult;
    }

    let authorName = post.authorId;
    let authorUsername: string | null = null;
    let authorProfileImageUrl: string | null = null;

    const actor = StaticDataRegistry.getActor(post.authorId);

    if (actor) {
      authorName = actor.name;
      // Use database profileImageUrl or construct path from actor ID
      authorProfileImageUrl =
        actor.profileImageUrl || `/images/actors/${actor.id}.jpg`;
    } else {
      // Check if it's an organization (for articles)
      const org = StaticDataRegistry.getOrganization(post.authorId);

      if (org) {
        authorName = org.name;
        // Use database imageUrl or construct path from organization ID
        authorProfileImageUrl =
          org.imageUrl || `/images/organizations/${org.id}.jpg`;
      } else {
        const [usr] = await db
          .select({
            displayName: users.displayName,
            username: users.username,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, post.authorId))
          .limit(1);

        if (usr) {
          authorName = usr.displayName || usr.username || post.authorId;
          authorUsername = usr.username || null;
          authorProfileImageUrl = usr.profileImageUrl || null;
        }
      }
    }

    // Build repost metadata from originalPostId (clean, no regex parsing)
    let repostMetadata = {};

    if (post.originalPostId) {
      const [originalPost] = await db
        .select()
        .from(posts)
        .where(and(eq(posts.id, post.originalPostId), isNull(posts.deletedAt)))
        .limit(1);

      if (originalPost) {
        const isQuote = post.content && post.content.length > 0;

        // Get original post author
        const [originalUser] = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            profileImageUrl: users.profileImageUrl,
          })
          .from(users)
          .where(eq(users.id, originalPost.authorId))
          .limit(1);

        const originalActor = !originalUser
          ? StaticDataRegistry.getActor(originalPost.authorId)
          : null;

        const originalOrg =
          !originalUser && !originalActor
            ? StaticDataRegistry.getOrganization(originalPost.authorId)
            : null;

        const originalAuthor = originalUser || originalActor || originalOrg;

        if (originalAuthor) {
          const authorName =
            originalUser?.displayName ??
            originalActor?.name ??
            originalOrg?.name ??
            originalPost.authorId;
          const authorUsername =
            originalUser?.username ??
            originalActor?.username ??
            originalOrg?.id ??
            originalPost.authorId;
          const authorProfileImageUrl =
            originalUser?.profileImageUrl ??
            originalActor?.profileImageUrl ??
            originalOrg?.imageUrl ??
            null;
          repostMetadata = {
            isRepost: true,
            isQuote,
            quoteComment: isQuote ? post.content : null,
            originalPostId: originalPost.id,
            originalPost: {
              id: originalPost.id,
              content: originalPost.content,
              authorId: originalPost.authorId,
              authorName,
              authorUsername,
              authorProfileImageUrl,
              timestamp:
                originalPost.timestamp?.toISOString?.() ||
                new Date().toISOString(),
            },
          };
        }
      }
    }

    logger.info(
      'Post fetched successfully',
      { postId, source: 'database' },
      'GET /api/posts/[id]'
    );

    return withHeaders(
      successResponse({
        data: {
          id: post.id,
          type: post.type || 'post',
          content: post.content,
          fullContent: post.fullContent || null,
          articleTitle: post.articleTitle || null,
          byline: post.byline || null,
          biasScore: post.biasScore !== undefined ? post.biasScore : null,
          sentiment: post.sentiment || null,
          slant: post.slant || null,
          category: post.category || null,
          imageUrl: post.imageUrl || null,
          authorId: post.authorId,
          authorName: authorName,
          authorUsername: authorUsername,
          authorProfileImageUrl: authorProfileImageUrl,
          authorAvatar: authorProfileImageUrl || undefined,
          isActorPost: true, // Posts are from game actors
          timestamp: post.timestamp
            ? toISO(post.timestamp)
            : toISO(post.createdAt),
          createdAt: toISO(post.createdAt),
          likeCount,
          commentCount,
          shareCount,
          isLiked,
          isShared,
          source: 'database',
          ...repostMetadata, // Add repost metadata if applicable
        },
      })
    );
  }
);

// Backwards-compatible alias for clients that POST to the post resource to like it.
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    return likePost(request, context);
  }
);

/**
 * DELETE /api/posts/[id]
 * Soft delete a post (mark as deleted)
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    // Require authentication (throws error if not authenticated)
    const user = await authenticate(request);

    // Get the post to check ownership
    const [post] = await db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        deletedAt: posts.deletedAt,
      })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (!post) {
      throw new BusinessLogicError('Post not found', 'POST_NOT_FOUND');
    }

    // Check if post is already deleted
    if (post.deletedAt) {
      throw new BusinessLogicError(
        'Post already deleted',
        'POST_ALREADY_DELETED'
      );
    }

    // Check if user is the author of the post
    if (post.authorId !== user.userId) {
      throw new BusinessLogicError(
        'Unauthorized to delete this post',
        'UNAUTHORIZED'
      );
    }

    // Soft delete the post by setting deletedAt timestamp
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));

    logger.info(
      'Post soft deleted',
      { postId, userId: user.userId },
      'DELETE /api/posts/[id]'
    );

    return successResponse({
      message: 'Post deleted successfully',
      data: { id: postId, deletedAt: new Date().toISOString() },
    });
  }
);
