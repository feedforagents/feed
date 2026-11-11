import {
  db,
  markets,
  positions,
  predictionPriceHistories,
  questions,
  type Transaction,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import type { InferInsertModel } from 'drizzle-orm';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { PredictionPricing } from '../../pricing';
import type {
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionPriceSnapshotRecord,
  PredictionSide,
  QuestionRecord,
} from '../../types';

type NewMarket = InferInsertModel<typeof markets>;
type NewPosition = InferInsertModel<typeof positions>;
type NewHistory = InferInsertModel<typeof predictionPriceHistories>;

const toSideBool = (side: PredictionSide) => side === 'yes';
const fromSideBool = (side: boolean): PredictionSide => (side ? 'yes' : 'no');
const MAX_SAFE_QUESTION_NUMBER = 2_147_483_647;

type DbClient = typeof db | Transaction;

const mapMarket = (m: typeof markets.$inferSelect): PredictionMarketRecord => {
  const extra = m as unknown as Partial<PredictionMarketRecord>;
  return {
    id: m.id,
    question: m.question,
    description: m.description,
    yesShares: Number(m.yesShares),
    noShares: Number(m.noShares),
    liquidity: Number(m.liquidity),
    endDate: m.endDate,
    resolved: m.resolved,
    resolution: m.resolution,
    resolutionProofUrl: extra.resolutionProofUrl ?? undefined,
    resolutionDescription: extra.resolutionDescription ?? undefined,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
};

const mapPosition = (
  p: typeof positions.$inferSelect
): PredictionPositionRecord => ({
  id: p.id,
  userId: p.userId,
  marketId: p.marketId,
  side: fromSideBool(p.side),
  shares: Number(p.shares),
  avgPrice: Number(p.avgPrice),
  cashCostBasis: p.cashCostBasis == null ? undefined : Number(p.cashCostBasis),
  status: p.status as PredictionPositionRecord['status'],
  outcome: p.outcome,
  pnl: p.pnl ? Number(p.pnl) : undefined,
  resolvedAt: p.resolvedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export class PredictionDbAdapter implements PredictionDbPort {
  constructor(private readonly client: DbClient = db) {}

  async getMarketById(id: string): Promise<PredictionMarketRecord | null> {
    const [m] = await this.client
      .select()
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);
    return m ? mapMarket(m) : null;
  }

  async getMarketsByIds(ids: string[]): Promise<PredictionMarketRecord[]> {
    if (ids.length === 0) return [];
    const ms = await this.client
      .select()
      .from(markets)
      .where(inArray(markets.id, ids));
    return ms.map(mapMarket);
  }

  /**
   * Count and list share the unresolved/deadline predicate shape. Each query
   * captures its own clock and snapshot, so a deadline crossing or concurrent
   * write can still change the result between calls. This is not full buy
   * eligibility: liquidity, funding and other checks remain on the buy path.
   * Equality matches assertMarketActiveForBuy, which rejects now > endDate.
   * Position exits use direct market lookup rather than this discovery list;
   * existing route caches can retain results from an earlier database fetch.
   */
  private openMarketPredicate() {
    return and(eq(markets.resolved, false), gte(markets.endDate, new Date()));
  }

  async countUnresolvedMarkets(): Promise<number> {
    const [row] = await this.client
      .select({ c: count() })
      .from(markets)
      .where(this.openMarketPredicate());
    return Number(row?.c ?? 0);
  }

  /**
   * WHY orderBy createdAt DESC: Newest markets first — matches user expectation
   * that recent questions appear at the top. Equal timestamps have no explicit
   * tie-breaker; separate requests are not an atomic pagination snapshot.
   */
  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PredictionMarketRecord[]> {
    const base = this.client
      .select()
      .from(markets)
      .where(this.openMarketPredicate())
      .orderBy(desc(markets.createdAt));
    const rows =
      options?.limit != null
        ? await base.limit(options.limit).offset(options.offset ?? 0)
        : await base;
    return rows.map(mapMarket);
  }

  async listUserPositions(userId: string): Promise<PredictionPositionRecord[]> {
    const rows = await this.client
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          // Only return active (open) positions with sellable shares
          eq(positions.status, 'active')
        )
      );
    // Filter out positions with negligible shares (closed but not marked resolved)
    return rows.map(mapPosition).filter((p) => p.shares >= 0.01);
  }

  async getQuestion(idOrNumber: string): Promise<QuestionRecord | null> {
    const [byId] = await this.client
      .select()
      .from(questions)
      .where(eq(questions.id, idOrNumber))
      .limit(1);
    if (byId) {
      return {
        id: byId.id,
        questionNumber: byId.questionNumber ?? undefined,
        text: byId.text,
        status: (byId.status as QuestionRecord['status']) ?? 'active',
        resolutionDate: byId.resolutionDate,
        resolvedOutcome: byId.resolvedOutcome,
        createdDate: byId.createdDate,
      };
    }

    if (!/^\d+$/.test(idOrNumber)) return null;
    const num = Number(idOrNumber);
    if (
      !Number.isSafeInteger(num) ||
      num < 0 ||
      num > MAX_SAFE_QUESTION_NUMBER
    ) {
      return null;
    }
    const qs = await this.client
      .select()
      .from(questions)
      .where(eq(questions.questionNumber, num))
      .limit(1);
    const q = qs[0];
    return q
      ? {
          id: q.id,
          questionNumber: q.questionNumber ?? undefined,
          text: q.text,
          status: (q.status as QuestionRecord['status']) ?? 'active',
          resolutionDate: q.resolutionDate,
          resolvedOutcome: q.resolvedOutcome,
          createdDate: q.createdDate,
        }
      : null;
  }

  async createMarketFromQuestion(
    question: QuestionRecord,
    initialLiquidity: number,
    options?: {
      description?: string | null;
      gameId?: string | null;
      dayNumber?: number | null;
      initialYesProbability?: number;
    }
  ): Promise<PredictionMarketRecord> {
    const now = new Date();
    const { yesShares, noShares } = PredictionPricing.initializeMarket(
      initialLiquidity,
      options?.initialYesProbability ?? 0.5
    );
    const data: NewMarket = {
      id: question.id,
      question: question.text,
      description: options?.description ?? null,
      gameId: options?.gameId ?? 'continuous',
      dayNumber: options?.dayNumber ?? null,
      yesShares: String(yesShares),
      noShares: String(noShares),
      liquidity: String(initialLiquidity),
      resolved: false,
      resolution: null,
      endDate: question.resolutionDate,
      createdAt: now,
      updatedAt: now,
      resolutionProofUrl: null,
      resolutionDescription: null,
    };

    // Publish the market and its question link together, including concurrent
    // creation attempts. A failed link must not leave an orphaned market.
    return this.client.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(markets)
        .values(data)
        .onConflictDoNothing()
        .returning();
      const market =
        inserted ??
        (
          await tx
            .select()
            .from(markets)
            .where(eq(markets.id, question.id))
            .limit(1)
        )[0];
      if (!market) throw new Error('Failed to create market');

      const [linked] = await tx
        .update(questions)
        .set({ marketId: market.id, updatedAt: now })
        .where(eq(questions.id, question.id))
        .returning({ id: questions.id });
      if (!linked) throw new Error(`Question not found: ${question.id}`);
      return mapMarket(market);
    });
  }

  async updateMarketState(
    marketId: string,
    updates: Partial<
      Pick<
        PredictionMarketRecord,
        | 'yesShares'
        | 'noShares'
        | 'liquidity'
        | 'resolved'
        | 'resolution'
        | 'resolutionProofUrl'
        | 'resolutionDescription'
      >
    >
  ): Promise<PredictionMarketRecord> {
    const [updated] = await this.client
      .update(markets)
      .set({
        yesShares:
          updates.yesShares != null ? String(updates.yesShares) : undefined,
        noShares:
          updates.noShares != null ? String(updates.noShares) : undefined,
        liquidity:
          updates.liquidity != null ? String(updates.liquidity) : undefined,
        resolved: updates.resolved ?? undefined,
        // Nullable columns: undefined leaves the column unchanged, an explicit
        // null clears it.
        resolution: updates.resolution,
        resolutionProofUrl: updates.resolutionProofUrl,
        resolutionDescription: updates.resolutionDescription,
        updatedAt: new Date(),
      })
      .where(eq(markets.id, marketId))
      .returning();

    if (!updated) throw new Error(`Market not found: ${marketId}`);
    return mapMarket(updated);
  }

  async getPosition(
    userId: string,
    marketId: string,
    side: PredictionSide
  ): Promise<PredictionPositionRecord | null> {
    const [p] = await this.client
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.marketId, marketId),
          eq(positions.side, toSideBool(side))
        )
      )
      // If duplicates exist, prefer the active/most-recent position.
      .orderBy(
        desc(
          sql<number>`case when ${positions.status} = 'active' then 1 else 0 end`
        ),
        desc(positions.updatedAt),
        desc(positions.createdAt)
      )
      .limit(1);
    return p ? mapPosition(p) : null;
  }

  async upsertPosition(
    position: Omit<PredictionPositionRecord, 'id'> & { id?: string }
  ): Promise<PredictionPositionRecord> {
    const now = new Date();
    const id = position.id ?? (await generateSnowflakeId());
    const row: NewPosition = {
      id,
      userId: position.userId,
      marketId: position.marketId,
      side: toSideBool(position.side),
      shares: String(position.shares),
      avgPrice: String(position.avgPrice),
      outcome: position.outcome ?? null,
      pnl: position.pnl != null ? String(position.pnl) : null,
      questionId: null,
      resolvedAt: position.resolvedAt ?? null,
      status: position.status ?? 'active',
      createdAt: position.createdAt ?? now,
      updatedAt: position.updatedAt ?? now,
      amount: String(position.avgPrice * position.shares),
      cashCostBasis:
        position.cashCostBasis == null
          ? undefined
          : String(position.cashCostBasis),
    };

    const [result] = await this.client
      .insert(positions)
      .values(row)
      .onConflictDoUpdate({
        target: positions.id,
        set: {
          shares: row.shares,
          avgPrice: row.avgPrice,
          amount: row.amount,
          ...(row.cashCostBasis === undefined
            ? {}
            : { cashCostBasis: row.cashCostBasis }),
          pnl: row.pnl,
          outcome: row.outcome,
          resolvedAt: row.resolvedAt,
          status: row.status,
          updatedAt: now,
        },
      })
      .returning();

    if (!result) {
      throw new Error(
        `Failed to upsert position for user ${position.userId} market ${position.marketId}`
      );
    }
    return mapPosition(result);
  }

  async deletePosition(positionId: string): Promise<void> {
    await this.client.delete(positions).where(eq(positions.id, positionId));
  }

  async listPositionsForMarket(
    marketId: string
  ): Promise<PredictionPositionRecord[]> {
    const rows = await this.client
      .select()
      .from(positions)
      .where(eq(positions.marketId, marketId))
      .orderBy(positions.userId, positions.id);
    return rows.map(mapPosition);
  }

  async insertPriceSnapshot(
    snapshot: PredictionPriceSnapshotRecord
  ): Promise<void> {
    const row: NewHistory = {
      id: await generateSnowflakeId(),
      marketId: snapshot.marketId,
      yesPrice: snapshot.yesPrice,
      noPrice: snapshot.noPrice,
      yesShares: String(snapshot.yesShares),
      noShares: String(snapshot.noShares),
      liquidity: String(snapshot.liquidity),
      eventType: snapshot.eventType,
      source: snapshot.source,
      createdAt: snapshot.createdAt ?? new Date(),
    };
    await this.client.insert(predictionPriceHistories).values(row);
  }
}
