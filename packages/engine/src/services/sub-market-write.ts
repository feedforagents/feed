import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  type ArcStateType,
  and,
  db,
  eq,
  isNotNull,
  isNull,
  type MarketCategory,
  questions,
  sql,
  timeframedMarkets,
} from '@feed/db';
import { mapGranularToDbTimeframe } from './market-timeframes';
import { getPredictionMarketInitialization } from './prediction-market-profiles';

export const MAX_SUB_MARKETS = 10;
export const SUB_MARKET_MIN_DURATION_MS = 15 * 60 * 1000;
const SUB_MARKET_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const SUB_MARKET_RESOLUTION_BUFFER_MS = 5 * 60 * 1000;

export function getMaxSubMarketDuration(
  parentEndTime: Date,
  now = Date.now()
): number | null {
  const remainingTimeMs =
    parentEndTime.getTime() - now - SUB_MARKET_RESOLUTION_BUFFER_MS;
  if (remainingTimeMs < SUB_MARKET_MIN_DURATION_MS) return null;
  return Math.min(remainingTimeMs, SUB_MARKET_MAX_DURATION_MS);
}

interface SubMarketWrite {
  parentId: string;
  category: MarketCategory;
  questionId: string;
  questionNumber: number;
  questionText: string;
  expectedOutcome: boolean;
  resolutionCriteria: string;
  timeframedMarketId: string;
  durationMs: number;
  timeframe: '15m' | '30m' | '1h';
  topic: { topicKey: string; topicLabel: string; date: Date };
  arcState: ArcStateType;
  affiliatedActorIds: string[];
  affiliatedOrgIds: string[];
  gameId: string;
  dayNumber: number | null;
}

/** Commit a prepared sub-market only while its parent and the global cap allow it. */
export async function writeSubMarket(input: SubMarketWrite): Promise<boolean> {
  return db.transaction(async (tx) => {
    // All sub-market creators must share this lock. Inference happens before it.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'markets-tick:sub-market-cap'}))`
    );
    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.isActive, true),
          isNotNull(timeframedMarkets.parentMarketId)
        )
      );
    if ((countResult?.count ?? 0) >= MAX_SUB_MARKETS) return false;

    const [parent] = await tx
      .select({
        endTime: timeframedMarkets.endTime,
        rootMarketId: timeframedMarkets.rootMarketId,
      })
      .from(timeframedMarkets)
      .where(
        and(
          eq(timeframedMarkets.id, input.parentId),
          eq(timeframedMarkets.isActive, true),
          eq(timeframedMarkets.isResolved, false),
          isNull(timeframedMarkets.parentMarketId)
        )
      )
      .for('update');
    if (!parent) return false;

    const now = new Date();
    const maxDuration = getMaxSubMarketDuration(parent.endTime, now.getTime());
    if (maxDuration === null || input.durationMs > maxDuration) return false;
    const resolutionDate = new Date(now.getTime() + input.durationMs);

    await tx.insert(questions).values({
      id: input.questionId,
      questionNumber: input.questionNumber,
      text: input.questionText,
      scenarioId: 1,
      outcome: input.expectedOutcome,
      rank: 1,
      resolutionDate,
      status: 'active',
      topicKey: input.topic.topicKey,
      topicLabel: input.topic.topicLabel,
      topicDate: input.topic.date,
      updatedAt: now,
    });

    const marketService = new PredictionMarketService({
      db: new PredictionDbAdapter(tx),
      wallet: {
        debit: async () => {},
        credit: async () => {},
        recordPnL: async () => {},
        getBalance: async () => ({ balance: 0 }),
      },
      fees: {
        tradingFeeRate: 0,
        platformShare: 0,
        referrerShare: 0,
        minFeeAmount: 0,
      },
    });
    const marketInitialization = getPredictionMarketInitialization({
      marketId: input.questionId,
      question: input.questionText,
      endDate: resolutionDate,
    });
    await marketService.ensureMarketExists({
      marketId: input.questionId,
      initialLiquidity: marketInitialization.initialLiquidity,
      initialYesProbability: marketInitialization.initialYesProbability,
      description: input.resolutionCriteria,
      gameId: input.gameId,
      dayNumber: input.dayNumber,
    });

    await tx.insert(timeframedMarkets).values({
      id: input.timeframedMarketId,
      questionId: input.questionId,
      timeframe: mapGranularToDbTimeframe(input.timeframe),
      granularTimeframe: input.timeframe,
      category: input.category,
      topicKey: input.topic.topicKey,
      topicLabel: input.topic.topicLabel,
      topicDate: input.topic.date,
      parentMarketId: input.parentId,
      rootMarketId: parent.rootMarketId ?? input.parentId,
      startTime: now,
      endTime: resolutionDate,
      arcState: input.arcState,
      arcStateEnteredAt: now,
      affiliatedActorIds: input.affiliatedActorIds,
      affiliatedOrgIds: input.affiliatedOrgIds,
    });
    return true;
  });
}
