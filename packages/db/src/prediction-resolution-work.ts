import {
  aliasedTable,
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  min,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { dbWrite, type Transaction } from './db';
import { markets, questions } from './schema/markets';
import { generationLocks } from './schema/misc';
import { timeframedMarkets } from './schema/narrative';
import { predictionResolutionWork } from './schema/prediction-resolution-work';

export const PREDICTION_RECOVERY_LEASE_ID = 'markets-recovery-global';

/** Hold the lease row until the short DB commit finishes, never during inference. */
export async function ownsPredictionRecoveryLease(
  tx: Transaction,
  owner: string
): Promise<boolean> {
  const [lock] = await tx
    .select({ id: generationLocks.id })
    .from(generationLocks)
    .where(
      and(
        eq(generationLocks.id, PREDICTION_RECOVERY_LEASE_ID),
        eq(generationLocks.lockedBy, owner),
        gt(generationLocks.expiresAt, sql`clock_timestamp() AT TIME ZONE 'UTC'`)
      )
    )
    .for('share');
  return Boolean(lock);
}

function linkedMarket() {
  const byId = aliasedTable(markets, 'recovery_market_by_id');
  const byQuestion = aliasedTable(markets, 'recovery_market_by_question');
  const owner = aliasedTable(questions, 'recovery_market_owner');
  const legacyId = dbWrite
    .select({ id: byId.id })
    .from(byId)
    .where(eq(byId.id, questions.id));
  const ownerOfTextMatch = dbWrite
    .select({ id: owner.id })
    .from(owner)
    .where(or(eq(owner.marketId, byQuestion.id), eq(owner.id, byQuestion.id)));
  // Recover by text only when there is exactly one match and it is unclaimed.
  const legacyText = dbWrite
    .select({ id: min(byQuestion.id) })
    .from(byQuestion)
    .where(eq(byQuestion.question, questions.text))
    .having(sql`count(*) = 1 and bool_and(not exists (${ownerOfTextMatch}))`);

  return eq(
    markets.id,
    sql`coalesce(${questions.marketId}, (${legacyId}), (${legacyText}))`
  );
}

function expiredMarkets(now: Date) {
  return and(
    eq(questions.status, 'active'),
    lte(questions.resolutionDate, now),
    eq(markets.resolved, false),
    lte(markets.endDate, now)
  );
}

/** Count expired questions, including any waiting for a manual decision. */
export async function readPredictionRecoveryHealth(now: Date): Promise<{
  pendingResolutions: number;
  oldestPendingResolutionAgeMs: number | null;
}> {
  const [summary] = await dbWrite
    .select({
      pendingResolutions: count(),
      oldest:
        sql<Date | null>`min(greatest(${questions.resolutionDate}, ${markets.endDate}))`.mapWith(
          questions.resolutionDate
        ),
    })
    .from(questions)
    .innerJoin(markets, linkedMarket())
    .where(expiredMarkets(now));

  return {
    pendingResolutions: summary?.pendingResolutions ?? 0,
    oldestPendingResolutionAgeMs: summary?.oldest
      ? now.getTime() - summary.oldest.getTime()
      : null,
  };
}

export async function listDuePredictionRecoveryMarkets(
  now: Date,
  limit: number
) {
  // A question can have multiple legacy frames. Select one without multiplying
  // recovery rows or consuming the limit with duplicates.
  const timeframe = dbWrite
    .select({ timeframe: timeframedMarkets.timeframe })
    .from(timeframedMarkets)
    .where(eq(timeframedMarkets.questionId, questions.id))
    .orderBy(asc(timeframedMarkets.id))
    .limit(1);

  return dbWrite
    .select({
      id: questions.id,
      marketId: markets.id,
      questionNumber: questions.questionNumber,
      timeframe: sql<string>`coalesce((${timeframe}), '1d')`,
      resolutionDate: questions.resolutionDate,
      outcome: questions.outcome,
    })
    .from(questions)
    .innerJoin(markets, linkedMarket())
    .leftJoin(
      predictionResolutionWork,
      eq(predictionResolutionWork.questionId, questions.id)
    )
    .where(
      and(
        expiredMarkets(now),
        or(
          eq(questions.requiresManualReview, false),
          and(
            isNotNull(questions.resolutionReviewStatus),
            ne(questions.resolutionReviewStatus, 'pending')
          )
        ),
        or(
          isNull(predictionResolutionWork.nextAttemptAt),
          lte(predictionResolutionWork.nextAttemptAt, now),
          ne(predictionResolutionWork.resolutionDate, questions.resolutionDate),
          ne(predictionResolutionWork.outcome, questions.outcome)
        )
      )
    )
    .orderBy(asc(questions.resolutionDate), asc(questions.id))
    .limit(limit);
}
