/**
 * Moderation Reports API
 *
 * @route GET /api/moderation/reports - Get user's reports
 * @route POST /api/moderation/reports - Create report
 * @access Authenticated
 *
 * @description
 * Manages user reports. GET returns reports created by current user.
 * POST creates a new report with AI evaluation. Includes duplicate detection.
 *
 * @openapi
 * /api/moderation/reports:
 *   get:
 *     tags:
 *       - Moderation
 *     summary: Get user's reports
 *     description: Returns reports created by current user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Reports retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reports:
 *                   type: array
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *   post:
 *     tags:
 *       - Moderation
 *     summary: Create report
 *     description: Creates a new report with AI evaluation
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reportType
 *               - category
 *             properties:
 *               reportType:
 *                 type: string
 *                 enum: [user, post, comment]
 *               reportedUserId:
 *                 type: string
 *               reportedPostId:
 *                 type: string
 *               reportedCommentId:
 *                 type: string
 *               category:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Report created successfully
 *       400:
 *         description: Invalid input or duplicate report
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Reported user/post/comment not found
 *
 * @example
 * ```typescript
 * // Create report
 * await fetch('/api/moderation/reports', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     reportType: 'user',
 *     reportedUserId: 'user-id',
 *     category: 'spam'
 *   })
 * });
 * ```
 */

import {
  authenticate,
  BusinessLogicError,
  evaluateReport,
  NotFoundError,
  storeEvaluationResult,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, sql } from '@feed/db';
import {
  CreateReportSchema,
  GetReportsSchema,
  generateSnowflakeId,
  logger,
} from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/moderation/reports
 * Create a new report
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const body = await request.json();
  const data = CreateReportSchema.parse(body);

  logger.info(
    'Creating report',
    {
      reporterId: authUser.userId,
      reportType: data.reportType,
      category: data.category,
    },
    'POST /api/moderation/reports'
  );

  // Validate reported user exists if reporting a user
  if (data.reportedUserId) {
    if (data.reportedUserId === authUser.userId) {
      throw new BusinessLogicError(
        'Cannot report yourself',
        'CANNOT_REPORT_SELF'
      );
    }

    const reportedUser = await db.user.findUnique({
      where: { id: data.reportedUserId },
      select: { id: true, isActor: true },
    });

    if (!reportedUser) {
      throw new NotFoundError('User', data.reportedUserId);
    }
  }

  // Validate reported post exists if reporting a post
  if (data.reportedPostId) {
    const reportedPost = await db.post.findUnique({
      where: { id: data.reportedPostId },
      select: { id: true, authorId: true },
    });

    if (!reportedPost) {
      throw new NotFoundError('Post', data.reportedPostId);
    }
  }

  // Determine priority based on category
  let priority = 'normal';
  if (['hate_speech', 'violence', 'self_harm'].includes(data.category)) {
    priority = 'high';
  } else if (data.category === 'spam') {
    priority = 'low';
  }

  // Duplicate detection is check-then-create: two concurrent submissions for
  // the same reporter, target and category could both read "no recent report"
  // and both insert, leaving duplicate rows in the moderation queue — for user
  // reports each duplicate would also run its own LLM evaluation and auto-ban
  // pass. Serialize the check and the insert per (reporter, target, category)
  // with a transaction-scoped advisory lock, the same pattern as the
  // follow/block pair lock in packages/db/src/moderation/filters.ts: the
  // second transaction waits, reads the first row, and raises the documented
  // DUPLICATE_REPORT instead of inserting. The lock must be the first
  // statement of the transaction.
  const report = await db.$transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'report-dedup:' + authUser.userId + ':' + (data.reportedUserId ?? data.reportedPostId) + ':' + data.category}))`
    );

    if (data.reportedUserId) {
      const recentReport = await tx.report.findFirst({
        where: {
          reporterId: authUser.userId,
          reportedUserId: data.reportedUserId,
          category: data.category,
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      });

      if (recentReport) {
        throw new BusinessLogicError(
          'You have already reported this user for this reason recently',
          'DUPLICATE_REPORT'
        );
      }
    }

    if (data.reportedPostId) {
      const recentReport = await tx.report.findFirst({
        where: {
          reporterId: authUser.userId,
          reportedPostId: data.reportedPostId,
          category: data.category,
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      });

      if (recentReport) {
        throw new BusinessLogicError(
          'You have already reported this post for this reason recently',
          'DUPLICATE_REPORT'
        );
      }
    }

    return tx.report.create({
      data: {
        id: await generateSnowflakeId(),
        reporterId: authUser.userId,
        reportedUserId: data.reportedUserId || null,
        reportedPostId: data.reportedPostId || null,
        reportType: data.reportType,
        category: data.category,
        reason: data.reason,
        evidence: data.evidence || null,
        priority,
        status: 'pending',
        updatedAt: new Date(),
      },
    });
  });

  logger.info(
    'Report created successfully',
    {
      reportId: report.id,
      reporterId: authUser.userId,
      reportType: data.reportType,
      category: data.category,
      priority,
    },
    'POST /api/moderation/reports'
  );

  // Automatically evaluate and process the report
  // This ensures fully automated moderation - no human review needed unless user stakes $10 for appeal
  const evaluation = await evaluateReport(report.id);
  await storeEvaluationResult(report.id, evaluation);

  // Punitive action is driven only by explicit recommended actions from the
  // evaluator, never by substring matches in free-text reasoning (negations
  // such as "no evidence of a scam" must not ban anyone). The evaluator output
  // is untrusted JSON, so its shape is checked before use.
  const recommendedActions: string[] = Array.isArray(
    evaluation.recommendedActions
  )
    ? evaluation.recommendedActions.filter(
        (action): action is string => typeof action === 'string'
      )
    : [];
  const isScammer = recommendedActions.includes('mark_scammer');
  const isCSAM = recommendedActions.includes('mark_csam');
  const shouldAutoBan =
    evaluation.outcome === 'valid_report' &&
    typeof evaluation.confidence === 'number' &&
    evaluation.confidence >= 0.8 &&
    report.reportedUserId !== null &&
    (recommendedActions.includes('ban_user') ||
      recommendedActions.includes('ban') ||
      isScammer ||
      isCSAM);

  if (shouldAutoBan && report.reportedUserId) {
    // Automatically ban the reported user
    if (report.reportedUserId) {
      await db.user.update({
        where: { id: report.reportedUserId },
        data: {
          isBanned: true,
          bannedAt: new Date(),
          bannedReason: `Automated ban from report #${report.id}: ${evaluation.reasoning.substring(0, 200)}`,
          bannedBy: null, // System ban - no specific admin
          isScammer: isScammer,
          isCSAM: isCSAM,
        },
      });
    }

    // Update report status
    await db.report.update({
      where: { id: report.id },
      data: {
        status: 'resolved',
        resolution: `User automatically banned: ${evaluation.reasoning.substring(0, 200)}`,
        resolvedBy: null, // System resolution - no specific admin
        resolvedAt: new Date(),
      },
    });

    logger.info(
      'User automatically banned from report',
      {
        reportId: report.id,
        reportedUserId: report.reportedUserId,
        evaluationOutcome: evaluation.outcome,
        confidence: evaluation.confidence,
      },
      'POST /api/moderation/reports'
    );
  } else {
    // Store evaluation but don't auto-ban (low confidence or not scammer/CSAM)
    await db.report.update({
      where: { id: report.id },
      data: {
        status: 'reviewing',
        resolution: JSON.stringify(evaluation),
      },
    });
  }

  return successResponse({
    success: true,
    message:
      'Report submitted successfully. It has been automatically evaluated.',
    report,
  });
});

/**
 * GET /api/moderation/reports
 * Get current user's submitted reports
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const params = GetReportsSchema.parse({
    limit: searchParams.get('limit') || '50',
    offset: searchParams.get('offset') || '0',
    status: searchParams.get('status') || undefined,
    category: searchParams.get('category') || undefined,
    reportType: searchParams.get('reportType') || undefined,
  });

  // Build where clause
  const where: Record<string, unknown> = {
    reporterId: authUser.userId,
  };

  if (params.status) where.status = params.status;
  if (params.category) where.category = params.category;
  if (params.reportType) where.reportType = params.reportType;

  const [reports, total] = await Promise.all([
    db.report.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      skip: params.offset,
      include: {
        reportedUser: {
          select: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
          },
        },
        resolver: {
          select: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    }),
    db.report.count({ where }),
  ]);

  return successResponse({
    reports,
    pagination: {
      limit: params.limit,
      offset: params.offset,
      total,
    },
  });
});
