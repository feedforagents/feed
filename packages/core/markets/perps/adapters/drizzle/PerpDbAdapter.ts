import {
  type PerpPosition as DbPerpPosition,
  db as defaultDb,
  organizations,
  perpMarketSnapshots,
  perpPositions,
  type Transaction,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import type { InferInsertModel } from 'drizzle-orm';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import type {
  PerpDbPort,
  PerpMarketRecord,
  PerpPositionRecord,
  PerpSide,
} from '../../types';

type NewPerpPosition = InferInsertModel<typeof perpPositions>;
type DrizzleClient = typeof defaultDb | Transaction;

/**
 * Drizzle adapter for PerpDbPort.
 *
 * Notes:
 * - Uses PerpMarketSnapshot as single source for market-level stats.
 * - Generates IDs via snowflake when none provided.
 * - Supports transactions via constructor injection or transaction() method.
 */
export class PerpDbAdapter implements PerpDbPort {
  private readonly dbClient: DrizzleClient;

  constructor(dbClient?: DrizzleClient) {
    this.dbClient = dbClient ?? defaultDb;
  }

  /**
   * WHY no WHERE clause: countMarkets counts everything in perpMarketSnapshots,
   * matching what listMarkets() returns without options. The perps table has one
   * row per ticker (snapshot, not historical), so count = number of instruments.
   */
  async countMarkets(): Promise<number> {
    const [row] = await this.dbClient
      .select({ c: count() })
      .from(perpMarketSnapshots);
    return Number(row?.c ?? 0);
  }

  /**
   * WHY orderBy ticker ASC: Ensures deterministic page boundaries. Without a
   * stable sort, rows can shift between pages as prices change, causing
   * duplicates or gaps in paginated responses.
   */
  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]> {
    const base = this.dbClient
      .select({
        s: perpMarketSnapshots,
        orgName: organizations.name,
        orgImage: organizations.imageUrl,
      })
      .from(perpMarketSnapshots)
      .leftJoin(
        organizations,
        eq(perpMarketSnapshots.organizationId, organizations.id)
      )
      .orderBy(asc(perpMarketSnapshots.ticker));
    const rows =
      options?.limit != null
        ? await base.limit(options.limit).offset(options.offset ?? 0)
        : await base;
    if (rows.length === 0) return [];

    return rows.map(({ s, orgName, orgImage }) => ({
      ticker: s.ticker,
      organizationId: s.organizationId,
      name: orgName ?? s.name ?? undefined,
      imageUrl: orgImage ?? null,
      currentPrice: Number(s.currentPrice),
      price24hAgo: s.price24hAgo ? Number(s.price24hAgo) : undefined,
      change24h: Number(s.change24h ?? 0),
      changePercent24h: Number(s.changePercent24h ?? 0),
      high24h: Number(s.high24h),
      low24h: Number(s.low24h),
      volume24h: Number(s.volume24h ?? 0),
      openInterest: Number(s.openInterest ?? 0),
      fundingRate: (s.fundingRate ?? {
        ticker: s.ticker,
        rate: 0,
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0,
      }) as PerpMarketRecord['fundingRate'],
      maxLeverage: Number(s.maxLeverage ?? 20),
      minOrderSize: Number(s.minOrderSize ?? 10),
      bidPrice: s.bidPrice ? Number(s.bidPrice) : undefined,
      askPrice: s.askPrice ? Number(s.askPrice) : undefined,
      spreadBps: s.spreadBps ? Number(s.spreadBps) : undefined,
      bidDepth: s.bidDepth ? Number(s.bidDepth) : undefined,
      askDepth: s.askDepth ? Number(s.askDepth) : undefined,
      liquidityRegime:
        (s.liquidityRegime as PerpMarketRecord['liquidityRegime']) ?? undefined,
      quoteUpdatedAt: s.quoteUpdatedAt ?? undefined,
      markPrice: s.markPrice ? Number(s.markPrice) : undefined,
      indexPrice: s.indexPrice ? Number(s.indexPrice) : undefined,
    }));
  }

  async listOpenPositions(): Promise<PerpPositionRecord[]> {
    const positions = await this.dbClient
      .select()
      .from(perpPositions)
      .where(isNull(perpPositions.closedAt));

    return positions.map(mapPosition);
  }

  async getPositionById(id: string): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, id))
      .limit(1);
    return pos ? mapPosition(pos) : null;
  }

  async getOpenPositionsByUser(userId: string): Promise<PerpPositionRecord[]> {
    const positions = await this.dbClient
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, userId), isNull(perpPositions.closedAt))
      );
    return positions.map(mapPosition);
  }

  async getOpenPositionByUserAndTicker(
    userId: string,
    ticker: string
  ): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, userId),
          eq(perpPositions.ticker, ticker),
          isNull(perpPositions.closedAt)
        )
      )
      .limit(1);
    return pos ? mapPosition(pos) : null;
  }

  async lockOpenPositionById(id: string): Promise<PerpPositionRecord | null> {
    const [pos] = await this.dbClient
      .select()
      .from(perpPositions)
      .where(and(eq(perpPositions.id, id), isNull(perpPositions.closedAt)))
      .limit(1)
      .for('update');
    return pos ? mapPosition(pos) : null;
  }

  async upsertPosition(
    position: Omit<PerpPositionRecord, 'id'> & { id?: string }
  ): Promise<PerpPositionRecord> {
    const now = new Date();
    const id = position.id ?? (await generateSnowflakeId());
    const insert: NewPerpPosition = {
      id,
      userId: position.userId,
      ticker: position.ticker,
      organizationId: position.organizationId,
      side: position.side,
      entryPrice: position.entryPrice,
      currentPrice: position.currentPrice,
      size: position.size,
      leverage: position.leverage,
      liquidationPrice: position.liquidationPrice,
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLPercent: position.unrealizedPnLPercent,
      fundingPaid: position.fundingPaid,
      openedAt: position.openedAt ?? now,
      lastUpdated: position.lastUpdated ?? now,
      closedAt: position.closedAt ?? null,
      realizedPnL: position.realizedPnL ?? null,
    };

    const result = await this.dbClient
      .insert(perpPositions)
      .values(insert)
      .onConflictDoUpdate({
        target: perpPositions.id,
        set: { ...insert, openedAt: insert.openedAt },
      })
      .returning()
      .execute();

    return mapPosition(result[0]!);
  }

  async updateOpenPosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
        | 'fundingPaid'
        | 'liquidationPrice'
        | 'lastUpdated'
        | 'size'
        | 'entryPrice'
        | 'realizedPnL'
      >
    >
  ): Promise<void> {
    // Only set fields that are explicitly provided (not undefined)
    const setFields: Record<string, unknown> = {
      lastUpdated: updates.lastUpdated ?? new Date(),
    };
    if (updates.currentPrice !== undefined) {
      setFields.currentPrice = updates.currentPrice;
    }
    if (updates.unrealizedPnL !== undefined) {
      setFields.unrealizedPnL = updates.unrealizedPnL;
    }
    if (updates.unrealizedPnLPercent !== undefined) {
      setFields.unrealizedPnLPercent = updates.unrealizedPnLPercent;
    }
    if (updates.fundingPaid !== undefined) {
      setFields.fundingPaid = updates.fundingPaid;
    }
    if (updates.liquidationPrice !== undefined) {
      setFields.liquidationPrice = updates.liquidationPrice;
    }
    if (updates.size !== undefined) {
      setFields.size = updates.size;
    }
    if (updates.entryPrice !== undefined) {
      setFields.entryPrice = updates.entryPrice;
    }
    if (updates.realizedPnL !== undefined) {
      setFields.realizedPnL = updates.realizedPnL;
    }

    await this.dbClient
      .update(perpPositions)
      .set(setFields)
      .where(
        and(eq(perpPositions.id, positionId), isNull(perpPositions.closedAt))
      );
  }

  async closePosition(
    positionId: string,
    updates: Partial<
      Pick<
        PerpPositionRecord,
        | 'currentPrice'
        | 'closedAt'
        | 'realizedPnL'
        | 'unrealizedPnL'
        | 'unrealizedPnLPercent'
      >
    >
  ): Promise<boolean> {
    const closedAt = updates.closedAt ?? new Date();
    // Only set fields that are explicitly provided (not undefined)
    const setFields: Record<string, unknown> = {
      closedAt,
      lastUpdated: closedAt,
      unrealizedPnL: updates.unrealizedPnL ?? 0,
      unrealizedPnLPercent: updates.unrealizedPnLPercent ?? 0,
    };
    if (updates.currentPrice !== undefined) {
      setFields.currentPrice = updates.currentPrice;
    }
    if (updates.realizedPnL !== undefined) {
      setFields.realizedPnL = updates.realizedPnL;
    }

    const closed = await this.dbClient
      .update(perpPositions)
      .set(setFields)
      .where(
        and(eq(perpPositions.id, positionId), isNull(perpPositions.closedAt))
      )
      .returning({ id: perpPositions.id });
    return closed.length > 0;
  }

  async updateMarketStats(
    ticker: string,
    updates: Partial<
      Pick<
        PerpMarketRecord,
        | 'currentPrice'
        | 'price24hAgo'
        | 'change24h'
        | 'changePercent24h'
        | 'high24h'
        | 'low24h'
        | 'volume24h'
        | 'openInterest'
        | 'fundingRate'
        | 'bidPrice'
        | 'askPrice'
        | 'spreadBps'
        | 'bidDepth'
        | 'askDepth'
        | 'liquidityRegime'
        | 'quoteUpdatedAt'
        | 'markPrice'
        | 'indexPrice'
        | 'maxLeverage'
        | 'minOrderSize'
      >
    >
  ): Promise<void> {
    await this.withRowLockTransaction(async (client) => {
      const now = new Date();
      const current = await this.lockSnapshot(client, ticker);
      const rotation = computeSnapshotRotation(current, now, {
        currentPrice: updates.currentPrice,
      });

      // Write only explicitly requested fields (plus 24h rotation bookkeeping)
      // so concurrent writers updating other fields are not overwritten with
      // stale values.
      const setFields: Partial<typeof perpMarketSnapshots.$inferInsert> = {
        ...definedEntries(updates),
        price24hAgo: rotation.price24hAgo ?? updates.price24hAgo,
        price24hAgoUpdatedAt: rotation.price24hAgoUpdatedAt,
        metrics24hResetAt: rotation.metrics24hResetAt,
        updatedAt: now,
      };
      if (rotation.metricsReset) {
        setFields.high24h = updates.high24h ?? rotation.resetPrice;
        setFields.low24h = updates.low24h ?? rotation.resetPrice;
        setFields.volume24h = updates.volume24h ?? 0;
      }

      await client
        .update(perpMarketSnapshots)
        .set(definedEntries(setFields))
        .where(eq(perpMarketSnapshots.ticker, ticker));
    });
  }

  async applyMarketDeltas(
    ticker: string,
    deltas: { openInterest?: number; volume24h?: number }
  ): Promise<{ openInterest: number; volume24h: number }> {
    for (const [field, value] of Object.entries(deltas)) {
      if (value !== undefined && !Number.isFinite(value)) {
        throw new Error(`Invalid ${field} delta for ${ticker}: ${value}`);
      }
    }

    return this.withRowLockTransaction(async (client) => {
      const now = new Date();
      const current = await this.lockSnapshot(client, ticker);
      const rotation = computeSnapshotRotation(current, now, {});

      const openInterest = Math.max(
        0,
        current.openInterest + (deltas.openInterest ?? 0)
      );
      const volume24h =
        (rotation.metricsReset ? 0 : current.volume24h) +
        (deltas.volume24h ?? 0);

      await client
        .update(perpMarketSnapshots)
        .set({
          openInterest,
          volume24h,
          price24hAgo: rotation.price24hAgo ?? current.price24hAgo,
          price24hAgoUpdatedAt: rotation.price24hAgoUpdatedAt,
          metrics24hResetAt: rotation.metrics24hResetAt,
          ...(rotation.metricsReset
            ? { high24h: rotation.resetPrice, low24h: rotation.resetPrice }
            : {}),
          updatedAt: now,
        })
        .where(eq(perpMarketSnapshots.ticker, ticker));

      return { openInterest, volume24h };
    });
  }

  /**
   * Run `fn` in a transaction so a SELECT ... FOR UPDATE row lock is held
   * until the write commits. Reuses the current transaction if already in one.
   */
  private async withRowLockTransaction<T>(
    fn: (client: DrizzleClient) => Promise<T>
  ): Promise<T> {
    if (this.dbClient !== defaultDb) {
      return fn(this.dbClient);
    }
    return defaultDb.transaction((txClient) => fn(txClient));
  }

  private async lockSnapshot(client: DrizzleClient, ticker: string) {
    const [current] = await client
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker))
      .limit(1)
      .for('update');

    if (!current) {
      // Snapshot must be seeded separately - this method only updates existing snapshots
      // Use init-snapshots script in @feed/engine to seed from static organization data
      throw new Error(
        `Cannot update market snapshot for ${ticker}: snapshot not found. ` +
          'Run perp market seeding to create snapshots from static organization data.'
      );
    }
    return current;
  }

  /**
   * Execute operations within a transaction for atomicity.
   * Creates a new PerpDbAdapter bound to the transaction context.
   */
  async transaction<T>(fn: (tx: PerpDbPort) => Promise<T>): Promise<T> {
    // If already in a transaction, just use the current client
    if (this.dbClient !== defaultDb) {
      return fn(this);
    }

    return defaultDb.transaction(async (txClient) => {
      const txAdapter = new PerpDbAdapter(txClient);
      return fn(txAdapter);
    });
  }
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Compute 24h rotation bookkeeping for a snapshot row:
 * - price24hAgo rotates to the current price once per 24h
 * - high/low/volume reset once per 24h
 */
function computeSnapshotRotation(
  current: {
    currentPrice: number;
    price24hAgoUpdatedAt: Date | null;
    metrics24hResetAt: Date | null;
  },
  now: Date,
  updates: { currentPrice?: number }
): {
  price24hAgo: number | undefined;
  price24hAgoUpdatedAt: Date | null;
  metrics24hResetAt: Date | null;
  metricsReset: boolean;
  resetPrice: number;
} {
  const priceRotationDue =
    !current.price24hAgoUpdatedAt ||
    now.getTime() - current.price24hAgoUpdatedAt.getTime() >=
      TWENTY_FOUR_HOURS_MS;
  const metricsReset =
    !current.metrics24hResetAt ||
    now.getTime() - current.metrics24hResetAt.getTime() >= TWENTY_FOUR_HOURS_MS;

  return {
    price24hAgo: priceRotationDue ? current.currentPrice : undefined,
    price24hAgoUpdatedAt: priceRotationDue ? now : current.price24hAgoUpdatedAt,
    metrics24hResetAt: metricsReset ? now : current.metrics24hResetAt,
    metricsReset,
    resetPrice: updates.currentPrice ?? current.currentPrice,
  };
}

/** Drop undefined values so they are not written as NULL/defaults. */
function definedEntries<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

function mapPosition(pos: DbPerpPosition): PerpPositionRecord {
  return {
    id: pos.id,
    userId: pos.userId,
    ticker: pos.ticker,
    organizationId: pos.organizationId,
    side: pos.side as PerpSide,
    entryPrice: Number(pos.entryPrice),
    currentPrice: Number(pos.currentPrice),
    size: Number(pos.size),
    leverage: Number(pos.leverage),
    liquidationPrice: Number(pos.liquidationPrice),
    unrealizedPnL: Number(pos.unrealizedPnL),
    unrealizedPnLPercent: Number(pos.unrealizedPnLPercent),
    fundingPaid: Number(pos.fundingPaid),
    openedAt: new Date(pos.openedAt),
    lastUpdated: new Date(pos.lastUpdated),
    closedAt: pos.closedAt ? new Date(pos.closedAt) : undefined,
    realizedPnL: pos.realizedPnL !== null ? Number(pos.realizedPnL) : undefined,
  };
}
