import {
  and,
  eq,
  isNull,
  lte,
  or,
  predictionResolutionWork,
  questions,
} from '@feed/db';

export const pendingReview = and(
  eq(questions.status, 'active'),
  eq(questions.requiresManualReview, true),
  or(
    isNull(questions.resolutionReviewStatus),
    eq(questions.resolutionReviewStatus, 'pending')
  )
);

export function matchingDueDraft(now: Date) {
  return and(
    eq(questions.id, predictionResolutionWork.questionId),
    eq(questions.resolutionDate, predictionResolutionWork.resolutionDate),
    eq(questions.outcome, predictionResolutionWork.outcome),
    lte(questions.resolutionDate, now)
  );
}
