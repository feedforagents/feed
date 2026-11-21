/**
 * Comment Replies API
 *
 * @route POST /api/comments/[id]/replies - Add reply to comment
 * @access Authenticated
 *
 * @description
 * Creates a reply to an existing comment. Automatically ensures parent post exists
 * and maintains comment threading. Replies are nested under their parent comment.
 *
 * @openapi
 * /api/comments/{id}/replies:
 *   post:
 *     tags:
 *       - Comments
 *     summary: Add reply to comment
 *     description: Creates a nested reply to an existing comment. Automatically ensures parent post exists.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Parent comment ID
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
 *                 description: Reply content
 *     responses:
 *       201:
 *         description: Reply created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 content:
 *                   type: string
 *                 postId:
 *                   type: string
 *                 authorId:
 *                   type: string
 *                 parentCommentId:
 *                   type: string
 *                 author:
 *                   type: object
 *                 likeCount:
 *                   type: integer
 *                 replyCount:
 *                   type: integer
 *       400:
 *         description: Invalid content
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Parent comment not found
 *
 * @example
 * ```typescript
 * const response = await fetch(`/api/comments/${commentId}/replies`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     content: 'This is my reply'
 *   })
 * });
 * const reply = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asUser, comments, eq, hasBlocked, posts, users } from '@feed/db';
import {
  CreateCommentSchema,
  generateSnowflakeId,
  IdParamSchema,
  logger,
} from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/comments/[id]/replies
 *
 * @description Add a reply to a comment
 *
 * @param {NextRequest} request - Request object
 * @param {Promise<{id: string}>} context.params - Route parameters
 *
 * @returns {Promise<NextResponse>} Created reply data
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: parentCommentId } = IdParamSchema.parse(await context.params);

    // Parse and validate request body
    const body = await request.json();
    const validatedData = CreateCommentSchema.parse(body);
    const { content } = validatedData;

    // Create reply with RLS
    const reply = await asUser(user, async (dbClient) => {
      // Check if parent comment exists
      const [parentComment] = await dbClient
        .select()
        .from(comments)
        .where(eq(comments.id, parentCommentId))
        .limit(1);

      if (!parentComment) {
        throw new NotFoundError('Parent comment', parentCommentId);
      }

      // Replies are only allowed under a visible parent on a visible post.
      // Posts are never created from the parent's post ID.
      const [parentPost] = await dbClient
        .select({
          id: posts.id,
          authorId: posts.authorId,
          timestamp: posts.timestamp,
          deletedAt: posts.deletedAt,
        })
        .from(posts)
        .where(eq(posts.id, parentComment.postId))
        .limit(1);

      if (!parentPost || parentPost.timestamp > new Date()) {
        throw new NotFoundError('Post', parentComment.postId);
      }
      if (parentPost.deletedAt || parentComment.deletedAt) {
        throw new BusinessLogicError(
          'Cannot reply to deleted content',
          'CONTENT_DELETED'
        );
      }

      // Same rule as POST /api/posts/[id]/comments: a reply may not be
      // posted when the post author and the replier blocked each other.
      // Without this, a blocked user can keep participating in the
      // thread — visible to every other reader — through this route
      // while the top-level route refuses the identical action.
      const [postBlocked, postBlockedMe] = await Promise.all([
        hasBlocked(parentPost.authorId, user.userId),
        hasBlocked(user.userId, parentPost.authorId),
      ]);
      if (postBlocked || postBlockedMe) {
        throw new BusinessLogicError(
          'Cannot comment on this post',
          'BLOCKED_USER'
        );
      }

      // Create reply (comment with parentCommentId)
      const now = new Date();
      const replyId = await generateSnowflakeId();
      const [newReply] = await dbClient
        .insert(comments)
        .values({
          id: replyId,
          content: content.trim(),
          postId: parentComment.postId,
          authorId: user.userId,
          parentCommentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // Fetch author details
      const [author] = await dbClient
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
        })
        .from(users)
        .where(eq(users.id, user.userId))
        .limit(1);

      return { ...newReply, author };
    });

    logger.info(
      'Reply created successfully',
      { parentCommentId, userId: user.userId, replyId: reply.id },
      'POST /api/comments/[id]/replies'
    );

    // New replies have 0 likes and 0 replies
    return successResponse(
      {
        id: reply.id,
        content: reply.content,
        postId: reply.postId,
        authorId: reply.authorId,
        parentCommentId: reply.parentCommentId,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        author: reply.author,
        likeCount: 0,
        replyCount: 0,
      },
      201
    );
  }
);
