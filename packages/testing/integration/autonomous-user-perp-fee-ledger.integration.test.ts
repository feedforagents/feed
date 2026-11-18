/**
 * Autonomous user-agent perp trades record the fee they charge.
 *
 * PRD §9.1 (Trading fee) and MVP phase 6: execution and the fee ledger
 * (the recorded fee and users.totalFeesPaid) use the same fee, so the books
 * agree with what the trader was charged. executeDirectTrade is the
 * autonomous loop's trade path (MultiStepExecutor -> executeDirectTrade).
 * For a user-owned agent, PerpMarketService debits margin plus the
 * canonical fee from the user's wallet; every trade must leave one fee row
 * of that amount, or a durable outbox row when the inline write fails.
 *
 * Real executor, real core service, real FeeService, real Postgres. Each
 * test owns a unique user and a unique perp market, and cleanup deletes
 * only rows owned by them. The failure test replaces
 * FeeService.processTradingFee for its own trade only, then restores it.
 *
 * Run with:
 *   DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5453/feed" \
 *     bun test packages/testing/integration/autonomous-user-perp-fee-ledger.integration.test.ts \
 *     --preload ./packages/testing/integration/preload.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { executeDirectTrade } from '@feed/agents';
import {
  agentLogs,
  agentTrades,
  balanceTransactions,
  db,
  eq,
  gameConfigs,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  sql,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { FEE_CONFIG, FeeService, STABILITY_FUND_CONFIG } from '@feed/engine';
import { canonicalTradingFee, generateSnowflakeId } from '@feed/shared';
import { drainTradingFeeOutboxBatch } from '../../engine/src/services/trading-fee-outbox';

const START_BALANCE = 1000;
const createdUserIds: string[] = [];
const createdTickers: string[] = [];
const createdOrgIds: string[] = [];

async function createUserAgent(): Promise<string> {
  const userId = await generateSnowflakeId();
  await db.insert(users).values({
    id: userId,
    username: `auto-perp-fee-${userId.slice(-10)}`,
    profileComplete: true,
    isAgent: true,
    virtualBalance: String(START_BALANCE),
    totalDeposited: String(START_BALANCE),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function createPerpMarket(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const ticker = `AUTOFEE${suffix}`.toUpperCase();
  const orgId = `auto-perp-fee-org-${suffix}`;
  const now = new Date();
  await db.insert(organizationState).values({
    id: orgId,
    currentPrice: 100,
    basePrice: 100,
    updatedAt: now,
  });
  createdOrgIds.push(orgId);
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'Autonomous Perp Fee Test Org',
    currentPrice: 100,
    high24h: 100,
    low24h: 100,
    openInterest: 0,
    volume24h: 0,
    fundingRate: {
      ticker,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
  createdTickers.push(ticker);
  return ticker;
}

async function readUser(userId: string) {
  const [row] = await db
    .select({
      balance: users.virtualBalance,
      totalFeesPaid: users.totalFeesPaid,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    balance: Number(row?.balance ?? Number.NaN),
    totalFeesPaid: Number(row?.totalFeesPaid ?? Number.NaN),
  };
}

async function feeRows(userId: string) {
  return db.select().from(tradingFees).where(eq(tradingFees.userId, userId));
}

async function outboxRows(userId: string) {
  return db
    .select()
    .from(tradingFeeOutbox)
    .where(eq(tradingFeeOutbox.userId, userId));
}

function trade(
  userId: string,
  ticker: string,
  side: 'open_long' | 'close_position',
  amount: number
) {
  return executeDirectTrade({
    agentUserId: userId,
    marketType: 'perp',
    marketId: ticker,
    side,
    amount,
    reasoning: 'autonomous perp fee ledger regression',
    skipPerpResolution: true,
  });
}

describe('autonomous user-agent perp trades (executeDirectTrade)', () => {
  it('records the charged open and close fees in the fee ledger', async () => {
    const userId = await createUserAgent();
    const ticker = await createPerpMarket();

    const opened = await trade(userId, ticker, 'open_long', 200);
    expect(opened.success).toBe(true);

    const afterOpen = await readUser(userId);
    const openFee = canonicalTradingFee(200, FEE_CONFIG.TRADING_FEE_RATE);
    expect(openFee).toBeGreaterThan(0);
    // 1x margin of 200 plus the canonical fee left the wallet.
    expect(afterOpen.balance).toBeCloseTo(START_BALANCE - 200 - openFee, 8);

    const openRows = (await feeRows(userId)).filter(
      (row) => row.tradeType === 'perp_open'
    );
    expect(openRows).toHaveLength(1);
    expect(Number(openRows[0]?.feeAmount)).toBeCloseTo(openFee, 8);
    expect(afterOpen.totalFeesPaid).toBeCloseTo(openFee, 8);

    const closed = await trade(userId, ticker, 'close_position', 0);
    expect(closed.success).toBe(true);

    const [position] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(position?.closedAt).not.toBeNull();

    const closeRows = (await feeRows(userId)).filter(
      (row) => row.tradeType === 'perp_close'
    );
    expect(closeRows).toHaveLength(1);
    const closeFee = Number(closeRows[0]?.feeAmount);
    expect(closeFee).toBeGreaterThan(0);

    const afterClose = await readUser(userId);
    expect(afterClose.totalFeesPaid).toBeCloseTo(openFee + closeFee, 8);
    expect(await outboxRows(userId)).toHaveLength(0);
  });

  it('keeps a committed open successful and queues its fee when the ledger write fails', async () => {
    const userId = await createUserAgent();
    const ticker = await createPerpMarket();
    const original = FeeService.processTradingFee;
    FeeService.processTradingFee = async (...args) => {
      if (args[0] === userId) throw new Error('injected fee ledger failure');
      return original.apply(FeeService, args);
    };
    let opened: Awaited<ReturnType<typeof trade>>;
    try {
      opened = await trade(userId, ticker, 'open_long', 200);
    } finally {
      FeeService.processTradingFee = original;
    }

    // The trade committed, so the caller must not see a failure it would retry.
    expect(opened.success).toBe(true);
    const openFee = canonicalTradingFee(200, FEE_CONFIG.TRADING_FEE_RATE);
    expect((await readUser(userId)).balance).toBeCloseTo(
      START_BALANCE - 200 - openFee,
      8
    );
    expect(await feeRows(userId)).toHaveLength(0);

    const queued = await outboxRows(userId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.tradeType).toBe('perp_open');
    expect(Number(queued[0]?.tradeAmount)).toBe(200);

    await drainTradingFeeOutboxBatch();
    await drainTradingFeeOutboxBatch();

    const recovered = await feeRows(userId);
    expect(recovered).toHaveLength(1);
    expect(Number(recovered[0]?.feeAmount)).toBeCloseTo(openFee, 8);
    expect((await readUser(userId)).totalFeesPaid).toBeCloseTo(openFee, 8);
    expect(await outboxRows(userId)).toHaveLength(0);
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    // Reverse only this file's own stability-fund contribution.
    const [agg] = await db
      .select({
        platformTotal: sql<string>`COALESCE(SUM(${tradingFees.platformFee}::numeric), 0)`,
      })
      .from(tradingFees)
      .where(inArray(tradingFees.userId, createdUserIds));
    const diversion =
      Number(agg?.platformTotal ?? 0) *
      STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE;
    if (diversion > 0) {
      await db
        .update(gameConfigs)
        .set({
          value: sql`to_json(COALESCE((${gameConfigs.value} #>> '{}')::numeric, 0) - ${diversion})`,
          updatedAt: new Date(),
        })
        .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));
    }
    await db
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, createdUserIds));
    await db
      .delete(tradingFeeOutbox)
      .where(inArray(tradingFeeOutbox.userId, createdUserIds));
    await db
      .delete(agentTrades)
      .where(inArray(agentTrades.agentUserId, createdUserIds));
    await db
      .delete(agentLogs)
      .where(inArray(agentLogs.agentUserId, createdUserIds));
    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, createdUserIds));
    await db
      .delete(perpPositions)
      .where(inArray(perpPositions.userId, createdUserIds));
  }
  if (createdTickers.length) {
    await db
      .delete(perpMarketSnapshots)
      .where(inArray(perpMarketSnapshots.ticker, createdTickers));
  }
  if (createdOrgIds.length) {
    await db
      .delete(organizationState)
      .where(inArray(organizationState.id, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});
