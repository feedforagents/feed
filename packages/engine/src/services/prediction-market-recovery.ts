import {
  and,
  dbWrite,
  desc,
  eq,
  isNull,
  markets,
  ownsPredictionRecoveryLease,
  type PredictionResolutionDraft,
  posts,
  predictionResolutionWork,
  questions,
  worldEvents,
} from '@feed/db';
import { logger, type Question, type SelectedActor } from '@feed/shared';
import { resolveQuestionPayouts } from '../game-tick';
import type { FeedLLMClient } from '../llm/openai-client';
import { QuestionManager } from '../QuestionManager';
import { StaticDataRegistry } from './static-data-registry';

const RETRY_DELAY_MS = 120_000;

type ResolutionCandidate = {
  id: string;
  marketId: string;
  questionNumber: number;
  resolutionDate: Date;
  outcome: boolean;
};
type QuestionRow = typeof questions.$inferSelect;

function matchesSnapshot(
  snapshot: Pick<ResolutionCandidate, 'resolutionDate' | 'outcome'>,
  candidate: ResolutionCandidate
): boolean {
  return (
    snapshot.resolutionDate.getTime() === candidate.resolutionDate.getTime() &&
    snapshot.outcome === candidate.outcome
  );
}

function isReviewHeld(question: QuestionRow): boolean {
  return (
    question.requiresManualReview &&
    (question.resolutionReviewStatus === null ||
      question.resolutionReviewStatus === 'pending')
  );
}

async function saveWork(
  candidate: ResolutionCandidate,
  draft: PredictionResolutionDraft | null,
  nextAttemptAt: Date | null,
  leaseOwner: string
): Promise<boolean> {
  return dbWrite.transaction(async (tx) => {
    // Follow the payout transaction's lock order. An admin extension can
    // change the market deadline while inference is in progress.
    const [market] = await tx
      .select({ resolved: markets.resolved, endDate: markets.endDate })
      .from(markets)
      .where(eq(markets.id, candidate.marketId))
      .for('share');
    if (!market || market.resolved || market.endDate.getTime() > Date.now()) {
      return false;
    }
    if (!(await ownsPredictionRecoveryLease(tx, leaseOwner))) return false;
    const [question] = await tx
      .select()
      .from(questions)
      .where(eq(questions.id, candidate.id))
      .for('update');
    if (
      !question ||
      question.status !== 'active' ||
      !matchesSnapshot(question, candidate) ||
      isReviewHeld(question)
    ) {
      return false;
    }

    const work = {
      resolutionDate: candidate.resolutionDate,
      outcome: candidate.outcome,
      nextAttemptAt,
      draft,
    };
    await tx
      .insert(predictionResolutionWork)
      .values({ questionId: candidate.id, ...work })
      .onConflictDoUpdate({
        target: predictionResolutionWork.questionId,
        set: work,
      });

    if (
      draft?.requiresManualReview &&
      question.resolutionReviewStatus !== 'approved'
    ) {
      await tx
        .update(questions)
        .set({
          resolutionDescription: draft.description,
          resolutionConfidence: draft.confidence,
          resolutionProofUrl: null,
          requiresManualReview: true,
          resolutionReviewStatus: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(questions.id, candidate.id));
    }
    return true;
  });
}

async function generateDraft(
  manager: QuestionManager,
  question: Question,
  row: QuestionRow,
  gameState: { id: string; currentDay: number | null }
): Promise<PredictionResolutionDraft> {
  const articleId = row.resolutionProofUrl?.match(/^\/article\/([^/]+)$/)?.[1];
  const storedDescription = row.resolutionDescription?.trim();
  if (articleId && storedDescription) {
    const [post] = await dbWrite
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.id, articleId),
          eq(posts.type, 'proof'),
          isNull(posts.deletedAt)
        )
      );
    if (post) {
      const {
        timestamp: _timestamp,
        createdAt: _createdAt,
        ...storedPost
      } = post;
      return {
        post: storedPost,
        description: storedDescription,
        confidence: row.resolutionConfidence ?? 0,
        requiresManualReview: row.requiresManualReview,
        published: true,
      };
    }
  }

  const actors = StaticDataRegistry.getAllActors().flatMap(
    (actor): SelectedActor[] =>
      actor.tier === null
        ? []
        : [
            {
              ...actor,
              tier: actor.tier,
              role: actor.role ?? 'unknown',
              initialLuck:
                actor.initialLuck === 'low' || actor.initialLuck === 'high'
                  ? actor.initialLuck
                  : 'medium',
            },
          ]
  );
  const organizations = StaticDataRegistry.getAllOrganizations().map(
    (organization) => ({
      ...organization,
      initialPrice: organization.initialPrice ?? undefined,
    })
  );
  const recentEvents = storedDescription
    ? []
    : await dbWrite
        .select({
          description: worldEvents.description,
          relatedQuestion: worldEvents.relatedQuestion,
        })
        .from(worldEvents)
        .where(eq(worldEvents.relatedQuestion, row.questionNumber))
        .orderBy(desc(worldEvents.timestamp))
        .limit(3);
  const description =
    storedDescription ??
    (await manager.generateResolutionEvent(
      question,
      actors,
      organizations,
      [{ events: recentEvents.reverse() }],
      { recordWorldImpact: false }
    ));
  const result = await manager.generateProofForResolution(
    question,
    description,
    actors,
    organizations
  );
  if (result.proof?.type !== 'article') {
    throw new Error('Resolution proof article missing');
  }
  const article = result.proof.article;
  return {
    post: {
      id: article.id,
      type: 'proof',
      content: article.summary,
      fullContent: article.content,
      articleTitle: article.title,
      authorId: article.authorOrgId,
      gameId: gameState.id,
      dayNumber: gameState.currentDay ?? 1,
      category: article.category,
      sentiment: article.sentiment,
      slant: article.slant,
      biasScore: article.biasScore,
      relatedQuestion: row.questionNumber,
    },
    description,
    confidence: result.confidence,
    requiresManualReview: result.requiresManualReview,
    recordWorldImpact: !storedDescription,
  };
}

export async function processPredictionMarketRecovery(
  candidate: ResolutionCandidate,
  llmClient: FeedLLMClient,
  gameState: { id: string; currentDay: number | null },
  leaseOwner: string
): Promise<'settled' | 'pending' | 'skipped'> {
  const [row] = await dbWrite
    .select()
    .from(questions)
    .where(eq(questions.id, candidate.id));
  if (
    !row ||
    row.status !== 'active' ||
    !matchesSnapshot(row, candidate) ||
    row.resolutionDate.getTime() > Date.now() ||
    isReviewHeld(row)
  ) {
    return 'skipped';
  }

  const question: Question = {
    id: row.questionNumber,
    text: row.text,
    scenario: row.scenarioId,
    outcome: row.outcome,
    rank: row.rank,
    status: 'active',
  };
  const manager = new QuestionManager(llmClient);
  const [work] = await dbWrite
    .select()
    .from(predictionResolutionWork)
    .where(eq(predictionResolutionWork.questionId, candidate.id));
  let draft = work && matchesSnapshot(work, candidate) ? work.draft : null;

  try {
    if (!draft) {
      draft = await generateDraft(manager, question, row, gameState);
      if (!(await saveWork(candidate, draft, null, leaseOwner)))
        return 'skipped';
    }
    if (
      draft.requiresManualReview &&
      row.resolutionReviewStatus !== 'approved'
    ) {
      return 'pending';
    }
    const settled = await resolveQuestionPayouts(row.questionNumber, {
      marketId: candidate.marketId,
      resolutionDate: candidate.resolutionDate,
      outcome: candidate.outcome,
      description: draft.description,
      confidence: draft.confidence,
      proof: draft.post,
      published: draft.published,
      leaseOwner,
    });
    if (!settled) {
      const deferred = await saveWork(
        candidate,
        draft,
        new Date(Date.now() + RETRY_DELAY_MS),
        leaseOwner
      );
      return deferred ? 'pending' : 'skipped';
    }
  } catch (error) {
    logger.warn(
      'Prediction resolution is pending retry',
      {
        questionNumber: candidate.questionNumber,
        errorName: error instanceof Error ? error.name : 'Error',
      },
      'MarketsRecovery'
    );
    await saveWork(
      candidate,
      draft,
      new Date(Date.now() + RETRY_DELAY_MS),
      leaseOwner
    );
    return 'pending';
  }

  if (draft.recordWorldImpact) {
    // A fact based on the hidden outcome may only appear after settlement.
    await manager
      .assessAndRecordWorldImpact(question, draft.description)
      .catch((error: Error) => {
        logger.warn(
          'Could not record prediction resolution world impact',
          { questionNumber: candidate.questionNumber, errorName: error.name },
          'MarketsRecovery'
        );
      });
  }
  return 'settled';
}
