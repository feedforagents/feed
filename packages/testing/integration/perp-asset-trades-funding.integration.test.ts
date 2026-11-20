import { expect, mock, test } from 'bun:test';
import { invalidateCachePattern } from '@feed/api';
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
import { calculateUnrealizedPnL, generateSnowflakeId } from '@feed/shared';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { NextRequest } = await import('next/server');
const { GET } = await import(
  '../../../apps/web/src/app/api/markets/perps/trades/[ticker]/route'
);

/**
 * Feed market trades feed funding: the perp market terminal's "Trades" tab
 * (AssetTradesFeed, marketType="perp") renders an open position row with a
 * "P&L:" number taken from GET /api/markets/perps/trades/[ticker], which
 * returns the stored price-only unrealizedPnL. Accrued funding settles at
 * close (realizedPnL = pnl - fundingPaid, PerpMarketService close paths),
 * so the feed overstates what the close will realize by exactly
 * fundingPaid — the same defect family the Open Positions preview panel
 * (#1985) and the close dialog (#1927) already fix on their own surfaces,
 * while the wallet P&L tab (#1774, merged) nets it in SQL. This surface
 * was left behind: the route exposes no fundingPaid at all, so the feed
 * cannot net it even in principle.
 *
 * Repro on base: the route's perp row returns the raw stored mark PnL,
 * which differs from the funding-netted mark PnL by exactly fundingPaid
 * (measured below: ~$18 over five 8-hour funding steps on an $8,000 long
 * at near-max imbalance; ~$10 rebate on the short side).
 *
 * Fixture scoping: the funding producer (processFundingStep) reads every
 * market and every open position, so the service under test runs behind an
 * owned-market adapter that filters listMarkets/listOpenPositions to this
 * fixture's ticker. The trades route resolves the ticker through the
 * immutable static registry (AMZN -> aimazon), so the fixture uses that
 * canonical market; ownership is published only after each insert/open
 * commits, and cleanup deletes exactly the acquired ids.
 */

type UserInsert = typeof users.$inferInsert;
type PositionInsert = typeof perpPositions.$inferInsert;
type OrganizationStateInsert = typeof organizationState.$inferInsert;
type PerpMarketSnapshotInsert = typeof perpMarketSnapshots.$inferInsert;

const TICKER = 'AMZN';
const ORG_ID = 'aimazon';

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
    for (const orgId of this.organizationStateIds) {
      await db.delete(organizationState).where(eq(organizationState.id, orgId));
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

type PerpTradeRow = {
  id: string;
  type: string;
  side: string;
  size: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  liquidationPrice: number;
  timestamp: string;
  closedAt: string | null;
  ticker: string;
};

async function fetchPerpTradeRow(
  positionId: string
): Promise<PerpTradeRow | undefined> {
  // The route caches for 30s (in-memory fallback when Redis is disabled),
  // and both cases share the AMZN key — invalidate before every fetch so
  // each read reflects live DB state (also the post-close re-fetch below).
  await invalidateCachePattern('perp-trades:amzn:*', {
    namespace: 'market-trades',
  });
  const response = await GET(
    new NextRequest(
      `http://localhost/api/markets/perps/trades/${TICKER}?limit=50&offset=0`
    ),
    { params: Promise.resolve({ ticker: TICKER }) }
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const data = ('data' in body ? body.data : body) as {
    trades: PerpTradeRow[];
    total: number;
    hasMore: boolean;
  };
  expect(Array.isArray(data.trades)).toBe(true);
  return data.trades.find((t) => t.type === 'perp' && t.id === positionId);
}

async function runTradesFeedCase(params: {
  ownerSide: 'long' | 'short';
}): Promise<void> {
  const fixtures = new OwnedFixtures();
  try {
    const ownerId = await generateSnowflakeId();
    const otherId = await generateSnowflakeId();
    await fixtures.insertOrganizationState({
      id: ORG_ID,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await fixtures.insertPerpMarketSnapshot({
      ticker: TICKER,
      organizationId: ORG_ID,
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
        ticker: TICKER,
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
        username: `asset-trades-funding-${id}`,
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
    const adapter = new OwnedMarketDb(TICKER);
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
      ticker: TICKER,
      side: params.ownerSide,
      size: ownerSize,
      leverage: 10,
    });
    fixtures.positionIds.push(opened.positionId);
    const otherOpened = await service.openPosition({
      userId: otherId,
      ticker: TICKER,
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
    await service.applyPriceUpdates({ [TICKER]: movedPrice });
    const marked = await adapter.getPositionById(opened.positionId);
    expect(marked).not.toBeNull();
    expect(marked?.unrealizedPnL ?? 0).toBeGreaterThan(0);

    // What the trades feed reads: the real public route behind
    // AssetTradesFeed. On base it hands the feed the stored price-only
    // unrealizedPnL; the fix nets accrued funding out of the open row.
    const row = await fetchPerpTradeRow(opened.positionId);
    expect(row).toBeDefined();
    expect(row?.closedAt).toBeNull();
    const feedPnl = row?.unrealizedPnL ?? Number.NaN;
    const pnlAtMark = calculateUnrealizedPnL(
      funded?.entryPrice ?? 100,
      movedPrice,
      params.ownerSide,
      ownerSize
    ).pnl;
    expect(pnlAtMark).toBeCloseTo(marked?.unrealizedPnL ?? 0, 2);

    // The feed's number must equal the funding-netted mark PnL — what
    // the close will actually realize (up to execution slippage, which
    // is not funding).
    expect(feedPnl).toBeCloseTo(pnlAtMark - fundingPaid, 2);

    // Premise: settlement nets funding exactly.
    const closed = await service.closePosition({
      userId: ownerId,
      positionId: opened.positionId,
    });
    expect(closed.fullyClosed).toBe(true);
    const exitPrice = closed.exitPrice ?? movedPrice;
    const closedRealizedPnL = closed.realizedPnL ?? Number.NaN;
    const pnlAtExit = calculateUnrealizedPnL(
      funded?.entryPrice ?? 100,
      exitPrice,
      params.ownerSide,
      ownerSize
    ).pnl;
    expect(pnlAtExit - closedRealizedPnL).toBeCloseTo(fundingPaid, 2);

    // Closed rows show no P&L in the feed ("Position closed"), and the
    // route must not invent one by netting a zeroed stored PnL against
    // a leftover funding balance.
    const closedRow = await fetchPerpTradeRow(opened.positionId);
    expect(closedRow).toBeDefined();
    expect(closedRow?.closedAt).not.toBeNull();
    expect(closedRow?.unrealizedPnL).toBe(0);
  } finally {
    await fixtures.cleanup();
  }
}

test('asset trades feed nets accrued funding for a funded long', async () => {
  await runTradesFeedCase({ ownerSide: 'long' });
}, 120_000);

test('asset trades feed nets accrued funding for a funded short (rebate)', async () => {
  await runTradesFeedCase({ ownerSide: 'short' });
}, 120_000);

test('cleanup after failed setup never deletes rows the fixture did not create', async () => {
  const victim = new OwnedFixtures();
  const attempt = new OwnedFixtures();
  try {
    const victimUserId = await generateSnowflakeId();
    await victim.insertUser({
      id: victimUserId,
      username: `asset-trades-funding-victim-${victimUserId}`,
      displayName: 'Pre-existing user',
      lifetimePnL: '7',
      updatedAt: new Date(),
    });
    const victimPositionId = await generateSnowflakeId();
    await victim.insertPosition({
      id: victimPositionId,
      userId: victimUserId,
      organizationId: 'asset-trades-funding-fixture',
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
        username: `asset-trades-funding-collision-${victimUserId}`,
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
