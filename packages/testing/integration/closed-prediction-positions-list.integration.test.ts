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
import { db, eq, markets, perpPositions, positions, users } from '@feed/db';
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
const marketIds: string[] = [];

async function insertMarket(resolved: boolean): Promise<string> {
  const id = await generateSnowflakeId();
  marketIds.push(id);
  await db.insert(markets).values({
    id,
    question: `Positions list test market ${id.slice(-6)}`,
    yesShares: '500',
    noShares: '500',
    liquidity: '1000',
    resolved,
    resolution: resolved ? true : null,
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  return id;
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
  await db.insert(positions).values({
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
  });
  return id;
}

describe('user positions list — closed prediction positions', () => {
  beforeAll(async () => {
    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      username: `poslist_${userId.slice(-10)}`,
      updatedAt: new Date(),
    });

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
    await db.insert(perpPositions).values({
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
    });
    perpClosed = await generateSnowflakeId();
    await db.insert(perpPositions).values({
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
    });
  });

  afterAll(async () => {
    await db.delete(positions).where(eq(positions.userId, userId));
    await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
    for (const marketId of marketIds) {
      await db.delete(markets).where(eq(markets.id, marketId));
    }
    await db.delete(users).where(eq(users.id, userId));
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
    marketIds.push(marketId);
    await db.insert(markets).values({
      id: marketId,
      question: `Sell-through test market ${marketId.slice(-6)}`,
      yesShares: '10000',
      noShares: '10000',
      liquidity: '20000',
      resolved: false,
      resolution: null,
      endDate: new Date(Date.now() + 86_400_000),
      updatedAt: new Date(),
    });

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
});
