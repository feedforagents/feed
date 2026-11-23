/**
 * Admin Resolution Review Queue API
 *
 * @route GET /api/admin/resolutions - List pending resolution reviews
 * @access Admin
 *
 * Returns prediction questions that were flagged as low-confidence and require
 * manual review before the market can be resolved.
 */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import {
  asc,
  db,
  isNotNull,
  predictionResolutionWork,
  questions,
  sql,
} from '@feed/db';
import { toISOOrNull } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { matchingDueDraft, pendingReview } from './review-filters';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const localnet = process.env.DEPLOYMENT_ENV === 'localnet';
  const query = db
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      text: questions.text,
      outcome: questions.outcome,
      resolutionDate: questions.resolutionDate,
      resolutionProofUrl: questions.resolutionProofUrl,
      resolutionDescription: questions.resolutionDescription,
      resolutionConfidence: questions.resolutionConfidence,
      resolutionReviewStatus: questions.resolutionReviewStatus,
      requiresManualReview: questions.requiresManualReview,
      updatedAt: questions.updatedAt,
      hasPrivateDraft: localnet
        ? isNotNull(predictionResolutionWork.draft)
        : sql<boolean>`false`,
    })
    .from(questions);
  const pending = await (localnet
    ? query.leftJoin(predictionResolutionWork, matchingDueDraft(new Date()))
    : query
  )
    .where(pendingReview)
    .orderBy(asc(questions.resolutionDate), asc(questions.id))
    .limit(200);

  const response = successResponse({
    success: true,
    items: pending.map((q) => ({
      id: q.id,
      questionNumber: q.questionNumber,
      text: q.text,
      outcome: q.outcome,
      resolutionDate: toISOOrNull(q.resolutionDate),
      resolutionProofUrl:
        q.resolutionProofUrl ??
        (q.hasPrivateDraft
          ? `/api/admin/resolutions/${encodeURIComponent(q.id)}/proof`
          : null),
      resolutionDescription: q.resolutionDescription ?? null,
      resolutionConfidence:
        typeof q.resolutionConfidence === 'number'
          ? q.resolutionConfidence
          : null,
      resolutionReviewStatus: q.resolutionReviewStatus ?? 'pending',
      requiresManualReview: Boolean(q.requiresManualReview),
      updatedAt: toISOOrNull(q.updatedAt),
    })),
    count: pending.length,
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
});
