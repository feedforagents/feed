/**
 * Admin Content Moderation Action API
 *
 * @route POST /api/admin/content-queue/[contentId] - Moderate content
 * @access Admin
 *
 * @description
 * Performs moderation actions on flagged content (approve, hide, delete).
 * Uses soft delete (deletedAt) for hiding content.
 */

import {
  cachedDb,
  checkRateLimitAndDuplicates,
  errorResponse,
  logAdminModify,
  RATE_LIMIT_CONFIGS,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  comments,
  db,
  eq,
  inArray,
  isNull,
  posts,
  reports,
  withTransaction,
} from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

/**
 * Moderation action types:
 * - approve: Mark content as reviewed and acceptable, dismiss associated reports
 * - hide: Soft delete content (set deletedAt), keeps data for potential recovery
 *
 * NOTE: "delete" was removed as it was redundant with "hide". Both performed
 * soft deletes. If hard delete is needed in the future, it should be a
 * separate, more privileged action with additional safeguards.
 */
// Only open reports are transitioned; already resolved/dismissed reports keep
// their original reviewer and resolution.
const OPEN_REPORT_STATUSES = inArray(reports.status, ['pending', 'reviewing']);

const ModerateRequestSchema = z.object({
  action: z.enum(['approve', 'hide']),
  contentType: z.enum(['post', 'comment']),
  reason: z.string().max(500).optional(), // Max 500 chars for reason
});

/**
 * Get real client IP address from x-forwarded-for header
 * Takes the last IP in the chain which is the most reliable (added by our proxy)
 */
function getClientIp(request: NextRequest): string | undefined {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (!forwardedFor) return undefined;
  // Take the last IP (most reliable - added by our reverse proxy)
  return forwardedFor
    .split(',')
    .map((s) => s.trim())
    .pop();
}

export const POST = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ contentId: string }> }
  ) => {
    const admin = await requireAdmin(request);

    // Rate limit admin actions to prevent abuse
    const rateLimitResponse = await checkRateLimitAndDuplicates(
      admin.userId,
      null,
      RATE_LIMIT_CONFIGS.ADMIN_ACTION
    );
    if (rateLimitResponse) return rateLimitResponse;

    const { contentId } = await params;

    // Validate request body with Zod schema
    const parseResult = ModerateRequestSchema.safeParse(await request.json());
    if (!parseResult.success) {
      return errorResponse('Invalid request', 'VALIDATION_ERROR', 400, {
        details: parseResult.error.flatten(),
      });
    }
    const { action, contentType, reason } = parseResult.data;

    logger.info(
      'Content moderation action',
      { contentId, action, contentType, adminId: admin.userId },
      'POST /api/admin/content-queue/[contentId]'
    );

    if (contentType === 'post') {
      // Handle post moderation
      const [existingPost] = await db
        .select({
          id: posts.id,
          authorId: posts.authorId,
          deletedAt: posts.deletedAt,
        })
        .from(posts)
        .where(eq(posts.id, contentId))
        .limit(1);

      if (!existingPost) {
        return errorResponse('Post not found', 'NOT_FOUND', 404);
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? undefined;

      if (action === 'approve') {
        // Mark reports as dismissed
        await db
          .update(reports)
          .set({
            status: 'dismissed',
            resolution: 'Content approved by admin',
            resolvedBy: admin.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(reports.reportedPostId, contentId), OPEN_REPORT_STATUSES)
          );

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'post',
          resourceId: contentId,
          previousValue: { status: 'pending' },
          newValue: { status: 'approved' },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'approve' },
        });
      } else if (action === 'hide') {
        // Use transaction to ensure atomic update of content + reports
        await withTransaction(async (tx) => {
          // Soft delete by setting deletedAt (content can be recovered if needed)
          await tx
            .update(posts)
            .set({ deletedAt: new Date() })
            // Keep the original deletedAt if already hidden (idempotent)
            .where(and(eq(posts.id, contentId), isNull(posts.deletedAt)));

          // Mark reports as resolved
          await tx
            .update(reports)
            .set({
              status: 'resolved',
              resolution: reason || 'Content hidden by admin',
              resolvedBy: admin.userId,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(eq(reports.reportedPostId, contentId), OPEN_REPORT_STATUSES)
            );
        });

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'post',
          resourceId: contentId,
          previousValue: {
            deletedAt: existingPost.deletedAt?.toISOString() ?? null,
          },
          newValue: {
            deletedAt: new Date().toISOString(),
            reason: reason ?? null,
          },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'hide' },
        });

        // Audit the committed hide before fallible cache I/O.
        await cachedDb.invalidatePostsCache();
        await cachedDb.invalidateActorPostsCache(existingPost.authorId);
      }
    } else if (contentType === 'comment') {
      // Handle comment moderation
      const [existingComment] = await db
        .select({
          id: comments.id,
          deletedAt: comments.deletedAt,
          postId: comments.postId,
        })
        .from(comments)
        .where(eq(comments.id, contentId))
        .limit(1);

      if (!existingComment) {
        return errorResponse('Comment not found', 'NOT_FOUND', 404);
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers.get('user-agent') ?? undefined;

      if (action === 'approve') {
        // Dismiss reports for this comment
        await db
          .update(reports)
          .set({
            status: 'dismissed',
            resolution: 'Comment approved by admin',
            resolvedBy: admin.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(reports.reportedCommentId, contentId), OPEN_REPORT_STATUSES)
          );

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'comment',
          resourceId: contentId,
          previousValue: { status: 'pending' },
          newValue: { status: 'approved' },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'approve' },
        });
      } else if (action === 'hide') {
        // Use transaction to ensure atomic update of content + reports
        await withTransaction(async (tx) => {
          // Soft delete by setting deletedAt (content can be recovered if needed)
          await tx
            .update(comments)
            .set({
              deletedAt: new Date(),
              updatedAt: new Date(),
            })
            // Keep the original deletedAt if already hidden (idempotent)
            .where(and(eq(comments.id, contentId), isNull(comments.deletedAt)));

          // Mark reports as resolved (matching post hide behavior)
          await tx
            .update(reports)
            .set({
              status: 'resolved',
              resolution: reason || 'Comment hidden by admin',
              resolvedBy: admin.userId,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(reports.reportedCommentId, contentId),
                OPEN_REPORT_STATUSES
              )
            );
        });

        await logAdminModify({
          adminId: admin.userId,
          resourceType: 'comment',
          resourceId: contentId,
          previousValue: {
            deletedAt: existingComment.deletedAt?.toISOString() ?? null,
          },
          newValue: {
            deletedAt: new Date().toISOString(),
            reason: reason ?? null,
          },
          ipAddress: clientIp,
          userAgent,
          metadata: { action: 'hide' },
        });
      }
    }

    return successResponse({
      success: true,
      action,
      contentId,
      contentType,
    });
  }
);
