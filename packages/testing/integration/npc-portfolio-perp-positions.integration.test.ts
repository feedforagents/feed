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
  gameOnboarding,
  inArray,
  perpPositions,
  poolPositions,
  pools,
  userPnLSnapshots,
  users,
  whitelist,
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
// One documentation-range IPv6 per fixture, so this file's requests do not
// share CI's anonymous rate-limit bucket with unrelated route tests (the
// limiter stays enabled — see the 429 note on fetchPortfolio).
let clientIp: string;

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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchPortfolio() {
  // Per-run client identity: without it every call in the whole CI run
  // shares the anonymous bucket (30 requests/min), so the mirror and
  // closed-position cases below hit a 429 whose error body has no
  // `positions` to read. The limiter itself is left on.
  const request = new NextRequest(
    new Request(`http://localhost/api/npc/${actorId}/portfolio`, {
      headers: { 'x-forwarded-for': clientIp },
    })
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

  // Keep real rate limits enabled without sharing CI's anonymous bucket
  // with unrelated route tests. Use one documentation-range IP per fixture.
  // 1661 is unused by the sibling fixtures (1656, 1660).
  clientIp = `2001:db8:1661:0:${BigInt(actorId)
    .toString(16)
    .padStart(16, '0')
    .match(/.{4}/g)!
    .join(':')}`;

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
      .where(inArray(perpPositions.id, [perpPositionId, closedPerpPositionId]))
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

/**
 * Delete only rows this file proved it inserted (RETURNING ids above),
 * positions before their owner rows, so a partial setup failure leaves
 * pre-existing data untouched.
 *
 * GameOnboarding, UserPnLSnapshot and Whitelist all reference users.id
 * ON DELETE CASCADE. A row in one of those tables that this file did not
 * create may still reference the owned user — attached after setup by
 * another flow — and deleting the user would silently delete that foreign
 * row too. Refuse before deleting anything, so the foreign row and every
 * owned row survive unchanged.
 *
 * The check and the deletes run in one short transaction, and the owned
 * user row is locked (FOR UPDATE) before the checks. A concurrent child
 * insert takes a FOR KEY SHARE lock on the user row for its FK check, so
 * it either commits before we lock (and our checks see it) or waits until
 * we commit or roll back (and then fails the FK check, or proceeds after a
 * refusal rollback). Either way it cannot slip in between our checks and
 * the deletes. A refusal throws inside the transaction, so a partial
 * cleanup is never committed.
 */
async function cleanupOwnedFixtures(): Promise<void> {
  await db.transaction(async (tx) => {
    if (owned.user) {
      const [lockedUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, actorId))
        .limit(1)
        .for('update');
      if (lockedUser) {
        const [foreignOnboarding, foreignSnapshot, foreignWhitelist] =
          await Promise.all([
            tx
              .select({
                id: gameOnboarding.id,
                userId: gameOnboarding.userId,
              })
              .from(gameOnboarding)
              .where(eq(gameOnboarding.userId, actorId))
              .limit(1),
            tx
              .select({
                id: userPnLSnapshots.id,
                userId: userPnLSnapshots.userId,
              })
              .from(userPnLSnapshots)
              .where(eq(userPnLSnapshots.userId, actorId))
              .limit(1),
            tx
              .select({ id: whitelist.id, userId: whitelist.userId })
              .from(whitelist)
              .where(eq(whitelist.userId, actorId))
              .limit(1),
          ]);
        const foreign =
          foreignOnboarding[0] !== undefined
            ? { label: 'GameOnboarding', ...foreignOnboarding[0] }
            : foreignSnapshot[0] !== undefined
              ? { label: 'UserPnLSnapshot', ...foreignSnapshot[0] }
              : foreignWhitelist[0] !== undefined
                ? { label: 'Whitelist', ...foreignWhitelist[0] }
                : null;
        if (foreign) {
          throw new Error(
            `cleanup refused: ${foreign.label} ${foreign.id} still references owned user ${foreign.userId}`
          );
        }
      }
    }
    if (owned.poolPositionIds.length > 0) {
      await tx
        .delete(poolPositions)
        .where(inArray(poolPositions.id, owned.poolPositionIds));
    }
    if (owned.perpPositionIds.length > 0) {
      await tx
        .delete(perpPositions)
        .where(inArray(perpPositions.id, owned.perpPositionIds));
    }
    if (owned.pool) {
      await tx.delete(pools).where(eq(pools.id, actorId));
    }
    if (owned.actorState) {
      await tx.delete(actorState).where(eq(actorState.id, actorId));
    }
    if (owned.user) {
      await tx.delete(users).where(eq(users.id, actorId));
    }
  });
}

afterAll(async () => {
  await cleanupOwnedFixtures();
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
    const { status, body } = await fetchPortfolio();
    // Assert the status before reading the DTO: a 429 error body has no
    // `positions` to read.
    expect(status).toBe(200);
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
      const { status, body } = await fetchPortfolio();
      // Assert the status before reading the DTO: a 429 error body has no
      // `positions` to read.
      expect(status).toBe(200);
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
    const { status, body } = await fetchPortfolio();
    // Assert the status before reading the DTO: a 429 error body has no
    // `positions` to read.
    expect(status).toBe(200);
    const res = body as PortfolioResponse;
    const ids = res.positions.map((p) => p.id);
    expect(ids).toContain(predictionPositionId);
    expect(ids).not.toContain(closedPerpPositionId);
    expect(ids).not.toContain(closedPoolPositionId);
  });
});

describe('fixture ownership', () => {
  it('cleanup refuses when a foreign cascading child references the owned user', async () => {
    const foreignOnboardingId = await generateSnowflakeId();
    const now = new Date();
    try {
      // A GameOnboarding row created outside the fixture ledger,
      // referencing the owned fixture user. Its userId references users.id
      // ON DELETE CASCADE, so deleting the user would silently delete this
      // row too — the setup collision check cannot see this case, because
      // the row was inserted successfully after the fixture was set up.
      await db.insert(gameOnboarding).values({
        id: foreignOnboardingId,
        userId: actorId,
        currentStep: 'welcome',
        state: {
          completedSteps: [],
          currentStep: 'welcome',
          startedAt: now.toISOString(),
          completedAt: null,
          rewards: [],
        },
        isComplete: false,
        createdAt: now,
        updatedAt: now,
      });

      // Cleanup must refuse instead of deleting the user (and the row
      // with it).
      let refusal: unknown;
      try {
        await cleanupOwnedFixtures();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(
        `GameOnboarding ${foreignOnboardingId} still references owned user ${actorId}`
      );

      // The foreign row and the owned user row are both unchanged.
      const [survivingOnboarding] = await db
        .select()
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
      expect(survivingOnboarding).toBeDefined();
      expect(survivingOnboarding?.userId).toBe(actorId);
      expect(survivingOnboarding?.currentStep).toBe('welcome');
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, actorId));
      expect(survivingUser).toBeDefined();
      expect(survivingUser?.displayName).toBe('F42 Portfolio NPC');
      // A refusal must roll back the whole cleanup, not just skip the
      // user delete: the owned pool, actor state and positions survive too.
      const [survivingPool] = await db
        .select()
        .from(pools)
        .where(eq(pools.id, actorId));
      expect(survivingPool).toBeDefined();
      const [survivingActorState] = await db
        .select()
        .from(actorState)
        .where(eq(actorState.id, actorId));
      expect(survivingActorState).toBeDefined();
      const survivingPoolPositions = await db
        .select()
        .from(poolPositions)
        .where(inArray(poolPositions.id, owned.poolPositionIds));
      expect(survivingPoolPositions).toHaveLength(owned.poolPositionIds.length);
      const survivingPerpPositions = await db
        .select()
        .from(perpPositions)
        .where(inArray(perpPositions.id, owned.perpPositionIds));
      expect(survivingPerpPositions).toHaveLength(owned.perpPositionIds.length);
    } finally {
      // Remove the foreign row so the shared fixture's afterAll cleanup
      // can proceed.
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
    }
  });

  it('cleanup sees a child that commits after cleanup starts, instead of deleting across it', async () => {
    const foreignOnboardingId = await generateSnowflakeId();
    const now = new Date();
    let committedForeignOnboarding = false;
    let releaseInsert!: () => void;
    const insertReleased = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let signalInsertReady!: () => void;
    let rejectInsertReady!: (reason: unknown) => void;
    const insertReady = new Promise<void>((resolve, reject) => {
      signalInsertReady = resolve;
      rejectInsertReady = reject;
    });
    // A concurrent flow inserts a foreign GameOnboarding row in its own
    // transaction and holds it uncommitted. Its FK check takes a FOR KEY
    // SHARE lock on the owned user row, so cleanup's FOR UPDATE lock on
    // the same row waits until this transaction settles.
    const concurrentInsert = db
      .transaction(async (tx) => {
        await tx.insert(gameOnboarding).values({
          id: foreignOnboardingId,
          userId: actorId,
          currentStep: 'welcome',
          state: {
            completedSteps: [],
            currentStep: 'welcome',
            startedAt: now.toISOString(),
            completedAt: null,
            rewards: [],
          },
          isComplete: false,
          createdAt: now,
          updatedAt: now,
        });
        signalInsertReady();
        await insertReleased;
      })
      .then(() => {
        committedForeignOnboarding = true;
      });
    void concurrentInsert.catch(rejectInsertReady);
    let cleanupAttempt: Promise<void> | undefined;
    let refusal: unknown;
    try {
      // Wait for the insert before cleanup starts, so cleanup must wait
      // on the lock instead of racing ahead of it.
      await insertReady;
      cleanupAttempt = cleanupOwnedFixtures().catch((error: unknown) => {
        refusal = error;
      });
      // Give cleanup time to reach the user-row lock, then let the child
      // commit: cleanup's checks must see it and refuse.
      await sleep(300);
      releaseInsert();
      await concurrentInsert;
      await cleanupAttempt;
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(
        `GameOnboarding ${foreignOnboardingId} still references owned user ${actorId}`
      );
      // Nothing was deleted across the window: the owned rows all survive.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, actorId));
      expect(survivingUser).toBeDefined();
      const [survivingPool] = await db
        .select()
        .from(pools)
        .where(eq(pools.id, actorId));
      expect(survivingPool).toBeDefined();
      const survivingPerpPositions = await db
        .select()
        .from(perpPositions)
        .where(inArray(perpPositions.id, owned.perpPositionIds));
      expect(survivingPerpPositions).toHaveLength(owned.perpPositionIds.length);
    } finally {
      // Always release and drain both tasks before removing the foreign
      // row so the shared fixture's afterAll cleanup can proceed.
      releaseInsert();
      await Promise.allSettled([
        concurrentInsert,
        ...(cleanupAttempt ? [cleanupAttempt] : []),
      ]);
      if (committedForeignOnboarding) {
        await db
          .delete(gameOnboarding)
          .where(eq(gameOnboarding.id, foreignOnboardingId));
      }
    }
  });
});
