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
  getPublicPost,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, eq, posts } from '@feed/db';
import { logger, PostIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
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

    return withHeaders(
      successResponse({ data: await getPublicPost(postId, user?.userId) })
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
