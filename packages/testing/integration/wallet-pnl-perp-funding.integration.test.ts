import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { resolve } from 'node:path';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
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
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { loadUserPnlHistory } = await import(
  '../../../apps/web/src/lib/wallet/pnlHistory'
);
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

const repoRoot = resolve(import.meta.dir, '../../..');
const isolatedSnapshotHelper = resolve(
  import.meta.dir,
  'helpers/pnl-snapshot-isolated-run.ts'
);

/**
 * A database URL is disposable only on loopback with a test-like name —
 * the same guard other integration suites use before touching a database.
 */
function assertDisposableDatabaseUrl(
  value: string | undefined,
  label: string
): string {
  if (!value) throw new Error(`${label} is required for integration tests`);
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !/(?:^|[_-])(test|testing|verification)(?:[_-]|$)/i.test(databaseName)
  ) {
    throw new Error(
      `${label} must point to a local test or verification database`
    );
  }
  return databaseName;
}

async function runSpawned(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
  label: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 120_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(
        `${label} failed (exit ${code})\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${stderr.slice(-4000)}`
      );
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run the global snapshot producer in an exclusively owned fresh
 * database/process: create a disposable database on the same server,
 * migrate it, spawn the isolated run with the singleton DB handle
 * configured to that database when the child process starts, then drop
 * the whole database. Every row the producer writes disappears with the
 * database, so this never classifies unrelated rows by a before/after
 * diff and never deletes rows outside this fixture — not even when an
 * assertion fails, because the drop runs in `finally`.
 */
async function runSnapshotProducerInIsolatedDb(params: {
  ownerId: string;
  ownerLifetimePnL: number;
  expectedOwnerCurrentPnL: number;
  snapshotAt: Date;
}): Promise<void> {
  const sharedUrl = process.env.DATABASE_URL;
  assertDisposableDatabaseUrl(sharedUrl, 'DATABASE_URL');
  const shared = new URL(sharedUrl as string);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const freshDbName = `feed_test_1774r_${suffix}`;
  const freshUrl = new URL(shared);
  freshUrl.pathname = `/${freshDbName}`;
  const freshUrlString = freshUrl.toString();

  await db.execute(sql.raw(`CREATE DATABASE "${freshDbName}"`));
  try {
    const migrateEnv = {
      ...process.env,
      DATABASE_URL: freshUrlString,
      DIRECT_DATABASE_URL: freshUrlString,
    };
    await runSpawned(
      [
        'node',
        'node_modules/drizzle-kit/bin.cjs',
        'migrate',
        '--config=packages/db/drizzle.config.cjs',
      ],
      { cwd: repoRoot, env: migrateEnv },
      `migrating isolated database ${freshDbName}`
    );

    const bystanderWithRowId = await generateSnowflakeId();
    const bystanderWithoutRowId = await generateSnowflakeId();
    const runInput = {
      ownerId: params.ownerId,
      ownerLifetimePnL: String(params.ownerLifetimePnL),
      expectedOwnerCurrentPnL: params.expectedOwnerCurrentPnL,
      bystanderWithRowId,
      bystanderWithRowLifetimePnL: '42',
      bystanderWithoutRowId,
      bystanderWithoutRowLifetimePnL: '33',
      snapshotAt: params.snapshotAt.toISOString(),
    };
    const childEnv = {
      ...process.env,
      NODE_ENV: 'test',
      BUN_ENV: 'test',
      DATABASE_URL: freshUrlString,
      DIRECT_DATABASE_URL: freshUrlString,
      DISABLE_RATE_LIMITING: 'true',
      TZ: 'UTC',
      PNL_SNAPSHOT_RUN_JSON: JSON.stringify(runInput),
    };
    const { stdout } = await runSpawned(
      [process.execPath, 'test', isolatedSnapshotHelper],
      { env: childEnv },
      'isolated snapshot producer run'
    );
    const summary = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('{"ok":true'));
    if (!summary) {
      throw new Error(
        `isolated snapshot producer run printed no JSON summary\n--- stdout ---\n${stdout.slice(-4000)}`
      );
    }
  } finally {
    await db.execute(
      sql.raw(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${freshDbName}'`
      )
    );
    await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${freshDbName}"`));
  }
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
    // it also writes current-hour rows for unrelated eligible users, so
    // running it here would write — and then need to clean up — rows this
    // fixture does not own. Instead the producer runs in an exclusively
    // owned fresh database in a child process (see
    // runSnapshotProducerInIsolatedDb): the child seeds only the owner and
    // two bystanders, proves the producer reaches the bystander without a
    // row and leaves the bystander's pre-existing row alone, and the
    // parent drops the whole database afterwards. No before/after diff
    // over unrelated users, and no deletion of outside rows.
    await runSnapshotProducerInIsolatedDb({
      ownerId,
      ownerLifetimePnL: after.lifetimePnL,
      expectedOwnerCurrentPnL: after.currentPnL,
      snapshotAt: new Date(),
    });
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
  }, 120_000);

  it('receives a funding rebate: full close settles funding exactly once', async () => {
    await runSettlementCase({
      accrueFunding: true,
      ownerSide: 'short',
      partialClose: false,
    });
  }, 120_000);

  it('zero funding: full close moves P&L only by price P&L and the fee', async () => {
    await runSettlementCase({
      accrueFunding: false,
      ownerSide: 'long',
      partialClose: false,
    });
  }, 120_000);
});
