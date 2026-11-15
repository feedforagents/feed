import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  and,
  balanceTransactions,
  db,
  eq,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  userPnLSnapshots,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { getHourBoundary, loadUserPnlHistory, snapshotAllUserPnlMetrics } =
  await import('../../../apps/web/src/lib/wallet/pnlHistory');
const { calculatePortfolioPnL } = await import(
  '@feed/engine/services/portfolio-pnl'
);
const { GET: getPnlHistory } = await import(
  '../../../apps/web/src/app/api/users/[userId]/pnl-history/route'
);

/**
 * The wallet P&L tab's live metrics (loadUserPnlHistory ->
 * loadCurrentUserPnlMetrics) must value an open perp position the same way
 * every other canonical P&L path does: the stored price-only
 * unrealizedPnL net of accrued funding. Funding settles at close
 * (PerpMarketService: realizedPnL = pnl - fundingPaid), so while a position
 * is open its unrealized P&L is overstated by exactly fundingPaid.
 *
 * Reader fixtures: two users with lifetimePnL 20 and one open perp each with
 * price PnL +100 — one owing funding (fundingPaid 12), one owed a rebate
 * (fundingPaid -5).
 *
 * The settlement cases below execute the real services (openPosition,
 * processFundingStep, applyPriceUpdates, closePosition) against the real
 * database and then read back through the P&L history HTTP route and the
 * persisted hourly snapshot. A real close charges a fee and fills at the
 * execution price, so continuity across the close is asserted against the
 * settlement the service actually recorded: funding must be deducted
 * exactly once (inside realizedPnL), never a second time by the reader.
 */

const now = new Date('2026-11-03T12:30:00.000Z');

type UserInsert = typeof users.$inferInsert;
type PositionInsert = typeof perpPositions.$inferInsert;
type OrganizationStateInsert = typeof organizationState.$inferInsert;
type PerpMarketSnapshotInsert = typeof perpMarketSnapshots.$inferInsert;

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway (for example on
 * an ID collision with a pre-existing row) can never delete data this
 * fixture did not create. Market rows are tracked per table: acquiring the
 * organizationState row never implies ownership of the snapshot row, or
 * vice versa.
 */
class OwnedFixtures {
  readonly userIds: string[] = [];
  readonly positionIds: string[] = [];
  readonly organizationStateIds: string[] = [];
  readonly marketSnapshotTickers: string[] = [];

  async insertUser(values: UserInsert): Promise<string> {
    const [row] = await db
      .insert(users)
      .values(values)
      .returning({ id: users.id });
    if (!row) throw new Error('user insert returned no row');
    this.userIds.push(row.id);
    return row.id;
  }

  async insertPosition(values: PositionInsert): Promise<string> {
    const [row] = await db
      .insert(perpPositions)
      .values(values)
      .returning({ id: perpPositions.id });
    if (!row) throw new Error('position insert returned no row');
    this.positionIds.push(row.id);
    return row.id;
  }

  async insertOrganizationState(
    values: OrganizationStateInsert
  ): Promise<string> {
    const [row] = await db
      .insert(organizationState)
      .values(values)
      .returning({ id: organizationState.id });
    if (!row) throw new Error('organizationState insert returned no row');
    this.organizationStateIds.push(row.id);
    return row.id;
  }

  async insertPerpMarketSnapshot(
    values: PerpMarketSnapshotInsert
  ): Promise<string> {
    const [row] = await db
      .insert(perpMarketSnapshots)
      .values(values)
      .returning({ ticker: perpMarketSnapshots.ticker });
    if (!row) throw new Error('perpMarketSnapshot insert returned no row');
    this.marketSnapshotTickers.push(row.ticker);
    return row.ticker;
  }

  async cleanup(): Promise<void> {
    if (this.userIds.length > 0) {
      await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.userId, this.userIds));
      await db
        .delete(pointsTransactions)
        .where(inArray(pointsTransactions.userId, this.userIds));
      await db
        .delete(userPnLSnapshots)
        .where(inArray(userPnLSnapshots.userId, this.userIds));
    }
    if (this.positionIds.length > 0) {
      await db
        .delete(perpPositions)
        .where(inArray(perpPositions.id, this.positionIds));
    }
    if (this.marketSnapshotTickers.length > 0) {
      await db
        .delete(perpMarketSnapshots)
        .where(inArray(perpMarketSnapshots.ticker, this.marketSnapshotTickers));
    }
    if (this.organizationStateIds.length > 0) {
      await db
        .delete(organizationState)
        .where(inArray(organizationState.id, this.organizationStateIds));
    }
    if (this.userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, this.userIds));
    }
    this.userIds.length = 0;
    this.positionIds.length = 0;
    this.organizationStateIds.length = 0;
    this.marketSnapshotTickers.length = 0;
  }
}

/** Market rows for one ticker, valued at the 100 base price. */
function marketOrganizationStateValues(
  ticker: string
): OrganizationStateInsert {
  return {
    id: ticker,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: new Date(),
  };
}

function marketSnapshotValues(ticker: string): PerpMarketSnapshotInsert {
  return {
    ticker,
    organizationId: ticker,
    currentPrice: 100,
    markPrice: 100,
    indexPrice: 100,
    high24h: 100,
    low24h: 100,
    openInterest: 0,
    volume24h: 0,
    bidDepth: 1000000,
    askDepth: 1000000,
    fundingRate: {
      ticker,
      rate: 0,
      predictedRate: 0,
      nextFundingTime: new Date().toISOString(),
    },
  };
}

/**
 * Insert both market rows for a ticker, registering ownership for each
 * table only after that table's INSERT ... RETURNING succeeds. If the
 * second insert fails, cleanup removes only the first row this call
 * created — never a pre-existing row in the other table.
 */
async function insertMarketRows(
  fixtures: OwnedFixtures,
  ticker: string
): Promise<void> {
  await fixtures.insertOrganizationState(marketOrganizationStateValues(ticker));
  await fixtures.insertPerpMarketSnapshot(marketSnapshotValues(ticker));
}

const readerFixtures = new OwnedFixtures();
let owingUserId: string;
let rebateUserId: string;

async function insertReaderFixture(
  fundingPaid: number
): Promise<{ positionId: string; userId: string }> {
  const userId = await generateSnowflakeId();
  await readerFixtures.insertUser({
    id: userId,
    username: `test-pnl-funding-${userId}`,
    displayName: 'P&L funding fixture',
    lifetimePnL: '20',
    updatedAt: now,
  });
  const positionId = await generateSnowflakeId();
  await readerFixtures.insertPosition({
    id: positionId,
    userId,
    organizationId: 'pnl-funding-fixture',
    ticker: 'FUND',
    side: 'long',
    entryPrice: 100,
    currentPrice: 110,
    size: 1000,
    leverage: 2,
    liquidationPrice: 50,
    unrealizedPnL: 100,
    unrealizedPnLPercent: 10,
    fundingPaid,
    lastUpdated: now,
  });
  return { positionId, userId };
}

beforeAll(async () => {
  owingUserId = (await insertReaderFixture(12)).userId;
  rebateUserId = (await insertReaderFixture(-5)).userId;
});

afterAll(async () => {
  await readerFixtures.cleanup();
});

describe('wallet P&L metrics for open perps with accrued funding', () => {
  it('nets funding owed out of unrealized and current P&L', async () => {
    const history = await loadUserPnlHistory({ userId: owingUserId, now });
    expect(history.metrics).toEqual({
      userId: owingUserId,
      lifetimePnL: 20,
      unrealizedPnL: 88,
      currentPnL: 108,
    });
    expect(history.points.at(-1)?.value).toBe(108);
  });

  it('nets a funding rebate into unrealized and current P&L', async () => {
    const history = await loadUserPnlHistory({ userId: rebateUserId, now });
    expect(history.metrics).toEqual({
      userId: rebateUserId,
      lifetimePnL: 20,
      unrealizedPnL: 105,
      currentPnL: 125,
    });
  });

  it('agrees with the canonical portfolio P&L perp leg', async () => {
    const snapshot = await calculatePortfolioPnL(owingUserId);
    expect(snapshot?.unrealizedPerpPnL).toBe(88);
    expect(snapshot?.totalUnrealizedPnL).toBe(88);
  });
});

describe('fixture ownership', () => {
  it('cleanup after failed setup never deletes rows the fixture did not create', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const victimUserId = await generateSnowflakeId();
      await victim.insertUser({
        id: victimUserId,
        username: `test-pnl-funding-victim-${victimUserId}`,
        displayName: 'Pre-existing user',
        lifetimePnL: '7',
        updatedAt: now,
      });
      const victimPositionId = await generateSnowflakeId();
      await victim.insertPosition({
        id: victimPositionId,
        userId: victimUserId,
        organizationId: 'pnl-funding-fixture',
        ticker: 'FUND',
        side: 'long',
        entryPrice: 100,
        currentPrice: 110,
        size: 1000,
        leverage: 2,
        liquidationPrice: 50,
        unrealizedPnL: 100,
        unrealizedPnLPercent: 10,
        fundingPaid: 3,
        lastUpdated: now,
      });

      // A user INSERT that collides with the pre-existing user fails and
      // registers no ownership.
      let userCollisionFailed = false;
      try {
        await attempt.insertUser({
          id: victimUserId,
          username: `test-pnl-funding-collision-${victimUserId}`,
          displayName: 'Collision attempt',
          lifetimePnL: '0',
          updatedAt: now,
        });
      } catch {
        userCollisionFailed = true;
      }
      expect(userCollisionFailed).toBe(true);
      expect(attempt.userIds).toEqual([]);

      // Partial setup: the user insert succeeds, then the position INSERT
      // collides with the pre-existing position and registers nothing.
      const attemptUserId = await generateSnowflakeId();
      await attempt.insertUser({
        id: attemptUserId,
        username: `test-pnl-funding-attempt-${attemptUserId}`,
        displayName: 'Partial setup',
        lifetimePnL: '0',
        updatedAt: now,
      });
      let positionCollisionFailed = false;
      try {
        await attempt.insertPosition({
          id: victimPositionId,
          userId: attemptUserId,
          organizationId: 'pnl-funding-fixture',
          ticker: 'FUND',
          side: 'long',
          entryPrice: 100,
          currentPrice: 110,
          size: 1000,
          leverage: 2,
          liquidationPrice: 50,
          unrealizedPnL: 100,
          unrealizedPnLPercent: 10,
          fundingPaid: 3,
          lastUpdated: now,
        });
      } catch {
        positionCollisionFailed = true;
      }
      expect(positionCollisionFailed).toBe(true);
      expect(attempt.positionIds).toEqual([]);

      await attempt.cleanup();

      // The pre-existing rows survive the failed setup's cleanup untouched.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, victimUserId));
      expect(survivingUser).toBeDefined();
      expect(Number(survivingUser?.lifetimePnL)).toBe(7);
      const [survivingPosition] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, victimPositionId));
      expect(survivingPosition).toBeDefined();
      expect(survivingPosition?.userId).toBe(victimUserId);
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});

describe('market fixture ownership', () => {
  it('cleanup after failed market setup never deletes pre-existing market rows', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const victimTicker = `PNLFLOWVICTIM${await generateSnowflakeId()}`;
      await insertMarketRows(victim, victimTicker);

      // Full collision: both market INSERTs fail on the pre-existing rows
      // and register no ownership.
      let orgStateCollisionFailed = false;
      try {
        await attempt.insertOrganizationState(
          marketOrganizationStateValues(victimTicker)
        );
      } catch {
        orgStateCollisionFailed = true;
      }
      expect(orgStateCollisionFailed).toBe(true);
      expect(attempt.organizationStateIds).toEqual([]);
      let snapshotCollisionFailed = false;
      try {
        await attempt.insertPerpMarketSnapshot(
          marketSnapshotValues(victimTicker)
        );
      } catch {
        snapshotCollisionFailed = true;
      }
      expect(snapshotCollisionFailed).toBe(true);
      expect(attempt.marketSnapshotTickers).toEqual([]);

      await attempt.cleanup();

      const [survivingOrgState] = await db
        .select()
        .from(organizationState)
        .where(eq(organizationState.id, victimTicker));
      expect(survivingOrgState).toBeDefined();
      const [survivingSnapshot] = await db
        .select()
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, victimTicker));
      expect(survivingSnapshot).toBeDefined();

      // Partial setup: the organizationState INSERT succeeds, then the
      // snapshot INSERT collides with a pre-existing snapshot row. Cleanup
      // removes only the row this attempt created.
      const partialTicker = `PNLFLOWPARTIAL${await generateSnowflakeId()}`;
      await victim.insertPerpMarketSnapshot(
        marketSnapshotValues(partialTicker)
      );
      await attempt.insertOrganizationState(
        marketOrganizationStateValues(partialTicker)
      );
      expect(attempt.organizationStateIds).toEqual([partialTicker]);
      let partialSnapshotFailed = false;
      try {
        await attempt.insertPerpMarketSnapshot(
          marketSnapshotValues(partialTicker)
        );
      } catch {
        partialSnapshotFailed = true;
      }
      expect(partialSnapshotFailed).toBe(true);
      expect(attempt.marketSnapshotTickers).toEqual([]);

      await attempt.cleanup();

      const [removedOrgState] = await db
        .select()
        .from(organizationState)
        .where(eq(organizationState.id, partialTicker));
      expect(removedOrgState).toBeUndefined();
      const [survivingPartialSnapshot] = await db
        .select()
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, partialTicker));
      expect(survivingPartialSnapshot).toBeDefined();
      expect(survivingPartialSnapshot?.organizationId).toBe(partialTicker);
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});

// Scope the real funding/price operations to each case's own market. Rows,
// locks, wallet credits, funding calculations and close settlement all use
// real PostgreSQL.
class OwnedMarketDb extends PerpDbAdapter {
  constructor(private readonly ticker: string) {
    super();
  }
  async listMarkets() {
    return (await super.listMarkets()).filter((m) => m.ticker === this.ticker);
  }
  async listOpenPositions() {
    return (await super.listOpenPositions()).filter(
      (p) => p.ticker === this.ticker
    );
  }
}

interface PnlMetrics {
  currentPnL: number;
  lifetimePnL: number;
  unrealizedPnL: number;
}

async function readMetricsViaHttp(userId: string): Promise<PnlMetrics> {
  const response = await getPnlHistory(
    new NextRequest(`http://localhost/api/users/${userId}/pnl-history`),
    { params: Promise.resolve({ userId }) }
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const payload = body.data ?? body;
  expect(payload.metrics).not.toBeNull();
  return payload.metrics as PnlMetrics;
}

async function runSettlementCase(params: {
  accrueFunding: boolean;
  ownerSide: 'long' | 'short';
  partialClose: boolean;
}): Promise<void> {
  const fixtures = new OwnedFixtures();
  try {
    const ownerId = await generateSnowflakeId();
    const otherId = await generateSnowflakeId();
    const ticker = `PNLFLOW${ownerId}`;
    await insertMarketRows(fixtures, ticker);
    for (const [id, balance] of [
      [ownerId, '100000'],
      [otherId, '100000'],
    ] as const) {
      await fixtures.insertUser({
        id,
        username: `pnl-flow-${id}`,
        virtualBalance: balance,
        totalDeposited: balance,
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
    }

    const adapter = new OwnedMarketDb(ticker);
    const service = new PerpMarketService({
      db: adapter,
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });

    // The counterparty takes the larger opposite side so the owner's side
    // is the funding payer when long (owner long 8000 vs other short 4000
    // leaves longs dominant) and the funding receiver when short.
    const ownerSize = params.ownerSide === 'long' ? 8000 : 4000;
    const otherSize = params.ownerSide === 'long' ? 4000 : 8000;
    const opened = await service.openPosition({
      userId: ownerId,
      ticker,
      side: params.ownerSide,
      size: ownerSize,
      leverage: 10,
    });
    fixtures.positionIds.push(opened.positionId);
    const otherOpened = await service.openPosition({
      userId: otherId,
      ticker,
      side: params.ownerSide === 'long' ? 'short' : 'long',
      size: otherSize,
      leverage: 10,
    });
    fixtures.positionIds.push(otherOpened.positionId);

    if (params.accrueFunding) {
      await service.processFundingStep();
    }
    const funded = await adapter.getPositionById(opened.positionId);
    expect(funded).not.toBeNull();
    const fundingPaid = funded?.fundingPaid ?? 0;
    if (params.accrueFunding) {
      // Long in a long-dominant market pays; short receives a rebate.
      expect(Math.sign(fundingPaid)).toBe(params.ownerSide === 'long' ? 1 : -1);
    } else {
      expect(fundingPaid).toBe(0);
    }

    // Move the price in the owner's favour and re-mark through the real
    // price-update path so the stored unrealized P&L is genuine.
    const movedPrice = params.ownerSide === 'long' ? 120 : 80;
    await service.applyPriceUpdates({ [ticker]: movedPrice });
    const marked = await adapter.getPositionById(opened.positionId);
    expect(marked).not.toBeNull();
    expect(marked?.unrealizedPnL ?? 0).toBeGreaterThan(0);

    const before = await readMetricsViaHttp(ownerId);
    expect(before.unrealizedPnL).toBeCloseTo(
      (marked?.unrealizedPnL ?? 0) - fundingPaid,
      6
    );
    expect(before.currentPnL).toBeCloseTo(
      before.lifetimePnL + before.unrealizedPnL,
      6
    );

    let partialRealizedPnL = 0;
    if (params.partialClose) {
      const partial = await service.closePosition({
        userId: ownerId,
        positionId: opened.positionId,
        percentage: 0.5,
      });
      partialRealizedPnL = partial.realizedPnL ?? 0;
      const remaining = await adapter.getPositionById(opened.positionId);
      expect(remaining?.closedAt).toBeUndefined();
      expect(remaining?.fundingPaid).toBeCloseTo(fundingPaid / 2, 10);
      const afterPartial = await readMetricsViaHttp(ownerId);
      expect(afterPartial.unrealizedPnL).toBeCloseTo(
        (remaining?.unrealizedPnL ?? 0) - (remaining?.fundingPaid ?? 0),
        6
      );
    }

    const [userBeforeClose] = await db
      .select()
      .from(users)
      .where(eq(users.id, ownerId));
    const lifetimeBefore = Number(userBeforeClose?.lifetimePnL ?? 0);
    const closed = await service.closePosition({
      userId: ownerId,
      positionId: opened.positionId,
    });
    expect(closed.fullyClosed).toBe(true);
    const closedRealizedPnL = closed.realizedPnL ?? Number.NaN;
    const closedExitPrice = closed.exitPrice ?? Number.NaN;

    const closedRow = await adapter.getPositionById(opened.positionId);
    expect(closedRow?.closedAt).toBeInstanceOf(Date);
    // The row accumulates realized P&L across the partial and final close;
    // the final result reports only its own leg.
    expect(closedRow?.realizedPnL ?? 0).toBeCloseTo(
      partialRealizedPnL + closedRealizedPnL,
      8
    );
    // The close leaves the accrued funding figure on the row: it was
    // settled inside realizedPnL, not charged again or erased.
    expect(closedRow?.fundingPaid).toBeCloseTo(
      params.partialClose ? fundingPaid / 2 : fundingPaid,
      10
    );
    // realizedPnL is the price P&L at the actual exit fill minus the
    // accrued funding, exactly once.
    const pricePnlAtExit =
      ((closedExitPrice - closed.entryPrice) / closed.entryPrice) *
      closed.size *
      (params.ownerSide === 'long' ? 1 : -1);
    expect(closedRealizedPnL).toBeCloseTo(
      pricePnlAtExit - (params.partialClose ? fundingPaid / 2 : fundingPaid),
      4
    );

    const after = await readMetricsViaHttp(ownerId);
    expect(after.unrealizedPnL).toBe(0);
    expect(after.currentPnL).toBeCloseTo(after.lifetimePnL, 8);
    // Lifetime P&L moved by the recorded settlement P&L (realizedPnL net
    // of the genuine close fee): no second funding deduction appears in
    // the reader after the close. The stored lifetime P&L is rounded to
    // cents by the wallet service, so the comparison is at cent precision
    // — still far tighter than any funding amount in these cases.
    expect(after.lifetimePnL - lifetimeBefore).toBeCloseTo(
      closedRealizedPnL - closed.feePaid,
      2
    );

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, ownerId));
    expect(ledger.filter((row) => row.type === 'perp_close')).toHaveLength(1);

    // The persisted hourly snapshot carries the same post-close metrics.
    // snapshotAllUserPnlMetrics is a global producer: on a shared database
    // it also writes current-hour rows for unrelated eligible users, and
    // this fixture only owns its own users. There is no scoped producer,
    // and the db handle is a process singleton bound to DATABASE_URL, so
    // this portion cannot be pointed at a separate fresh database on its
    // own. Instead the run proves unrelated snapshot data is unchanged
    // net of the call: record every current-hour row first, seed one
    // bystander with a pre-existing row and one without, run the real
    // producer, then remove exactly the rows it created for users outside
    // this fixture and verify the pre-existing rows are untouched.
    const snapshotAt = new Date();
    const hourBoundary = getHourBoundary(snapshotAt);
    const bystanderWithRowId = await generateSnowflakeId();
    const bystanderWithoutRowId = await generateSnowflakeId();
    for (const [id, lifetimePnL] of [
      [bystanderWithRowId, '42'],
      [bystanderWithoutRowId, '33'],
    ] as const) {
      await fixtures.insertUser({
        id,
        username: `pnl-flow-bystander-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        lifetimePnL,
        updatedAt: new Date(),
      });
    }
    await db.insert(userPnLSnapshots).values({
      id: `${bystanderWithRowId}:${hourBoundary.toISOString()}:pnl`,
      userId: bystanderWithRowId,
      snapshotAt: hourBoundary,
      lifetimePnL: 42,
      unrealizedPnL: 0,
      currentPnL: 42,
    });
    const snapshotRowsBefore = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.snapshotAt, hourBoundary));
    const beforeByUserId = new Map(
      snapshotRowsBefore.map((row) => [
        row.userId,
        {
          lifetimePnL: row.lifetimePnL,
          unrealizedPnL: row.unrealizedPnL,
          currentPnL: row.currentPnL,
        },
      ])
    );

    await snapshotAllUserPnlMetrics(snapshotAt);
    const [snapshotRow] = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.userId, ownerId));
    expect(snapshotRow).toBeDefined();
    expect(Number(snapshotRow?.currentPnL)).toBeCloseTo(after.currentPnL, 8);
    expect(Number(snapshotRow?.unrealizedPnL)).toBe(0);

    // The global producer really reaches unrelated users: the bystander
    // without a pre-existing row gains one, while the bystander's
    // pre-existing row is left alone by the on-conflict-do-nothing insert.
    const [bystanderCreatedRow] = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.userId, bystanderWithoutRowId));
    expect(bystanderCreatedRow).toBeDefined();
    const [bystanderKeptRow] = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.userId, bystanderWithRowId));
    expect(bystanderKeptRow).toBeDefined();
    expect(Number(bystanderKeptRow?.currentPnL)).toBe(42);
    expect(Number(bystanderKeptRow?.unrealizedPnL)).toBe(0);

    // Remove exactly the rows the producer created for users outside this
    // fixture; pre-existing rows are never touched.
    const ownedUserIds = new Set([
      ...fixtures.userIds,
      ...readerFixtures.userIds,
    ]);
    const rowsAfterProducer = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.snapshotAt, hourBoundary));
    const createdOutsideIds = rowsAfterProducer
      .map((row) => row.userId)
      .filter(
        (userId) => !ownedUserIds.has(userId) && !beforeByUserId.has(userId)
      );
    if (createdOutsideIds.length > 0) {
      await db
        .delete(userPnLSnapshots)
        .where(
          and(
            eq(userPnLSnapshots.snapshotAt, hourBoundary),
            inArray(userPnLSnapshots.userId, createdOutsideIds)
          )
        );
    }

    // Unrelated snapshot data is unchanged net of the run.
    const rowsFinal = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.snapshotAt, hourBoundary));
    const finalByUserId = new Map(rowsFinal.map((row) => [row.userId, row]));
    for (const [userId, before] of beforeByUserId) {
      const finalRow = finalByUserId.get(userId);
      expect(finalRow).toBeDefined();
      expect(Number(finalRow?.lifetimePnL)).toBe(Number(before.lifetimePnL));
      expect(Number(finalRow?.unrealizedPnL)).toBe(
        Number(before.unrealizedPnL)
      );
      expect(Number(finalRow?.currentPnL)).toBe(Number(before.currentPnL));
    }
    for (const row of rowsFinal) {
      expect(
        ownedUserIds.has(row.userId) || beforeByUserId.has(row.userId)
      ).toBe(true);
    }
  } finally {
    await fixtures.cleanup();
  }
}

describe('wallet P&L across a real funding accrual and settlement', () => {
  it('owes funding: partial then full close settles funding exactly once', async () => {
    await runSettlementCase({
      accrueFunding: true,
      ownerSide: 'long',
      partialClose: true,
    });
  });

  it('receives a funding rebate: full close settles funding exactly once', async () => {
    await runSettlementCase({
      accrueFunding: true,
      ownerSide: 'short',
      partialClose: false,
    });
  });

  it('zero funding: full close moves P&L only by price P&L and the fee', async () => {
    await runSettlementCase({
      accrueFunding: false,
      ownerSide: 'long',
      partialClose: false,
    });
  });
});
