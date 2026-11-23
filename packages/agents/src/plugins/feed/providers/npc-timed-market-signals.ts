import {
  and,
  dbWrite,
  eq,
  gt,
  inArray,
  lte,
  markets,
  or,
  questions,
  sql,
  timeframedMarketRoles,
  timeframedMarkets,
} from '@feed/db';
import { getActorRoleSignal } from '@feed/engine';

export async function getTimedNpcRoleContext(
  actorId: string,
  legacyQuestionIds: readonly string[]
) {
  if (process.env.DEPLOYMENT_ENV !== 'localnet') {
    return { signals: [], timedQuestionIds: new Set<string>() };
  }

  const now = new Date();
  const assigned = dbWrite
    .select({
      questionId: questions.id,
      question: questions.text,
      outcome: questions.outcome,
      insiderActorIds: timeframedMarketRoles.insiderActorIds,
      deceiverActorIds: timeframedMarketRoles.deceiverActorIds,
    })
    .from(timeframedMarkets)
    .innerJoin(
      timeframedMarketRoles,
      eq(timeframedMarketRoles.timeframedMarketId, timeframedMarkets.id)
    )
    .innerJoin(questions, eq(questions.id, timeframedMarkets.questionId))
    .innerJoin(
      markets,
      eq(markets.id, sql`coalesce(${questions.marketId}, ${questions.id})`)
    )
    .where(
      and(
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false),
        lte(timeframedMarkets.startTime, now),
        gt(timeframedMarkets.endTime, now),
        eq(questions.status, 'active'),
        gt(questions.resolutionDate, now),
        eq(markets.resolved, false),
        gt(markets.endDate, now),
        or(
          sql`jsonb_exists(${timeframedMarketRoles.insiderActorIds}, ${actorId})`,
          sql`jsonb_exists(${timeframedMarketRoles.deceiverActorIds}, ${actorId})`
        )
      )
    )
    .orderBy(timeframedMarkets.endTime, timeframedMarkets.id)
    .limit(5);

  // A timed role row replaces legacy assignments even when its arrays are
  // empty or the frame has since expired.
  const coveredLegacy = legacyQuestionIds.length
    ? dbWrite
        .selectDistinct({ questionId: timeframedMarkets.questionId })
        .from(timeframedMarkets)
        .innerJoin(
          timeframedMarketRoles,
          eq(timeframedMarketRoles.timeframedMarketId, timeframedMarkets.id)
        )
        .where(inArray(timeframedMarkets.questionId, legacyQuestionIds))
    : [];
  const [rows, covered] = await Promise.all([assigned, coveredLegacy]);
  const signals = rows.flatMap((row) => {
    const signal = getActorRoleSignal(row, actorId, row.outcome);
    return signal
      ? [{ questionId: row.questionId, question: row.question, signal }]
      : [];
  });
  return {
    signals,
    timedQuestionIds: new Set(
      covered.flatMap(({ questionId }) => (questionId ? [questionId] : []))
    ),
  };
}
