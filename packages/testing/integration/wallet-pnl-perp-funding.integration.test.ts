import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
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
import { NextRequest } from 'next/server';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { loadUserPnlHistory, snapshotAllUserPnlMetrics } = await import(
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

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway (for example on
 * an ID collision with a pre-existing row) can never delete data this
 * fixture did not create.
 */
class OwnedFixtures {
  readonly userIds: string[] = [];
  readonly positionIds: string[] = [];
  readonly tickers: string[] = [];

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
    if (this.tickers.length > 0) {
      await db
        .delete(perpMarketSnapshots)
        .where(inArray(perpMarketSnapshots.ticker, this.tickers));
      await db
        .delete(organizationState)
        .where(inArray(organizationState.id, this.tickers));
    }
    if (this.userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, this.userIds));
    }
    this.userIds.length = 0;
    this.positionIds.length = 0;
    this.tickers.length = 0;
  }
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
    fixtures.tickers.push(ticker);
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
    await db.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await db.insert(perpMarketSnapshots).values({
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
    });

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
    await snapshotAllUserPnlMetrics(new Date());
    const [snapshotRow] = await db
      .select()
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.userId, ownerId));
    expect(snapshotRow).toBeDefined();
    expect(Number(snapshotRow?.currentPnL)).toBeCloseTo(after.currentPnL, 8);
    expect(Number(snapshotRow?.unrealizedPnL)).toBe(0);
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
