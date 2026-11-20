/**
 * Integration test: OPEN_PERP plugin action balance pre-check must cover
 * the trading fee.
 *
 * Runs against a real Postgres database (DATABASE_URL) with the real
 * WalletService, PerpDbAdapter and settlement, because the defect is the
 * mismatch between the action's pre-check and the service's debit:
 * the action checked `balance < amount` (collateral only) while the
 * service debits `amount + fee`, so a balance equal to the collateral
 * passed the pre-check and then failed inside the service with a generic
 * InsufficientFunds error.
 *
 * Run with: DATABASE_URL=postgresql://... bun test packages/testing/integration/open-perp-fee-precheck.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import {
  agentLogs,
  agentTrades,
  balanceTransactions,
  count,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { openPerpAction } from '../../agents/src/plugins/plugin-agent-core/src/actions/open-perp';

const BASE_PRICE = 100;

let TEST_TICKER = '';
let ORG_ID = '';

const testUserIds: string[] = [];
let feeBaseline: { fees: number; outbox: number };

async function feeCounts() {
  const [[fees], [outbox]] = await Promise.all([
    db.select({ count: count() }).from(tradingFees),
    db.select({ count: count() }).from(tradingFeeOutbox),
  ]);
  return { fees: fees?.count ?? 0, outbox: outbox?.count ?? 0 };
}

async function createTestUser(virtualBalance: string): Promise<string> {
  const userId = await generateSnowflakeId();
  const username = `test-openperp-${userId.slice(-8)}`;
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-${userId}`,
    username,
    displayName: username,
    profileComplete: true,
    virtualBalance,
    updatedAt: new Date(),
  });
  testUserIds.push(userId);
  return userId;
}

async function createTestMarket(): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  TEST_TICKER = `OPENFEE${suffix}`.toUpperCase();
  ORG_ID = `test-openperp-org-${suffix}`;
  const now = new Date();

  await db.insert(organizationState).values({
    id: ORG_ID,
    currentPrice: BASE_PRICE,
    basePrice: BASE_PRICE,
    updatedAt: now,
  });
  await db.insert(perpMarketSnapshots).values({
    ticker: TEST_TICKER,
    organizationId: ORG_ID,
    name: 'Open Perp Fee Test Org',
    currentPrice: BASE_PRICE,
    high24h: BASE_PRICE,
    low24h: BASE_PRICE,
    fundingRate: {
      ticker: TEST_TICKER,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
}

async function deleteTestData(): Promise<void> {
  await db.delete(perpPositions).where(eq(perpPositions.ticker, TEST_TICKER));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, TEST_TICKER));
  await db.delete(stockPrices).where(eq(stockPrices.organizationId, ORG_ID));
  await db.delete(organizationState).where(eq(organizationState.id, ORG_ID));
  for (const userId of testUserIds) {
    // IDs enter testUserIds only after a successful User INSERT. Keep fee
    // effects inside that acquired scope and delete children before the user.
    await db
      .delete(tradingFeeOutbox)
      .where(eq(tradingFeeOutbox.userId, userId));
    await db.delete(tradingFees).where(eq(tradingFees.userId, userId));
    for (const table of [agentTrades, agentLogs])
      await db.delete(table).where(eq(table.agentUserId, userId));
    for (const table of [balanceTransactions, pointsTransactions])
      await db.delete(table).where(eq(table.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  expect(await feeCounts()).toEqual(feeBaseline);
}

function runOpenPerp(userId: string, amount: number, leverage: number) {
  const runtime = { agentId: userId } as IAgentRuntime;
  const message = {} as Memory;
  const state = {
    data: {
      actionParams: { ticker: TEST_TICKER, side: 'LONG', amount, leverage },
    },
  } as unknown as State;
  return openPerpAction.handler(runtime, message, state);
}

describe('OPEN_PERP fee-aware balance pre-check (real DB)', () => {
  let exactBalanceUserId = '';
  let fundedUserId = '';
  let leveragedUserId = '';

  beforeAll(async () => {
    feeBaseline = await feeCounts();
    await createTestMarket();
    exactBalanceUserId = await createTestUser('100');
    fundedUserId = await createTestUser('200');
    leveragedUserId = await createTestUser('100.5');
  });

  afterAll(async () => {
    await deleteTestData();
  });

  it('rejects an open whose balance covers the collateral but not the fee', async () => {
    // $100 collateral at 1x: fee is max(100 x 0.1%, $0.01) = $0.10, so the
    // open costs $100.10 and a $100.00 balance must be rejected up front
    // with the insufficient-balance error — not with the service's generic
    // "Failed to open position: Insufficient funds" failure.
    const result = await runOpenPerp(exactBalanceUserId, 100, 1);

    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Insufficient balance');
    expect(result?.text).toContain('100.10');
    expect(result?.text).toContain('fee');

    // No position was created and the balance is untouched.
    const positions = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, exactBalanceUserId));
    expect(positions).toHaveLength(0);
    const balance = await WalletService.getBalance(exactBalanceUserId);
    expect(balance.balance).toBe(100);
  });

  it('rejects a leveraged open whose balance covers the collateral but not the fee', async () => {
    // $100 collateral at 10x: fee is max(1000 x 0.1%, $0.01) = $1.00, so
    // the open costs $101.00 and a $100.50 balance must be rejected.
    const result = await runOpenPerp(leveragedUserId, 100, 10);

    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Insufficient balance');
    expect(result?.text).toContain('101.00');

    const positions = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, leveragedUserId));
    expect(positions).toHaveLength(0);
    const balance = await WalletService.getBalance(leveragedUserId);
    expect(balance.balance).toBe(100.5);
  });

  it('opens when the balance covers collateral plus the trading fee', async () => {
    const result = await runOpenPerp(fundedUserId, 100, 1);

    expect(result?.success).toBe(true);

    const positions = await db
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, fundedUserId));
    expect(positions).toHaveLength(1);

    // $200 - $100 collateral - $0.10 fee.
    const balance = await WalletService.getBalance(fundedUserId);
    expect(balance.balance).toBeCloseTo(99.9, 2);
  });
  it('opens with exactly the canonical fee-inclusive balance', async () => {
    const userId = await createTestUser('100.12');
    const result = await runOpenPerp(userId, 100.01, 1);
    expect(result?.success).toBe(true);
    const positions = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(positions).toHaveLength(1);
    expect(positions[0]?.size).toBe(100.01);
    expect((await WalletService.getBalance(userId)).balance).toBe(0);
  });

  it('reports the rounded-up service fee without debiting a short wallet', async () => {
    const userId = await createTestUser('105.10');
    const result = await runOpenPerp(userId, 105, 1);
    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Insufficient balance');
    expect(result?.values?.required).toBe(105.11);
    expect(result?.text).toContain('$0.11 fee');
    expect(
      await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.userId, userId))
    ).toHaveLength(0);
    expect((await WalletService.getBalance(userId)).balance).toBe(105.1);
  });
});
