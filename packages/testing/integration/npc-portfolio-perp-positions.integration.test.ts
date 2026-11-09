/**
 * GET /api/npc/[actorId]/portfolio against a real database: the positions
 * list in the response must be the same set of open positions the portfolio
 * aggregates are computed from.
 *
 * NPC perp trades execute through PerpMarketService and live only in the
 * PerpPosition table (TradeExecutionService.openPerpPosition — no
 * poolPositions mirror), while NPC prediction trades are mirrored into
 * PoolPosition. NPCInvestmentManager.getPortfolioMetrics — the source of the
 * response's portfolio block — merges both tables: its positionCount counts
 * open perp positions and its unrealizedPnL includes theirs. The route's own
 * positions list read only PoolPosition, so an NPC holding an open perp
 * position got a response whose count and PnL totals described a position
 * that appeared nowhere in the list.
 *
 * The only stub is the `server-only` marker package; the route, the metrics
 * service, and every database query run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorState,
  db,
  eq,
  inArray,
  perpPositions,
  poolPositions,
  pools,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type PortfolioResponse = {
  success: boolean;
  portfolio: {
    totalValue: number;
    unrealizedPnL: number;
    realizedPnL: number;
    positionCount: number;
  };
  positions: Array<{
    id: string;
    marketType: string;
    ticker: string | null;
    marketId: string | null;
    side: string;
    size: number;
    unrealizedPnL: number;
  }>;
};

let GET: typeof import('../../../apps/web/src/app/api/npc/[actorId]/portfolio/route').GET;

// A snowflake id, so the route's identifier classification resolves it as a
// user id (the production shape for NPC user rows).
let actorId: string;
let predictionPositionId: string;
let perpPositionId: string;
let closedPerpPositionId: string;
let closedPoolPositionId: string;

// Ownership ledger: only rows this file actually inserted — proven by each
// INSERT's RETURNING clause — may be deleted in afterAll. Setup allocates
// every id before the first INSERT, so without this a failed setup (e.g. a
// collision with a pre-existing row) would still let afterAll wipe rows this
// file never owned.
const owned = {
  user: false,
  actorState: false,
  pool: false,
  poolPositionIds: [] as string[],
  perpPositionIds: [] as string[],
};

async function fetchPortfolio() {
  const request = new NextRequest(
    new Request(`http://localhost/api/npc/${actorId}/portfolio`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ actorId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PortfolioResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/npc/[actorId]/portfolio/route'
  ));

  [
    actorId,
    predictionPositionId,
    perpPositionId,
    closedPerpPositionId,
    closedPoolPositionId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60_000);

  // Collision control: refuse to run — and therefore to clean anything up —
  // if any fixture id already exists, so pre-existing data is never
  // overwritten by setup or deleted by teardown. The poolPositions check
  // also covers perpPositionId, which the mirror-guard test later reuses
  // as a legacy pool-mirror id.
  const [
    existingUsers,
    existingActorStates,
    existingPools,
    existingPoolPositions,
    existingPerpPositions,
  ] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1),
    db
      .select({ id: actorState.id })
      .from(actorState)
      .where(eq(actorState.id, actorId))
      .limit(1),
    db
      .select({ id: pools.id })
      .from(pools)
      .where(eq(pools.id, actorId))
      .limit(1),
    db
      .select({ id: poolPositions.id })
      .from(poolPositions)
      .where(
        inArray(poolPositions.id, [
          predictionPositionId,
          closedPoolPositionId,
          perpPositionId,
        ])
      )
      .limit(1),
    db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(
        inArray(perpPositions.id, [perpPositionId, closedPerpPositionId])
      )
      .limit(1),
  ]);
  if (
    existingUsers.length > 0 ||
    existingActorStates.length > 0 ||
    existingPools.length > 0 ||
    existingPoolPositions.length > 0 ||
    existingPerpPositions.length > 0
  ) {
    throw new Error(
      `fixture collision for actor ${actorId}: fixture ids already exist; refusing to overwrite pre-existing data`
    );
  }

  const insertedUser = await db
    .insert(users)
    .values({
      id: actorId,
      username: `f42npc-${actorId}`,
      displayName: 'F42 Portfolio NPC',
      isActor: true,
      updatedAt: now,
    })
    .returning({ id: users.id });
  owned.user = insertedUser.length > 0;

  const insertedActorState = await db
    .insert(actorState)
    .values({
      id: actorId,
      tradingBalance: '10000',
      reputationPoints: 1000,
      hasPool: true,
      updatedAt: now,
    })
    .returning({ id: actorState.id });
  owned.actorState = insertedActorState.length > 0;

  const insertedPool = await db
    .insert(pools)
    .values({
      id: actorId,
      npcActorId: actorId,
      name: 'F42 Portfolio Pool',
      totalValue: '10000',
      totalDeposits: '10000',
      availableBalance: '10000',
      lifetimePnL: '0',
      performanceFeeRate: 0.05,
      totalFeesCollected: '0',
      isActive: true,
      status: 'ACTIVE',
      updatedAt: now,
    })
    .returning({ id: pools.id });
  owned.pool = insertedPool.length > 0;

  // One open prediction position (mirrored into PoolPosition by the NPC
  // trade executor), unrealized +40.
  const insertedPrediction = await db
    .insert(poolPositions)
    .values({
      id: predictionPositionId,
      poolId: actorId,
      marketType: 'prediction',
      marketId: 'f42-market-1',
      side: 'YES',
      size: 200,
      entryPrice: 0.5,
      currentPrice: 0.6,
      unrealizedPnL: 40,
      openedAt: twoHoursAgo,
      closedAt: null,
      updatedAt: now,
    })
    .returning({ id: poolPositions.id });
  owned.poolPositionIds.push(...insertedPrediction.map((row) => row.id));

  // One open perp position. NPC perp trades are written only to
  // PerpPosition (userId = actor id); there is no PoolPosition row.
  const insertedPerp = await db
    .insert(perpPositions)
    .values({
      id: perpPositionId,
      userId: actorId,
      ticker: 'NVDAI',
      organizationId: 'f42-org',
      side: 'long',
      size: 5000,
      leverage: 5,
      entryPrice: 100,
      currentPrice: 110,
      liquidationPrice: 80,
      unrealizedPnL: 500,
      unrealizedPnLPercent: 10,
      fundingPaid: 0,
      openedAt: oneHourAgo,
      lastUpdated: now,
      closedAt: null,
    })
    .returning({ id: perpPositions.id });
  owned.perpPositionIds.push(...insertedPerp.map((row) => row.id));

  // Guards: closed positions feed realizedPnL but must not be listed.
  const insertedClosedPerp = await db
    .insert(perpPositions)
    .values({
      id: closedPerpPositionId,
      userId: actorId,
      ticker: 'NVDAI',
      organizationId: 'f42-org',
      side: 'long',
      size: 3000,
      leverage: 5,
      entryPrice: 90,
      currentPrice: 95,
      liquidationPrice: 70,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: twoHoursAgo,
      lastUpdated: now,
      closedAt: oneHourAgo,
      realizedPnL: 250,
    })
    .returning({ id: perpPositions.id });
  owned.perpPositionIds.push(...insertedClosedPerp.map((row) => row.id));

  const insertedClosedPool = await db
    .insert(poolPositions)
    .values({
      id: closedPoolPositionId,
      poolId: actorId,
      marketType: 'prediction',
      marketId: 'f42-market-2',
      side: 'NO',
      size: 100,
      entryPrice: 0.4,
      currentPrice: 0.4,
      unrealizedPnL: 0,
      openedAt: twoHoursAgo,
      closedAt: oneHourAgo,
      realizedPnL: -30,
      updatedAt: now,
    })
    .returning({ id: poolPositions.id });
  owned.poolPositionIds.push(...insertedClosedPool.map((row) => row.id));
});

afterAll(async () => {
  // Delete only rows this file proved it inserted (RETURNING ids above),
  // positions before their owner rows, so a partial setup failure leaves
  // pre-existing data untouched.
  if (owned.poolPositionIds.length > 0) {
    await db
      .delete(poolPositions)
      .where(inArray(poolPositions.id, owned.poolPositionIds));
  }
  if (owned.perpPositionIds.length > 0) {
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.id, owned.perpPositionIds));
  }
  if (owned.pool) {
    await db.delete(pools).where(eq(pools.id, actorId));
  }
  if (owned.actorState) {
    await db.delete(actorState).where(eq(actorState.id, actorId));
  }
  if (owned.user) {
    await db.delete(users).where(eq(users.id, actorId));
  }
});

describe('NPC portfolio detail: listed positions match the aggregates', () => {
  it('lists every open position the aggregates count, including perps', async () => {
    const { status, body } = await fetchPortfolio();
    expect(status).toBe(200);
    const res = body as PortfolioResponse;

    // Aggregates merge both position tables: 1 prediction + 1 perp open.
    expect(res.portfolio.positionCount).toBe(2);
    expect(res.portfolio.unrealizedPnL).toBeCloseTo(540, 6);
    expect(res.portfolio.realizedPnL).toBeCloseTo(220, 6);

    // The list must be that same set — no counted-but-invisible positions.
    expect(res.positions).toHaveLength(res.portfolio.positionCount);
    const listedUnrealized = res.positions.reduce(
      (sum, p) => sum + p.unrealizedPnL,
      0
    );
    expect(listedUnrealized).toBeCloseTo(res.portfolio.unrealizedPnL, 6);
  });

  it('shows the open perp position with its market fields', async () => {
    const { body } = await fetchPortfolio();
    const res = body as PortfolioResponse;
    const perp = res.positions.find((p) => p.id === perpPositionId);
    expect(perp).toBeDefined();
    expect(perp?.marketType).toBe('perp');
    expect(perp?.ticker).toBe('NVDAI');
    expect(perp?.side).toBe('long');
    expect(perp?.size).toBe(5000);
    // Newest first across both tables: the perp opened an hour ago, the
    // prediction position two hours ago.
    expect(res.positions[0]?.id).toBe(perpPositionId);
  });

  it('lists a legacy pool-mirrored perp only once (dedupe guard)', async () => {
    // Legacy rows duplicated a PerpPosition into PoolPosition under the
    // same id; the metrics skip the pool copy, and so must the list.
    // Same ownership discipline as setup: delete the mirror row only if
    // this test's own insert returned it, never a pre-existing row.
    let insertedMirror: Array<{ id: string }> = [];
    try {
      insertedMirror = await db
        .insert(poolPositions)
        .values({
          id: perpPositionId,
          poolId: actorId,
          marketType: 'perp',
          ticker: 'NVDAI',
          marketId: null,
          side: 'long',
          size: 5000,
          entryPrice: 100,
          currentPrice: 110,
          unrealizedPnL: 500,
          leverage: 5,
          openedAt: new Date(Date.now() - 60 * 60_000),
          closedAt: null,
          updatedAt: new Date(),
        })
        .returning({ id: poolPositions.id });
      const { body } = await fetchPortfolio();
      const res = body as PortfolioResponse;
      expect(res.positions).toHaveLength(res.portfolio.positionCount);
      expect(res.positions.filter((p) => p.id === perpPositionId)).toHaveLength(
        1
      );
    } finally {
      if (insertedMirror.length > 0) {
        await db
          .delete(poolPositions)
          .where(eq(poolPositions.id, perpPositionId));
      }
    }
  });

  it('keeps closed positions out of the list (guards)', async () => {
    const { body } = await fetchPortfolio();
    const res = body as PortfolioResponse;
    const ids = res.positions.map((p) => p.id);
    expect(ids).toContain(predictionPositionId);
    expect(ids).not.toContain(closedPerpPositionId);
    expect(ids).not.toContain(closedPoolPositionId);
  });
});
