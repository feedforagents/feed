import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { executeDirectTrade } from '@feed/agents';
import {
  agentTrades,
  balanceTransactions,
  dbWrite,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

/**
 * DB-backed repro for three DirectExecutor perp defects:
 * 1. close_position ignores `amount` — a partial close full-closes.
 * 2. Perp open/close never wire feeProcessor — the fee is debited from the
 *    trader but never distributed (no tradingFees row, no referrer credit,
 *    no stability-fund diversion, no totalFeesPaid increment).
 * 3. The balance cap ignores the trading fee — an open capped to the full
 *    balance fails with InsufficientFunds because margin + fee exceeds it.
 *
 * Requires a real Postgres (DATABASE_URL). The integration preload verifies
 * the connection on startup.
 */

const TICKER = 'TSLAI';
const ORG_ID = 'direct-perp-test-org';

const userIds: string[] = [];

async function createMarket(): Promise<void> {
  const now = new Date();
  await dbWrite.insert(organizationState).values({
    id: ORG_ID,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: now,
  });
  await dbWrite.insert(perpMarketSnapshots).values({
    ticker: TICKER,
    organizationId: ORG_ID,
    name: 'Direct Perp Test Org',
    currentPrice: 100,
    high24h: 100,
    low24h: 100,
    bidDepth: 1000000,
    askDepth: 1000000,
    maxLeverage: 20,
    minOrderSize: 10,
    fundingRate: {
      ticker: TICKER,
      rate: 0,
      predictedRate: 0,
      nextFundingTime: now.toISOString(),
    },
  });
}

async function createUser(balance: string): Promise<string> {
  const userId = await generateSnowflakeId();
  userIds.push(userId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `direct-perp-${userId}`,
    virtualBalance: balance,
    totalDeposited: balance,
    profileComplete: true,
    updatedAt: new Date(),
  });
  return userId;
}

async function getPosition(userId: string) {
  const [position] = await dbWrite
    .select()
    .from(perpPositions)
    .where(eq(perpPositions.userId, userId))
    .limit(1);
  return position;
}

async function getBalance(userId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Number(row?.virtualBalance ?? 0);
}

async function waitForFee(
  userId: string,
  tradeType: string,
  timeoutMs = 8000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await dbWrite
      .select({ id: tradingFees.id })
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    if (rows.some((row) => row.id)) {
      const typed = await dbWrite
        .select()
        .from(tradingFees)
        .where(eq(tradingFees.userId, userId));
      if (typed.some((fee) => fee.tradeType === tradeType)) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  await createMarket();
});

afterAll(async () => {
  if (userIds.length) {
    await dbWrite.delete(perpPositions).where(eq(perpPositions.ticker, TICKER));
    await dbWrite.delete(agentTrades).where(eq(agentTrades.ticker, TICKER));
    for (const userId of userIds) {
      await dbWrite
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      await dbWrite.delete(tradingFees).where(eq(tradingFees.userId, userId));
      await dbWrite.delete(users).where(eq(users.id, userId));
    }
  }
  await dbWrite
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, TICKER));
  await dbWrite
    .delete(organizationState)
    .where(eq(organizationState.id, ORG_ID));
});

describe('executeDirectTrade perp', () => {
  it('close_position with an amount closes only that amount', async () => {
    const userId = await createUser('1000');
    const open = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'open_long',
      amount: 200,
    });
    expect(open.success).toBe(true);

    const close = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'close_position',
      amount: 50,
    });
    expect(close.success).toBe(true);

    const position = await getPosition(userId);
    expect(position).toBeDefined();
    expect(position?.closedAt).toBeNull();
    expect(Number(position?.size)).toBeCloseTo(150, 2);
  }, 30000);

  it('distributes the perp open fee (tradingFees row + totalFeesPaid)', async () => {
    const userId = await createUser('1000');
    const open = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'open_long',
      amount: 200,
    });
    expect(open.success).toBe(true);

    // Fee distribution is fire-and-forget inside the service; poll briefly.
    expect(await waitForFee(userId, 'perp_open')).toBe(true);
    const fees = await dbWrite
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(fees).toHaveLength(1);
    expect(Number(fees[0]?.feeAmount)).toBeCloseTo(0.2, 2);

    const [user] = await dbWrite
      .select({ totalFeesPaid: users.totalFeesPaid })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    expect(Number(user?.totalFeesPaid)).toBeCloseTo(0.2, 2);
  }, 30000);

  it('distributes the perp close fee', async () => {
    const userId = await createUser('1000');
    const open = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'open_long',
      amount: 200,
    });
    expect(open.success).toBe(true);
    expect(await waitForFee(userId, 'perp_open')).toBe(true);

    const close = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'close_position',
      amount: 0,
    });
    expect(close.success).toBe(true);

    expect(await waitForFee(userId, 'perp_close')).toBe(true);
    const fees = await dbWrite
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, userId));
    expect(fees.map((fee) => fee.tradeType).sort()).toEqual([
      'perp_close',
      'perp_open',
    ]);
  }, 30000);

  it('opens when the requested amount equals the balance (fee-aware cap)', async () => {
    const userId = await createUser('100');
    const open = await executeDirectTrade({
      agentUserId: userId,
      marketType: 'perp',
      marketId: TICKER,
      side: 'open_long',
      amount: 100,
    });
    expect(open.success).toBe(true);

    const position = await getPosition(userId);
    expect(position).toBeDefined();
    expect(Number(position?.size)).toBeGreaterThan(0);
    expect(Number(position?.size)).toBeLessThanOrEqual(100);
    expect(await getBalance(userId)).toBeGreaterThanOrEqual(0);
  }, 30000);
});
