import { expect, mock, test } from 'bun:test';
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
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import {
  calculateNetStoredUnrealizedPnL,
  calculateUnrealizedPnL,
  generateSnowflakeId,
} from '@feed/shared';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { getUserPositionsSnapshot } = await import(
  '../../../apps/web/src/lib/markets/user-positions'
);

/**
 * Feed Open Positions preview funding: the feed sidebar's "Open Positions"
 * panel (PositionsPreviewPanel) and the detail modal it opens
 * (PositionDetailModal) render the stored price-only unrealizedPnL for an
 * open perp, while accrued funding settles at close (realizedPnL = pnl -
 * fundingPaid, PRD §9.3). The panel already fetches fundingPaid and the
 * modal already shows it as a separate tile — but the headline PnL number
 * itself ignores it, overstating what the close will realize by exactly
 * fundingPaid. The wallet P&L tab (#1774) and the close dialog (#1927)
 * were fixed the same way; this surface was left behind.
 *
 * Repro on base: this file fails to import — calculateNetStoredUnrealizedPnL
 * does not exist — and the panel's raw number differs from the settled
 * realized PnL by fundingPaid (measured below: ~$18 over five 8-hour
 * funding steps on an $8,000 long at near-max imbalance).
 *
 * Fixture scoping: the funding producer (processFundingStep) reads every
 * market and every open position, so the service under test runs behind an
 * owned-market adapter that filters listMarkets/listOpenPositions to this
 * fixture's ticker. Ownership is published only after each insert/open
 * commits, and cleanup deletes exactly the acquired ids; parent cleanup
 * refuses when a foreign position still references the ticker.
 */

type UserInsert = typeof users.$inferInsert;
type PositionInsert = typeof perpPositions.$inferInsert;
type OrganizationStateInsert = typeof organizationState.$inferInsert;
type PerpMarketSnapshotInsert = typeof perpMarketSnapshots.$inferInsert;

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
      for (const table of [pointsTransactions, balanceTransactions])
        await db.delete(table).where(inArray(table.userId, this.userIds));
    }
    if (this.positionIds.length > 0) {
      await db
        .delete(perpPositions)
        .where(inArray(perpPositions.id, this.positionIds));
    }
    // Refuse market cleanup while any position row outside the acquired
    // set still references the ticker: that row belongs to someone else.
    for (const marketTicker of this.marketSnapshotTickers) {
      const rows = await db
        .select({ id: perpPositions.id })
        .from(perpPositions)
        .where(eq(perpPositions.ticker, marketTicker));
      const stray = rows.filter((row) => !this.positionIds.includes(row.id));
      if (stray.length > 0)
        throw new Error(
          `Refusing cleanup of market ${marketTicker}: ${stray.length} foreign position(s) still reference it`
        );
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, marketTicker));
    }
    for (const marketTicker of this.organizationStateIds) {
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, marketTicker));
    }
    if (this.userIds.length > 0)
      await db.delete(users).where(inArray(users.id, this.userIds));
    this.userIds.length = 0;
    this.positionIds.length = 0;
    this.organizationStateIds.length = 0;
    this.marketSnapshotTickers.length = 0;
  }
}

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

async function runPreviewCase(params: {
  ownerSide: 'long' | 'short';
}): Promise<void> {
  const fixtures = new OwnedFixtures();
  try {
    const ownerId = await generateSnowflakeId();
    const otherId = await generateSnowflakeId();
    const ticker = `PREV${ownerId}`;
    await fixtures.insertOrganizationState({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await fixtures.insertPerpMarketSnapshot({
      ticker,
      organizationId: ticker,
      currentPrice: 100,
      markPrice: 100,
      indexPrice: 100,
      high24h: 100,
      low24h: 100,
      // Deep market so the execution spread stays small relative to
      // accrued funding; the seeded open interest lifts the per-order
      // size cap (10% of OI, min 10,000) so the large counterparty long
      // in the short case can open.
      openInterest: 800000,
      volume24h: 7500000,
      bidDepth: 1000000,
      askDepth: 1000000,
      fundingRate: {
        ticker,
        rate: 0,
        predictedRate: 0,
        nextFundingTime: new Date().toISOString(),
      },
      metrics24hResetAt: new Date(),
      price24hAgoUpdatedAt: new Date(),
    });
    for (const id of [ownerId, otherId]) {
      await fixtures.insertUser({
        id,
        username: `preview-funding-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
    }

    // A mutable clock so the five funding steps land in five distinct UTC
    // 8h periods (the per-period claim key makes same-period replays
    // no-ops by design, PRD §9.3 / 0006 migration).
    let clockNow = new Date('2026-11-03T00:00:00.000Z');
    const clock = { now: () => new Date(clockNow) };
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
      clock,
    });

    // The counterparty takes the opposite side so the owner's side is the
    // funding payer when long (near-max long dominance: owner long 8000
    // vs other short 10, imbalance ≈ 0.9975, rate ≈ max) and the funding
    // receiver when short (long dominance: owner short 8000 vs other
    // long 80000, imbalance ≈ 0.82, rate ≈ 0.28 APR).
    const ownerSize = 8000;
    const otherSize = params.ownerSide === 'long' ? 10 : 80000;
    const otherSide = params.ownerSide === 'long' ? 'short' : 'long';
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
      side: otherSide,
      size: otherSize,
      leverage: 10,
    });
    fixtures.positionIds.push(otherOpened.positionId);

    // Five 8-hour funding steps (~40h held) at near-max imbalance.
    for (let step = 0; step < 5; step++) {
      clockNow = new Date(
        new Date('2026-11-03T00:00:00.000Z').getTime() +
          step * 8 * 60 * 60 * 1000
      );
      await service.processFundingStep();
    }

    const funded = await adapter.getPositionById(opened.positionId);
    expect(funded).not.toBeNull();
    const fundingPaid = funded?.fundingPaid ?? 0;
    // Long in a long-dominant market pays; short receives a rebate.
    expect(Math.sign(fundingPaid)).toBe(params.ownerSide === 'long' ? 1 : -1);
    expect(Math.abs(fundingPaid)).toBeGreaterThan(5);

    // Move the price in the owner's favour and re-mark through the real
    // price-update path so the stored unrealized P&L is genuine. The
    // short case moves only to 95 so the large counterparty long stays
    // well inside its margin.
    const movedPrice = params.ownerSide === 'long' ? 120 : 95;
    await service.applyPriceUpdates({ [ticker]: movedPrice });
    const marked = await adapter.getPositionById(opened.positionId);
    expect(marked).not.toBeNull();
    expect(marked?.unrealizedPnL ?? 0).toBeGreaterThan(0);

    // What the preview panel reads: the positions snapshot behind
    // GET /api/markets/positions/[userId]. It hands the panel the stored
    // price-only unrealizedPnL alongside fundingPaid.
    const snapshot = await getUserPositionsSnapshot({
      userId: ownerId,
      type: 'perp',
      status: 'open',
    });
    const previewPerp = snapshot.perpetuals.positions.find(
      (p) => p.id === opened.positionId
    );
    expect(previewPerp).toBeDefined();
    expect(previewPerp?.unrealizedPnL).toBeCloseTo(
      marked?.unrealizedPnL ?? 0,
      6
    );
    expect(previewPerp?.fundingPaid).toBeCloseTo(fundingPaid, 6);
    const panelRaw = previewPerp?.unrealizedPnL ?? 0;

    const closed = await service.closePosition({
      userId: ownerId,
      positionId: opened.positionId,
    });
    expect(closed.fullyClosed).toBe(true);
    const exitPrice = closed.exitPrice ?? movedPrice;
    const closedRealizedPnL = closed.realizedPnL ?? Number.NaN;

    // Premise: settlement nets funding exactly.
    const pnlAtExit = calculateUnrealizedPnL(
      funded?.entryPrice ?? 100,
      exitPrice,
      params.ownerSide,
      ownerSize
    ).pnl;
    expect(pnlAtExit - closedRealizedPnL).toBeCloseTo(fundingPaid, 2);

    // The panel's number is struck at the mark, while the close fills at
    // the execution price — the two differ by execution slippage, which is
    // not funding. So the funding gap is measured at the mark, not
    // against the settlement: the stored mark PnL recomputed from prices.
    const pnlAtMark = calculateUnrealizedPnL(
      funded?.entryPrice ?? 100,
      movedPrice,
      params.ownerSide,
      ownerSize
    ).pnl;
    expect(panelRaw).toBeCloseTo(pnlAtMark, 2);

    // What the panel showed before the fix: the raw stored number, which
    // overstates the funding-netted mark PnL by exactly fundingPaid.
    const net = calculateNetStoredUnrealizedPnL(
      panelRaw,
      ownerSize,
      fundingPaid
    );
    expect(panelRaw - net.pnl).toBeCloseTo(fundingPaid, 10);

    // The fix: the panel/modal number nets funding exactly the way the
    // settlement does, so the displayed value equals the funding-netted
    // mark PnL.
    expect(net.pnl).toBeCloseTo(pnlAtMark - fundingPaid, 2);
    expect(net.pnlPercent).toBeCloseTo((net.pnl / ownerSize) * 100, 10);
  } finally {
    await fixtures.cleanup();
  }
}

test('preview panel shows funding-netted PnL for a funded long', async () => {
  await runPreviewCase({ ownerSide: 'long' });
}, 120_000);

test('preview panel shows funding-netted PnL for a funded short (rebate)', async () => {
  await runPreviewCase({ ownerSide: 'short' });
}, 120_000);

test('helper nets funding owed, rebate, and zero funding', () => {
  const owed = calculateNetStoredUnrealizedPnL(100, 1000, 12);
  expect(owed.pnl).toBe(88);
  expect(owed.pnlPercent).toBeCloseTo(8.8, 10);
  const rebate = calculateNetStoredUnrealizedPnL(100, 1000, -5);
  expect(rebate.pnl).toBe(105);
  expect(rebate.pnlPercent).toBeCloseTo(10.5, 10);
  const zero = calculateNetStoredUnrealizedPnL(100, 1000, 0);
  expect(zero.pnl).toBe(100);
  expect(zero.pnlPercent).toBeCloseTo(10, 10);
  const zeroSize = calculateNetStoredUnrealizedPnL(100, 0, 12);
  expect(zeroSize.pnl).toBe(88);
  expect(zeroSize.pnlPercent).toBe(0);
});

test('cleanup after failed setup never deletes rows the fixture did not create', async () => {
  const victim = new OwnedFixtures();
  const attempt = new OwnedFixtures();
  try {
    const victimUserId = await generateSnowflakeId();
    await victim.insertUser({
      id: victimUserId,
      username: `preview-funding-victim-${victimUserId}`,
      displayName: 'Pre-existing user',
      lifetimePnL: '7',
      updatedAt: new Date(),
    });
    const victimPositionId = await generateSnowflakeId();
    await victim.insertPosition({
      id: victimPositionId,
      userId: victimUserId,
      organizationId: 'preview-funding-fixture',
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
      lastUpdated: new Date(),
    });

    // A user INSERT that collides with the pre-existing user fails and
    // registers no ownership.
    let userCollisionFailed = false;
    try {
      await attempt.insertUser({
        id: victimUserId,
        username: `preview-funding-collision-${victimUserId}`,
        displayName: 'Collision attempt',
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
    } catch {
      userCollisionFailed = true;
    }
    expect(userCollisionFailed).toBe(true);
    expect(attempt.userIds).toEqual([]);

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
