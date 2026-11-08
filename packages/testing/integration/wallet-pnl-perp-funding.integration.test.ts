import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { db, eq, perpPositions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { loadUserPnlHistory } = await import(
  '../../../apps/web/src/lib/wallet/pnlHistory'
);
const { calculatePortfolioPnL } = await import(
  '@feed/engine/services/portfolio-pnl'
);

/**
 * The wallet P&L tab's live metrics (loadUserPnlHistory ->
 * loadCurrentUserPnlMetrics) must value an open perp position the same way
 * every other canonical P&L path does: the stored price-only
 * unrealizedPnL net of accrued funding. Funding settles at close
 * (PerpMarketService: realizedPnL = pnl - fundingPaid), so while a position
 * is open its unrealized P&L is overstated by exactly fundingPaid, and the
 * "Current" P&L visibly drops by fundingPaid the moment the position
 * closes even though nothing economic happens at that instant.
 *
 * Fixtures: two users with lifetimePnL 20 and one open perp each with
 * price PnL +100 — one owing funding (fundingPaid 12), one owed a rebate
 * (fundingPaid -5).
 */

const now = new Date('2026-11-03T12:30:00.000Z');

let owingUserId: string;
let owingPositionId: string;
let rebateUserId: string;
let rebatePositionId: string;

async function insertFixture(
  userId: string,
  positionId: string,
  fundingPaid: number
) {
  await db.insert(users).values({
    id: userId,
    username: `test-pnl-funding-${userId}`,
    displayName: 'P&L funding fixture',
    lifetimePnL: '20',
    updatedAt: now,
  });
  await db.insert(perpPositions).values({
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
}

beforeAll(async () => {
  owingUserId = await generateSnowflakeId();
  owingPositionId = await generateSnowflakeId();
  rebateUserId = await generateSnowflakeId();
  rebatePositionId = await generateSnowflakeId();
  await insertFixture(owingUserId, owingPositionId, 12);
  await insertFixture(rebateUserId, rebatePositionId, -5);
});

afterAll(async () => {
  for (const userId of [owingUserId, rebateUserId]) {
    if (!userId) continue;
    await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
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

  it('keeps current P&L unchanged across the close that settles the funding', async () => {
    const open = await loadUserPnlHistory({ userId: owingUserId, now });

    // Model committed settlement exactly as PerpMarketService closes:
    // realizedPnL = pnl - fundingPaid = 100 - 12 = 88 joins lifetimePnL.
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ lifetimePnL: '108' })
        .where(eq(users.id, owingUserId));
      await tx
        .update(perpPositions)
        .set({ closedAt: now, realizedPnL: 88, unrealizedPnL: 0 })
        .where(eq(perpPositions.id, owingPositionId));
    });

    const closed = await loadUserPnlHistory({
      userId: owingUserId,
      now: new Date(now.getTime() + 1000),
    });
    expect(closed.metrics).toEqual({
      userId: owingUserId,
      lifetimePnL: 108,
      unrealizedPnL: 0,
      currentPnL: 108,
    });
    expect(closed.metrics?.currentPnL).toBe(open.metrics?.currentPnL);
    expect(closed.points.at(-1)?.value).toBe(108);
  });
});
