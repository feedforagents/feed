/** PRD §§9.3–9.4 / MVP phase 6: the wallet P&L tab must agree with the
 * canonical portfolio breakdown. Accrued perp funding is a liability while
 * a position is open (it settles at close as realizedPnL = pnl -
 * fundingPaid), so both the breakdown totalPnL and the P&L tab Current
 * value must net it. */
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
  try {
    for (const id of userIds)
      await db.insert(users).values({
        id,
        username: `fund-pnl-tab-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        updatedAt: new Date(),
      });
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
    const opened = await service.openPosition({
      userId: ownerId,
      ticker,
      side: 'long',
      size: 8000,
      leverage: 10,
    });
    await service.openPosition({
      userId: otherId,
      ticker,
      side: 'short',
      size: 4000,
      leverage: 10,
    });

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
  } finally {
    for (const table of [
      pointsTransactions,
      balanceTransactions,
      perpPositions,
    ])
      await db.delete(table).where(inArray(table.userId, userIds));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await db.delete(organizationState).where(eq(organizationState.id, ticker));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});
