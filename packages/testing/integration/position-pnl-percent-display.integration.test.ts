/**
 * Integration Test: Prediction Position PnL Percent Display Consistency
 *
 * One open prediction position is read on two web surfaces:
 *
 * - The wallet positions tab (and the markets terminal list and the sell
 *   confirmation) renders the canonical snapshot percent:
 *   unrealizedPnL / costBasis, where costBasis is the fee-grossed cash cost
 *   (shares * avgPrice / (1 - feeRate)) — the same cost basis the sell
 *   settlement records in the ledger (PredictionMarketService.sell).
 * - The feed "Open Positions" preview panel (PositionsPreviewPanel) and
 *   the position detail modal (PositionDetailModal) ignore the payload's
 *   unrealizedPnL/costBasis and recompute a price-change percent,
 *   (currentPrice - avgPrice) / avgPrice, which overstates every return
 *   by the buy fee (~+0.1pp) and flips the sign for small gains: a
 *   position that would settle at a loss reads as a green profit.
 *
 * This suite seeds real positions against a real database, reads the
 * real positions route the panel fetches, and pins the percent the
 * panel/modal display (predictionPositionPnLPercent, the helper both
 * components render) to the canonical snapshot percent in the payload.
 *
 * Case 1 (pool 49900/50100, 100 YES @ 0.5): the snapshot values the
 * position at a loss (unrealizedPnL < 0) while the legacy price-change
 * expression is positive (+0.04%) — the two screens disagree on the
 * sign. Case 2 (pool 9950/10050, 100 YES @ 0.5): both are positive but
 * the legacy expression overstates the return by ~0.1pp.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, eq, markets, positions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { predictionPositionPnLPercent } from '../../../apps/web/src/lib/markets/position-pnl';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

const owned = {
  users: new Set<string>(),
  markets: new Set<string>(),
  positions: new Set<string>(),
};

let userId = '';

interface PayloadPosition {
  id: string;
  marketId: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  costBasis: number;
  unrealizedPnL: number;
}

async function seedPosition(params: {
  yesShares: number;
  noShares: number;
  shares: number;
  avgPrice: number;
}): Promise<string> {
  const marketId = await generateSnowflakeId();
  await db.insert(markets).values({
    id: marketId,
    question: `f136-pnl-percent-${marketId}`,
    yesShares: String(params.yesShares),
    noShares: String(params.noShares),
    liquidity: '100000',
    resolved: false,
    endDate: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    updatedAt: new Date(),
  });
  owned.markets.add(marketId);

  const positionId = await generateSnowflakeId();
  await db.insert(positions).values({
    id: positionId,
    userId,
    marketId,
    side: true,
    shares: String(params.shares),
    avgPrice: String(params.avgPrice),
    status: 'active',
    updatedAt: new Date(),
  });
  owned.positions.add(positionId);
  return positionId;
}

async function fetchPositions(): Promise<PayloadPosition[]> {
  const res = await fetch(
    `${baseUrl}/api/markets/positions/${encodeURIComponent(userId)}`
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    predictions?: { positions?: PayloadPosition[] };
    data?: { predictions?: { positions?: PayloadPosition[] } };
  };
  return body.predictions?.positions ?? body.data?.predictions?.positions ?? [];
}

/** The percent the preview panel and detail modal rendered before the fix. */
function legacyPriceChangePercent(p: PayloadPosition): number {
  return ((p.currentPrice - p.avgPrice) / p.avgPrice) * 100;
}

/** The percent the wallet positions tab renders from the same payload. */
function canonicalSnapshotPercent(p: PayloadPosition): number {
  return p.costBasis !== 0 ? (p.unrealizedPnL / p.costBasis) * 100 : 0;
}

let flipPositionId = '';
let magnitudePositionId = '';

beforeAll(async () => {
  userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:f136-${userId}`,
    username: `f136-pnl-${userId}`,
    displayName: 'F136 PnL Percent',
    virtualBalance: '100000',
    totalDeposited: '100000',
    totalWithdrawn: '0',
    lifetimePnL: '0',
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    updatedAt: new Date(),
  });
  owned.users.add(userId);

  flipPositionId = await seedPosition({
    yesShares: 49900,
    noShares: 50100,
    shares: 100,
    avgPrice: 0.5,
  });
  magnitudePositionId = await seedPosition({
    yesShares: 9950,
    noShares: 10050,
    shares: 100,
    avgPrice: 0.5,
  });
});

afterAll(async () => {
  for (const id of owned.positions) {
    await db.delete(positions).where(eq(positions.id, id));
  }
  for (const id of owned.markets) {
    await db.delete(markets).where(eq(markets.id, id));
  }
  for (const id of owned.users) {
    await db.delete(users).where(eq(users.id, id));
  }
});

test('payload: the seeded loss position reads as a profit under the legacy panel/modal expression', async () => {
  const list = await fetchPositions();
  const p = list.find((row) => row.id === flipPositionId);
  expect(p).toBeDefined();
  if (!p) return;

  // Canonical snapshot (wallet tab, sell settlement): a loss.
  expect(p.unrealizedPnL).toBeLessThan(0);
  expect(canonicalSnapshotPercent(p)).toBeLessThan(0);
  // Legacy panel/modal expression on the same payload: a profit.
  expect(legacyPriceChangePercent(p)).toBeGreaterThan(0);
});

test('display: panel/modal percent equals the canonical snapshot percent (sign-flip case)', async () => {
  const list = await fetchPositions();
  const p = list.find((row) => row.id === flipPositionId);
  expect(p).toBeDefined();
  if (!p) return;

  const displayed = predictionPositionPnLPercent(p);
  expect(displayed).toBeCloseTo(canonicalSnapshotPercent(p), 10);
  expect(displayed).toBeLessThan(0);
});

test('display: panel/modal percent equals the canonical snapshot percent (magnitude case)', async () => {
  const list = await fetchPositions();
  const p = list.find((row) => row.id === magnitudePositionId);
  expect(p).toBeDefined();
  if (!p) return;

  const displayed = predictionPositionPnLPercent(p);
  expect(displayed).toBeCloseTo(canonicalSnapshotPercent(p), 10);
  // The legacy expression overstates this return by roughly the buy fee.
  expect(legacyPriceChangePercent(p) - displayed).toBeGreaterThan(0.05);
});
