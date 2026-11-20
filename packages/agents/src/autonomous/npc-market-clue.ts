import {
  type ArcStateType,
  and,
  dbWrite,
  desc,
  eq,
  games,
  gt,
  lte,
  markets,
  notExists,
  npcMarketClues,
  posts,
  questionArcPlans,
  questions,
  sql,
  timeframedMarkets,
} from '@feed/db';
import {
  getCurrentArcState,
  isActiveHour,
  StaticDataRegistry,
} from '@feed/engine';

type ArcRoles = Pick<
  typeof questionArcPlans.$inferSelect,
  'insiderActorIds' | 'deceiverActorIds'
>;

export interface NpcMarketClue {
  actorId: string;
  gameId: string;
  marketId: string;
  questionId: string;
  frameId: string;
  phase: ArcStateType;
  phaseEnteredAt: Date;
  question: string;
  oldestPendingAt: Date;
}

const marketIdForQuestion = sql<string>`coalesce(${questions.marketId}, ${questions.id})`;
const latestPlan = sql<string>`(
  SELECT plan."id"
  FROM "QuestionArcPlan" AS plan
  WHERE plan."questionId" = ${questions.id}
  ORDER BY plan."createdAt" DESC, plan."id" DESC
  LIMIT 1
)`;

function eligibleActors(affiliates: string[] | null, plan: ArcRoles | null) {
  return [
    ...(plan?.insiderActorIds ?? []),
    ...(plan?.deceiverActorIds ?? []),
    ...(affiliates ?? []),
  ];
}

export async function selectDueNpcMarketClue(
  gameId: string,
  activeNpcIds: readonly string[]
): Promise<NpcMarketClue | undefined> {
  if (process.env.DEPLOYMENT_ENV !== 'localnet' || activeNpcIds.length === 0) {
    return undefined;
  }

  const now = new Date();
  const npcIds = new Set(activeNpcIds);
  const matchIds = sql`ARRAY[${sql.join(
    activeNpcIds.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`;
  const [candidate] = await dbWrite
    .select({
      frame: {
        id: timeframedMarkets.id,
        timeframe: timeframedMarkets.timeframe,
        startTime: timeframedMarkets.startTime,
        endTime: timeframedMarkets.endTime,
        arcState: timeframedMarkets.arcState,
        arcStateEnteredAt: timeframedMarkets.arcStateEnteredAt,
        affiliatedActorIds: timeframedMarkets.affiliatedActorIds,
      },
      questionId: questions.id,
      question: questions.text,
      oldestPendingAt:
        sql`min(${timeframedMarkets.arcStateEnteredAt}) over ()`.mapWith(
          timeframedMarkets.arcStateEnteredAt
        ),
      marketId: markets.id,
      plan: {
        insiderActorIds: questionArcPlans.insiderActorIds,
        deceiverActorIds: questionArcPlans.deceiverActorIds,
      },
    })
    .from(timeframedMarkets)
    .innerJoin(questions, eq(questions.id, timeframedMarkets.questionId))
    .innerJoin(markets, eq(markets.id, marketIdForQuestion))
    .innerJoin(games, eq(games.id, markets.gameId))
    .leftJoin(questionArcPlans, eq(questionArcPlans.id, latestPlan))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.isContinuous, true),
        eq(games.isRunning, true),
        eq(markets.resolved, false),
        gt(markets.endDate, now),
        eq(questions.status, 'active'),
        gt(questions.resolutionDate, now),
        eq(timeframedMarkets.isActive, true),
        eq(timeframedMarkets.isResolved, false),
        lte(timeframedMarkets.startTime, now),
        gt(timeframedMarkets.endTime, now),
        sql`(
          jsonb_exists_any(${timeframedMarkets.affiliatedActorIds}, ${matchIds})
          OR jsonb_exists_any(${questionArcPlans.insiderActorIds}, ${matchIds})
          OR jsonb_exists_any(${questionArcPlans.deceiverActorIds}, ${matchIds})
        )`,
        notExists(
          dbWrite
            .select({ phase: npcMarketClues.phase })
            .from(npcMarketClues)
            .where(
              and(
                eq(npcMarketClues.questionId, questions.id),
                eq(npcMarketClues.phase, timeframedMarkets.arcState)
              )
            )
        )
      )
    )
    .orderBy(timeframedMarkets.endTime, timeframedMarkets.id)
    .limit(1);

  if (!candidate) return undefined;
  const { frame, questionId, question, marketId, plan, oldestPendingAt } =
    candidate;
  if (
    getCurrentArcState(frame.startTime, frame.endTime, frame.timeframe, now) !==
    frame.arcState
  ) {
    return undefined;
  }
  const actorId = eligibleActors(frame.affiliatedActorIds, plan).find((id) =>
    npcIds.has(id)
  );
  if (!actorId) return undefined;

  return {
    actorId,
    gameId,
    marketId,
    questionId,
    frameId: frame.id,
    phase: frame.arcState,
    phaseEnteredAt: frame.arcStateEnteredAt,
    question,
    oldestPendingAt,
  };
}

const laterPhases = new Set<ArcStateType>([
  'afternoon',
  'evening',
  'escalation',
  'crisis',
  'climax',
  'revelation',
  'resolving',
  'resolution',
]);

export function describeNpcMarketClue(clue: NpcMarketClue): string {
  const guidance = laterPhases.has(clue.phase)
    ? 'Explain one concrete public development to watch as the market approaches its close.'
    : 'Offer a tentative angle or open question that highlights the current uncertainty.';
  return `A market update is due for this question: ${JSON.stringify(clue.question)}.
Make your next POST a short observation in your own voice about that question. ${guidance} Use public developments supplied in your context, or identify an observable milestone if there is no corroborating update.
Do not invent events, sources or evidence, present a result as known, or reveal private information.`;
}

export async function getNpcMarketCluePublication(clue: NpcMarketClue) {
  if (process.env.DEPLOYMENT_ENV !== 'localnet') return undefined;
  const [published] = await dbWrite
    .select({ postId: posts.id, publishedAt: posts.timestamp })
    .from(npcMarketClues)
    .innerJoin(posts, eq(posts.id, npcMarketClues.postId))
    .where(
      and(
        eq(npcMarketClues.questionId, clue.questionId),
        eq(npcMarketClues.phase, clue.phase)
      )
    )
    .limit(1);
  return published;
}

type PublicationResult = 'published' | 'duplicate' | 'stale';

export async function publishNpcMarketClue(
  clue: NpcMarketClue,
  post: typeof posts.$inferInsert
): Promise<PublicationResult> {
  const actor = StaticDataRegistry.getActor(post.authorId);
  const gameStart = process.env.GAME_START?.toLowerCase();
  if (
    process.env.DEPLOYMENT_ENV !== 'localnet' ||
    gameStart === 'false' ||
    gameStart === '0' ||
    !actor ||
    actor.id !== clue.actorId
  ) {
    return 'stale';
  }

  return dbWrite.transaction(async (tx) => {
    // Match settlement's lock order: it locks Market before Question and arc.
    const [market] = await tx
      .select({
        resolved: markets.resolved,
        endDate: markets.endDate,
      })
      .from(markets)
      .where(
        and(eq(markets.id, clue.marketId), eq(markets.gameId, clue.gameId))
      )
      .for('share');
    if (!market || market.resolved) return 'stale';

    const [state] = await tx
      .select({
        frame: timeframedMarkets,
        question: {
          number: questions.questionNumber,
          text: questions.text,
          resolutionDate: questions.resolutionDate,
        },
        gameDay: games.currentDay,
      })
      .from(questions)
      .innerJoin(
        timeframedMarkets,
        eq(timeframedMarkets.questionId, questions.id)
      )
      .innerJoin(games, eq(games.id, clue.gameId))
      .where(
        and(
          eq(questions.id, clue.questionId),
          eq(marketIdForQuestion, clue.marketId),
          eq(questions.status, 'active'),
          eq(timeframedMarkets.id, clue.frameId),
          eq(timeframedMarkets.isActive, true),
          eq(timeframedMarkets.isResolved, false),
          eq(timeframedMarkets.arcState, clue.phase),
          eq(games.isRunning, true),
          eq(games.isContinuous, true)
        )
      )
      .for('share');
    if (
      !state ||
      state.question.text !== clue.question ||
      state.frame.arcStateEnteredAt.getTime() !== clue.phaseEnteredAt.getTime()
    ) {
      return 'stale';
    }

    const [plan] = await tx
      .select({
        insiderActorIds: questionArcPlans.insiderActorIds,
        deceiverActorIds: questionArcPlans.deceiverActorIds,
      })
      .from(questionArcPlans)
      .where(eq(questionArcPlans.questionId, clue.questionId))
      .orderBy(desc(questionArcPlans.createdAt), desc(questionArcPlans.id))
      .limit(1)
      .for('share');
    const now = new Date();
    if (
      now < state.frame.startTime ||
      now >= state.frame.endTime ||
      now >= state.question.resolutionDate ||
      now >= market.endDate ||
      getCurrentArcState(
        state.frame.startTime,
        state.frame.endTime,
        state.frame.timeframe,
        now
      ) !== clue.phase ||
      !isActiveHour(actor, now.getUTCHours(), state.gameDay) ||
      !eligibleActors(state.frame.affiliatedActorIds, plan ?? null).includes(
        actor.id
      )
    ) {
      return 'stale';
    }

    const identity = { questionId: clue.questionId, phase: clue.phase };
    const [claimed] = await tx
      .insert(npcMarketClues)
      .values(identity)
      .onConflictDoNothing()
      .returning({ questionId: npcMarketClues.questionId });
    if (!claimed) return 'duplicate';

    await tx.insert(posts).values({
      ...post,
      timestamp: now,
      createdAt: now,
      gameId: clue.gameId,
      dayNumber: state.gameDay,
      relatedQuestion: state.question.number,
    });
    await tx
      .update(npcMarketClues)
      .set({ postId: post.id })
      .where(
        and(
          eq(npcMarketClues.questionId, identity.questionId),
          eq(npcMarketClues.phase, identity.phase)
        )
      );
    return 'published';
  });
}
