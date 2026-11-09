/**
 * Post Share/Repost API
 *
 * @route POST /api/posts/[id]/share - Share/repost a post
 * @route DELETE /api/posts/[id]/share - Unshare/remove repost
 * @access Authenticated
 *
 * @description
 * Manages post sharing and reposting functionality. Creates repost posts that appear
 * in user feeds, handles quote posts with commentary, and manages share tracking.
 * Includes rate limiting, duplicate prevention, and automatic notifications.
 *
 * @openapi
 * /api/posts/{id}/share:
 *   post:
 *     tags:
 *       - Posts
 *     summary: Share/repost a post
 *     description: Creates a share/repost of a post. Optionally includes quote commentary. Creates repost post in user's feed.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID to share
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               comment:
 *                 type: string
 *                 description: Optional quote comment/commentary
 *     responses:
 *       201:
 *         description: Post shared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     shareCount:
 *                       type: integer
 *                     isShared:
 *                       type: boolean
 *                     repostPost:
 *                       type: object
 *       400:
 *         description: Post already shared or invalid
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Post not found
 *       429:
 *         description: Rate limit exceeded
 *   delete:
 *     tags:
 *       - Posts
 *     summary: Unshare a post
 *     description: Removes share and deletes associated repost post
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID to unshare
 *     responses:
 *       200:
 *         description: Post unshared successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Share not found
 *
 * @example
 * ```typescript
 * // Share with quote comment
 * const response = await fetch(`/api/posts/${postId}/share`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     comment: 'Great analysis!'
 *   })
 * });
 *
 * // Unshare
 * await fetch(`/api/posts/${postId}/share`, {
 *   method: 'DELETE',
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * ```
 *
 */

import {
  authenticate,
  checkProgress,
  checkRateLimitAndDuplicates,
  ensureUserForAuth,
  getCanonicalUserId,
  invalidateCache,
  narrativeEnrichmentKey,
  RATE_LIMIT_CONFIGS,
  sharePost,
  successResponse,
  unsharePost,
  withErrorHandling,
} from '@feed/api';
import { logger, PostIdParamSchema, SharePostSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';

/**
 * POST /api/posts/[id]/share
 *
 * Shares/reposts a post to the user's feed. Creates a repost post and share record.
 *
 * @param request - Next.js request containing optional quote comment
 * @param context - Route context with post ID parameter
 * @returns Share result with updated share count and repost post data
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    const rateLimitError = await checkRateLimitAndDuplicates(
      user.userId,
      null,
      RATE_LIMIT_CONFIGS.SHARE_POST
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    const body = await request.json();
    const validatedBody =
      Object.keys(body).length > 0
        ? SharePostSchema.parse(body)
        : { comment: undefined };
    const quoteComment = validatedBody.comment?.trim();

    const fallbackDisplayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    const { user: canonicalUser } = await ensureUserForAuth(user, {
      displayName: fallbackDisplayName,
    });
    const canonicalUserId = canonicalUser.id;

    const {
      shareTargetPostId,
      postAuthorId,
      shareCount,
      repostId,
      repostPost: repostPostData,
    } = await sharePost(canonicalUserId, postId, quoteComment, {
      username: canonicalUser.username,
      displayName: canonicalUser.displayName,
      profileImageUrl: canonicalUser.profileImageUrl,
    });

    // Bust the narrative enrichment cache so isShared reflects immediately
    invalidateCache(narrativeEnrichmentKey(canonicalUserId), {
      namespace: 'feed',
    }).catch((err) =>
      logger.warn(
        'Failed to invalidate narrative enrichment cache on share',
        { error: err, userId: canonicalUserId },
        'POST /api/posts/[id]/share'
      )
    );

    trackServerEvent(canonicalUserId, 'post_shared', {
      postId: shareTargetPostId,
      ...(postAuthorId && { originalAuthorId: postAuthorId }),
      shareCount,
      ...(repostId && { repostId }),
    });

    void checkProgress(canonicalUserId, { type: 'share_created' });

    return successResponse(
      {
        data: {
          shareCount,
          isShared: true,
          repostPost: repostPostData, // Include repost post data for optimistic UI
        },
      },
      201
    );
  }
);

/**
 * DELETE /api/posts/[id]/share
 *
 * Unshares a post and removes the associated repost post from the user's feed.
 * Deletes the share record, removes the repost post if it exists, invalidates caches,
 * and updates share count. Tracks unshare event for analytics.
 *
 * @param request - Next.js request
 * @param context - Route context with post ID parameter
 * @returns Unshare result with updated share count and success status
 * @throws {401} Unauthorized
 * @throws {404} Share not found
 */
export const DELETE = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // Authenticate user
    const user = await authenticate(request);
    const { id: postId } = PostIdParamSchema.parse(await context.params);

    const fallbackDisplayName = user.walletAddress
      ? `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`
      : 'Anonymous';

    await ensureUserForAuth(user, { displayName: fallbackDisplayName });
    const canonicalUserId = getCanonicalUserId(user);

    const { shareTargetPostId, shareCount } = await unsharePost(
      canonicalUserId,
      postId
    );

    trackServerEvent(canonicalUserId, 'post_unshared', {
      postId: shareTargetPostId,
      shareCount,
    });

    return successResponse({
      data: {
        shareCount,
        isShared: false,
      },
    });
  }
);
