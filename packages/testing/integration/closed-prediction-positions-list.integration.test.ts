/**
 * Closed prediction positions in the user positions list, against a real
 * database and the real positions route.
 *
 * The positions endpoint's own contract (user-positions.ts) is that
 * "resolved or closed positions belong to the closed view": the closed
 * query selects prediction positions with status 'closed' or 'resolved'.
 * A position reaches status 'closed' by selling all of its shares —
 * PredictionMarketService.sell writes shares: 0 with status 'closed' and
 * the realised PnL on the row. The snapshot then applied the open-view
 * dust filter (shares >= 0.01) to every status, so every sell-closed
 * prediction position was dropped from the closed view (and from
 * status=all): the wallet Positions tab's Closed Positions section never
 * showed a position the user closed by selling, and the section's
 * `total` undercounted. Resolved positions (which keep their shares)
 * and closed perp positions (which keep their size) were unaffected.
 *
 * These tests drive the real route handler. One test also drives the
 * real PredictionMarketService buy -> sell-all flow against the real
 * database so the sell-closed row is produced by the service itself.
 *
 * The only stub is the `server-only` marker package; the route, the
 * snapshot builder, the trading service, and the database run for real.
 *
 * Run with:
 *   DATABASE_URL=<disposable test db>
 *     bun test integration/closed-prediction-positions-list.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { PredictionDbAdapter } from '@feed/core/markets/prediction/adapters/drizzle/PredictionDbAdapter';
import { PredictionMarketService } from '@feed/core/markets/prediction/PredictionMarketService';
import {
  db,
  eq,
  inArray,
  markets,
  perpPositions,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const { GET } = await import(
  '../../../apps/web/src/app/api/markets/positions/[userId]/route'
);

type PredictionSection = {
  positions: Array<{ id: string; status: string; shares: number }>;
  total: number;
  hasMore: boolean;
  stats: { totalPositions: number };
};
type PerpSection = {
  positions: Array<{ id: string }>;
  total: number;
  hasMore: boolean;
};
type SnapshotBody = {
  predictions: PredictionSection;
  perpetuals: PerpSection;
};

async function fetchSnapshot(query: string): Promise<SnapshotBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/markets/positions/${userId}?${query}`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as SnapshotBody;
}

let userId: string;
let posOpen: string;
let posResolved: string;
let posSoldWin: string;
let posSoldLoss: string;
let perpOpen: string;
let perpClosed: string;

// Rows this suite owns. Each array is populated only from the RETURNING
// result of a successful insert, never from the proposed ids: if an insert
// fails or an id collides with a pre-existing row, teardown must not delete
// a row this suite did not create. Price-history rows are keyed by market,
// not by row id — the service generates their ids — so they are cleaned
// by owned market id only, exactly the markets this suite created.
const allUserIds: string[] = [];
const allMarketIds: string[] = [];
const allPositionIds: string[] = [];
const allPerpPositionIds: string[] = [];

// Delete only owned rows, children before parents, so a partial setup
// (or a colliding id) can never wipe pre-existing rows. Idempotent: safe
// to run again after a test already called it.
async function cleanupOwned() {
  await db.delete(positions).where(inArray(positions.id, allPositionIds));
  await db
    .delete(perpPositions)
    .where(inArray(perpPositions.id, allPerpPositionIds));
  await db
    .delete(predictionPriceHistories)
    .where(inArray(predictionPriceHistories.marketId, allMarketIds));
  await db.delete(markets).where(inArray(markets.id, allMarketIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
}

async function insertMarket(resolved: boolean): Promise<string> {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(markets)
    .values({
      id,
      question: `Positions list test market ${id.slice(-6)}`,
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      resolved,
      resolution: resolved ? true : null,
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    })
    .returning({ id: markets.id });
  allMarketIds.push(row!.id);
  return row!.id;
}

async function insertPosition(values: {
  marketId: string;
  status: string;
  shares: string;
  pnl: string | null;
  outcome?: boolean | null;
  resolvedAt?: Date | null;
}): Promise<string> {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(positions)
    .values({
      id,
      userId,
      marketId: values.marketId,
      side: true,
      shares: values.shares,
      avgPrice: '0.5',
      amount: '5',
      status: values.status,
      pnl: values.pnl,
      outcome: values.outcome ?? null,
      resolvedAt: values.resolvedAt ?? null,
      updatedAt: new Date(),
    })
    .returning({ id: positions.id });
  allPositionIds.push(row!.id);
  return row!.id;
}

describe('user positions list — closed prediction positions', () => {
  beforeAll(async () => {
    userId = await generateSnowflakeId();
    const [createdUser] = await db
      .insert(users)
      .values({
        id: userId,
        username: `poslist_${userId.slice(-10)}`,
        updatedAt: new Date(),
      })
      .returning({ id: users.id });
    allUserIds.push(createdUser!.id);

    const openMarket = await insertMarket(false);
    const resolvedMarket = await insertMarket(true);
    const soldMarketA = await insertMarket(false);
    const soldMarketB = await insertMarket(false);

    posOpen = await insertPosition({
      marketId: openMarket,
      status: 'active',
      shares: '10',
      pnl: '0',
    });
    posResolved = await insertPosition({
      marketId: resolvedMarket,
      status: 'resolved',
      shares: '10',
      pnl: '5',
      outcome: true,
      resolvedAt: new Date(),
    });
    // The exact row PredictionMarketService.sell writes on a full sell:
    // shares zeroed, status 'closed', realised PnL kept on the row.
    posSoldWin = await insertPosition({
      marketId: soldMarketA,
      status: 'closed',
      shares: '0',
      pnl: '3.25',
    });
    posSoldLoss = await insertPosition({
      marketId: soldMarketB,
      status: 'closed',
      shares: '0',
      pnl: '-2',
    });

    perpOpen = await generateSnowflakeId();
    const [createdPerpOpen] = await db
      .insert(perpPositions)
      .values({
        id: perpOpen,
        userId,
        ticker: 'TESTOPEN',
        organizationId: 'org-test',
        side: 'long',
        entryPrice: 100,
        currentPrice: 110,
        size: 50,
        leverage: 2,
        liquidationPrice: 50,
        unrealizedPnL: 10,
        unrealizedPnLPercent: 20,
        lastUpdated: new Date(),
        closedAt: null,
      })
      .returning({ id: perpPositions.id });
    allPerpPositionIds.push(createdPerpOpen!.id);
    perpClosed = await generateSnowflakeId();
    const [createdPerpClosed] = await db
      .insert(perpPositions)
      .values({
        id: perpClosed,
        userId,
        ticker: 'TESTCLOSED',
        organizationId: 'org-test',
        side: 'long',
        entryPrice: 100,
        currentPrice: 120,
        size: 50,
        leverage: 2,
        liquidationPrice: 50,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        realizedPnL: 20,
        lastUpdated: new Date(),
        closedAt: new Date(),
      })
      .returning({ id: perpPositions.id });
    allPerpPositionIds.push(createdPerpClosed!.id);
  });

  afterAll(async () => {
    await cleanupOwned();
  });

  it('closed view lists positions closed by selling, not only resolved ones', async () => {
    const body = await fetchSnapshot('status=closed&type=prediction');
    const ids = body.predictions.positions.map((p) => p.id);
    expect(ids).toContain(posResolved);
    expect(ids).toContain(posSoldWin);
    expect(ids).toContain(posSoldLoss);
    expect(ids).not.toContain(posOpen);
    expect(body.predictions.total).toBe(3);
    expect(body.predictions.stats.totalPositions).toBe(3);
  });

  it('status=all also includes sell-closed positions', async () => {
    const body = await fetchSnapshot('status=all&type=prediction');
    const ids = body.predictions.positions.map((p) => p.id);
    expect(ids).toContain(posOpen);
    expect(ids).toContain(posResolved);
    expect(ids).toContain(posSoldWin);
    expect(ids).toContain(posSoldLoss);
    expect(body.predictions.total).toBe(4);
  });

  it('open view still shows only the held position (guard)', async () => {
    const body = await fetchSnapshot('status=open');
    const predIds = body.predictions.positions.map((p) => p.id);
    expect(predIds).toEqual([posOpen]);
    const perpIds = body.perpetuals.positions.map((p) => p.id);
    expect(perpIds).toEqual([perpOpen]);
  });

  it('closed perp positions still listed (guard)', async () => {
    const body = await fetchSnapshot('status=closed&type=perp');
    const ids = body.perpetuals.positions.map((p) => p.id);
    expect(ids).toEqual([perpClosed]);
    expect(body.perpetuals.total).toBe(1);
  });

  it('a position sold through the real trading service appears in the closed view', async () => {
    const service = new PredictionMarketService({
      db: new PredictionDbAdapter(),
      wallet: {
        debit: async () => {},
        credit: async () => {},
        recordPnL: async () => {},
        getBalance: async () => ({ balance: 100000 }),
      },
      fees: {
        tradingFeeRate: 0,
        platformShare: 0,
        referrerShare: 0,
        minFeeAmount: 0,
      },
    });

    const marketId = await generateSnowflakeId();
    const [createdMarket] = await db
      .insert(markets)
      .values({
        id: marketId,
        question: `Sell-through test market ${marketId.slice(-6)}`,
        yesShares: '10000',
        noShares: '10000',
        liquidity: '20000',
        resolved: false,
        resolution: null,
        endDate: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    allMarketIds.push(createdMarket!.id);

    const bought = await service.buy({
      userId,
      marketId,
      side: 'yes',
      amount: 100,
    });
    const sold = await service.sell({
      userId,
      marketId,
      shares: bought.shares,
    });
    expect(sold.positionClosed).toBe(true);
    // The service owns this row's id; record it so teardown deletes the
    // row it created and nothing else.
    allPositionIds.push(bought.positionId);

    const [row] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, bought.positionId));
    expect(row?.status).toBe('closed');
    expect(Number(row?.shares)).toBe(0);

    const body = await fetchSnapshot('status=closed&type=prediction');
    const ids = body.predictions.positions.map((p) => p.id);
    expect(ids).toContain(bought.positionId);
  });

  it('cleanup removes only rows this suite created', async () => {
    // Pre-existing rows this suite did not create — including a price
    // history row for a foreign market, the case a partial setup or an
    // id collision would have wiped when teardown deleted by proposed
    // ids or by user id. None of these ids are in the owned arrays, so
    // the shared cleanup must leave every one of them untouched.
    const sentinelUserId = await generateSnowflakeId();
    const sentinelMarketId = await generateSnowflakeId();
    const sentinelPositionId = await generateSnowflakeId();
    const sentinelPerpId = await generateSnowflakeId();
    const sentinelHistoryId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(users).values({
      id: sentinelUserId,
      username: `poslist-sentinel-${sentinelUserId.slice(-10)}`,
      updatedAt: now,
    });
    await db.insert(markets).values({
      id: sentinelMarketId,
      question: 'Sentinel market',
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      resolved: false,
      resolution: null,
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: now,
    });
    await db.insert(positions).values({
      id: sentinelPositionId,
      userId: sentinelUserId,
      marketId: sentinelMarketId,
      side: true,
      shares: '10',
      avgPrice: '0.5',
      amount: '5',
      status: 'active',
      pnl: '0',
      outcome: null,
      resolvedAt: null,
      updatedAt: now,
    });
    await db.insert(perpPositions).values({
      id: sentinelPerpId,
      userId: sentinelUserId,
      ticker: 'TESTSENTINEL',
      organizationId: 'org-test',
      side: 'long',
      entryPrice: 100,
      currentPrice: 110,
      size: 50,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 10,
      unrealizedPnLPercent: 20,
      lastUpdated: now,
      closedAt: null,
    });
    await db.insert(predictionPriceHistories).values({
      id: sentinelHistoryId,
      marketId: sentinelMarketId,
      yesPrice: 0.5,
      noPrice: 0.5,
      yesShares: '500',
      noShares: '500',
      liquidity: '1000',
      eventType: 'sentinel',
      source: 'test',
      createdAt: now,
    });

    await cleanupOwned();

    // Owned rows are gone...
    expect(
      await db
        .select()
        .from(positions)
        .where(inArray(positions.id, allPositionIds))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(perpPositions)
        .where(inArray(perpPositions.id, allPerpPositionIds))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(predictionPriceHistories)
        .where(inArray(predictionPriceHistories.marketId, allMarketIds))
    ).toEqual([]);
    expect(
      await db.select().from(markets).where(inArray(markets.id, allMarketIds))
    ).toEqual([]);
    expect(
      await db.select().from(users).where(inArray(users.id, allUserIds))
    ).toEqual([]);
    // ...but every pre-existing row survives.
    expect(
      await db.select().from(users).where(eq(users.id, sentinelUserId))
    ).toHaveLength(1);
    expect(
      await db.select().from(markets).where(eq(markets.id, sentinelMarketId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(positions)
        .where(eq(positions.id, sentinelPositionId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, sentinelPerpId))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(predictionPriceHistories)
        .where(eq(predictionPriceHistories.id, sentinelHistoryId))
    ).toHaveLength(1);

    // Remove the sentinel rows this test itself created.
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, sentinelHistoryId));
    await db.delete(positions).where(eq(positions.id, sentinelPositionId));
    await db.delete(perpPositions).where(eq(perpPositions.id, sentinelPerpId));
    await db.delete(markets).where(eq(markets.id, sentinelMarketId));
    await db.delete(users).where(eq(users.id, sentinelUserId));
  });
});
