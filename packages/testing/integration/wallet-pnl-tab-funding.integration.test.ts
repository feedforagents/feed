/** PRD §§9.3–9.4 / MVP phase 6: the wallet P&L tab must agree with the
 * canonical portfolio breakdown. Accrued perp funding is a liability while
 * a position is open (it settles at close as realizedPnL = pnl -
 * fundingPaid), so both the breakdown totalPnL and the P&L tab Current
 * value must net it. */
import { expect, mock, test } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  adminRoles,
  balanceTransactions,
  db,
  eq,
  gameOnboarding,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  tradingFeeOutbox,
  tradingFees,
  userPnLSnapshots,
  users,
} from '@feed/db';
import {
  calculatePortfolioPnL,
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/users/[userId]/portfolio-breakdown/route';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { loadCurrentUserPnlMetrics } = await import(
  '../../../apps/web/src/lib/wallet/pnlHistory'
);

// Scope the real funding operation to this test's market. Rows, locks, wallet
// debits, funding calculations and close settlement all use real PostgreSQL.
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

test('wallet P&L tab Current nets accrued perp funding like the breakdown', async () => {
  const userIds = [await generateSnowflakeId(), await generateSnowflakeId()];
  const ticker = `FUNDPNL${userIds[0]}`;
  const ownerId = userIds[0]!;
  const otherId = userIds[1]!;
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
  // Ownership receipts: nothing is cleaned up unless this test created it.
  // Each receipt is published only after its insert resolves (drizzle
  // auto-commits a bare insert, so a resolved insert is a committed
  // receipt). A generated id is not ownership: if a row already exists
  // under it, another writer owns it and this test must not touch it.
  const acquired = {
    users: [] as string[],
    market: false,
    snapshot: false,
    positionIds: [] as string[],
  };
  // Child ledger ids that existed before this test ran its service calls.
  // Cleanup deletes only ids created after this snapshot, never every row
  // that happens to carry one of the test user ids.
  let ledgerBefore: Record<string, Set<string>> | null = null;
  const ledgerTables = [
    { key: 'balanceTransactions', table: balanceTransactions },
    { key: 'pointsTransactions', table: pointsTransactions },
    { key: 'tradingFees', table: tradingFees },
    { key: 'tradingFeeOutbox', table: tradingFeeOutbox },
  ] as const;
  const snapshotLedgerIds = async () => {
    const out: Record<string, Set<string>> = {};
    for (const { key, table } of ledgerTables) {
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(inArray(table.userId, userIds));
      out[key] = new Set(rows.map((row) => row.id));
    }
    return out;
  };
  try {
    // Pre-flight: the generated ids must be unowned. Any pre-existing row
    // fails fast with nothing to clean up.
    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, userIds));
    if (existingUsers.length > 0)
      throw new Error(
        `Refusing to run: user(s) already exist: ${existingUsers.map((row) => row.id).join(', ')}`
      );
    const existingMarket = await db
      .select({ id: organizationState.id })
      .from(organizationState)
      .where(eq(organizationState.id, ticker));
    if (existingMarket.length > 0)
      throw new Error(`Refusing to run: market already exists: ${ticker}`);
    const existingSnapshot = await db
      .select({ ticker: perpMarketSnapshots.ticker })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    if (existingSnapshot.length > 0)
      throw new Error(
        `Refusing to run: market snapshot already exists: ${ticker}`
      );

    for (const id of userIds) {
      await db.insert(users).values({
        id,
        username: `fund-pnl-tab-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        updatedAt: new Date(),
      });
      acquired.users.push(id);
    }
    await db.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    acquired.market = true;
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
    acquired.snapshot = true;
    ledgerBefore = await snapshotLedgerIds();

    const opened = await service.openPosition({
      userId: ownerId,
      ticker,
      side: 'long',
      size: 8000,
      leverage: 10,
    });
    acquired.positionIds.push(opened.positionId);
    const otherOpened = await service.openPosition({
      userId: otherId,
      ticker,
      side: 'short',
      size: 4000,
      leverage: 10,
    });
    acquired.positionIds.push(otherOpened.positionId);

    await service.processFundingStep();
    const funded = await adapter.getPositionById(opened.positionId);
    expect(funded).not.toBeNull();
    // Long-dominant book: longs pay funding, so the owner accrued a
    // positive fundingPaid liability while the position stays open.
    expect(funded!.fundingPaid).toBeGreaterThan(0);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/users/${ownerId}/portfolio-breakdown`
      ),
      { params: Promise.resolve({ userId: ownerId }) }
    );
    expect(response.status).toBe(200);
    const breakdown = await response.json();
    const enginePnl = await calculatePortfolioPnL(ownerId);
    expect(enginePnl).not.toBeNull();
    const metrics = await loadCurrentUserPnlMetrics([ownerId]);
    const tab = metrics.get(ownerId);
    expect(tab).toBeDefined();

    // The canonical computers already agree (see
    // perp-portfolio-funding.integration.test.ts): the breakdown nets
    // funding, and so does calculatePortfolioPnL.
    expect(breakdown.totalPnL).toBeCloseTo(enginePnl!.totalPnL, 8);
    expect(tab!.unrealizedPnL).toBeCloseTo(enginePnl!.unrealizedPerpPnL, 8);
    // The wallet P&L tab must show the same Current P&L as the breakdown
    // totalPnL for the same open position.
    expect(tab!.currentPnL).toBeCloseTo(breakdown.totalPnL, 8);
    expect(tab!.currentPnL).toBeCloseTo(enginePnl!.totalPnL, 8);
    // Note: the optional fee processor is not configured here, so this case
    // is persisted funding/P&L component evidence, not proof of complete
    // fee-ledger/outbox accounting. The fee rows this run does create are
    // tracked as acquired effects and removed below.
  } finally {
    // Clean up only exact acquired effects. A failed or partial setup
    // leaves unacquired rows in place and the refusal below fails loudly
    // instead of deleting rows another writer may own.
    if (ledgerBefore) {
      const after = await snapshotLedgerIds();
      for (const { key, table } of ledgerTables) {
        const created = [...(after[key] ?? new Set())].filter(
          (id) => !ledgerBefore![key]?.has(id)
        );
        if (created.length > 0)
          await db.delete(table).where(inArray(table.id, created));
      }
    }
    if (acquired.positionIds.length > 0)
      await db
        .delete(perpPositions)
        .where(inArray(perpPositions.id, acquired.positionIds));
    if (acquired.snapshot)
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
    if (acquired.market)
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
    for (const id of acquired.users) {
      // Refuse the parent delete while any foreign reference remains:
      // deleting the user would cascade GameOnboarding/UserPnLSnapshot
      // rows or be blocked by AdminRole, and must never silently drop
      // rows this test did not acquire.
      const remaining: string[] = [];
      for (const { key, table } of [
        { key: 'perpPositions', table: perpPositions },
        { key: 'balanceTransactions', table: balanceTransactions },
        { key: 'pointsTransactions', table: pointsTransactions },
        { key: 'tradingFees', table: tradingFees },
        { key: 'tradingFeeOutbox', table: tradingFeeOutbox },
      ]) {
        const rows = await db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.userId, id));
        if (rows.length > 0) remaining.push(`${key}:${rows.length}`);
      }
      for (const { key, table } of [
        { key: 'gameOnboarding', table: gameOnboarding },
        { key: 'userPnLSnapshots', table: userPnLSnapshots },
      ]) {
        const rows = await db
          .select({ id: table.id })
          .from(table)
          .where(eq(table.userId, id));
        if (rows.length > 0) remaining.push(`${key}:${rows.length}`);
      }
      const roles = await db
        .select({ id: adminRoles.id })
        .from(adminRoles)
        .where(eq(adminRoles.userId, id));
      if (roles.length > 0) remaining.push(`adminRoles:${roles.length}`);
      const granted = await db
        .select({ id: adminRoles.id })
        .from(adminRoles)
        .where(eq(adminRoles.grantedBy, id));
      if (granted.length > 0)
        remaining.push(`adminRoles.grantedBy:${granted.length}`);
      if (remaining.length > 0)
        throw new Error(
          `Refusing to delete user ${id}: foreign references remain (${remaining.join(', ')})`
        );
      await db.delete(users).where(eq(users.id, id));
    }
  }
});
