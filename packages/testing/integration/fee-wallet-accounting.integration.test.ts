/**
 * Integration Tests: Fee, stability fund, wallet and earned-points accounting
 *
 * Runs against a real Postgres database (DATABASE_URL) because the behaviors
 * under test — atomic increments, row locks and transaction rollback — cannot
 * be proven with mocks.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  actorState,
  balanceTransactions,
  db,
  eq,
  gameConfigs,
  inArray,
  pointsTransactions,
  tradingFees,
  users,
  withTransaction,
} from '@feed/db';
import {
  FeeRedistributionService,
  FeeService,
  STABILITY_FUND_CONFIG,
  StaticDataRegistry,
  WalletService,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const testUserIds: string[] = [];
/** Actor states touched by tests: original balance, or null if we created it */
const touchedActors = new Map<string, string | null>();
let originalFundValue: number | null = null;

async function createTestUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const userId = await generateSnowflakeId();
  const username = `test-acct-${userId.slice(-8)}`;
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-${userId}`,
    username,
    displayName: username,
    profileComplete: true,
    virtualBalance: '1000',
    updatedAt: new Date(),
    ...overrides,
  });
  testUserIds.push(userId);
  return userId;
}

async function getUser(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) throw new Error(`missing user ${userId}`);
  return row;
}

async function getFundBalance(): Promise<number> {
  return FeeRedistributionService.getFundBalance();
}

async function setFundBalance(value: number): Promise<void> {
  await db
    .insert(gameConfigs)
    .values({
      id: STABILITY_FUND_CONFIG.FUND_BALANCE_KEY,
      key: STABILITY_FUND_CONFIG.FUND_BALANCE_KEY,
      value,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gameConfigs.key,
      set: { value, updatedAt: new Date() },
    });
}

async function cleanup(): Promise<void> {
  if (testUserIds.length > 0) {
    await db
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, testUserIds));
    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, testUserIds));
    await db
      .delete(pointsTransactions)
      .where(inArray(pointsTransactions.userId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
    testUserIds.length = 0;
  }
  for (const [actorId, originalBalance] of touchedActors) {
    if (originalBalance === null) {
      await db.delete(actorState).where(eq(actorState.id, actorId));
    } else {
      await db
        .update(actorState)
        .set({ tradingBalance: originalBalance })
        .where(eq(actorState.id, actorId));
    }
  }
  touchedActors.clear();
}

// The stability fund is a global row; preserve whatever value it held.
beforeAll(async () => {
  const [row] = await db
    .select({ value: gameConfigs.value })
    .from(gameConfigs)
    .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));
  originalFundValue = row ? Number(row.value) : null;
});

afterAll(async () => {
  if (originalFundValue === null) {
    await db
      .delete(gameConfigs)
      .where(eq(gameConfigs.key, STABILITY_FUND_CONFIG.FUND_BALANCE_KEY));
  } else {
    await setFundBalance(originalFundValue);
  }
});

describe('FeeService accounting', () => {
  beforeEach(async () => {
    await setFundBalance(0);
  });

  afterAll(cleanup);

  it('allocates the full fee to the platform when there is no referrer', async () => {
    const trader = await createTestUser();

    const result = await FeeService.processTradingFee(trader, 'pred_buy', 1000);

    expect(result.feeCharged).toBe(1);
    expect(result.referrerPaid).toBe(0);
    expect(result.platformReceived).toBe(1);

    const [fee] = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, trader));
    expect(Number(fee?.platformFee)).toBe(1);
    expect(Number(fee?.referrerFee)).toBe(0);
    expect(fee?.referrerId).toBeNull();

    expect(Number((await getUser(trader)).totalFeesPaid)).toBe(1);
    // 30% of the platform share is diverted to the stability fund
    expect(await getFundBalance()).toBeCloseTo(0.3, 6);
  });

  it('does not credit a referrer when a referred user pays a trading fee', async () => {
    const referrer = await createTestUser({ virtualBalance: '250.50' });
    const trader = await createTestUser({ referredBy: referrer });

    const result = await FeeService.processTradingFee(trader, 'pred_buy', 1000);

    expect(result.feeCharged).toBe(1);
    expect(result.referrerPaid).toBe(0);
    expect(result.referrerId).toBeNull();
    expect(result.platformReceived).toBe(1);

    const referrerRow = await getUser(referrer);
    expect(Number(referrerRow.virtualBalance)).toBe(250.5);
    expect(Number(referrerRow.totalFeesEarned ?? 0)).toBe(0);

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, referrer));
    expect(ledger).toHaveLength(0);

    const [fee] = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, trader));
    expect(Number(fee?.platformFee)).toBe(1);
    expect(Number(fee?.referrerFee)).toBe(0);
    expect(fee?.referrerId).toBeNull();
  });

  it('rolls back the fund credit together with the caller transaction', async () => {
    const trader = await createTestUser();

    await expect(
      withTransaction(async (tx) => {
        await FeeService.processTradingFee(
          trader,
          'pred_buy',
          1000,
          undefined,
          undefined,
          tx
        );
        throw new Error('caller failed after fee');
      })
    ).rejects.toThrow('caller failed after fee');

    expect(await getFundBalance()).toBe(0);
    expect(Number((await getUser(trader)).totalFeesPaid)).toBe(0);
    const fees = await db
      .select()
      .from(tradingFees)
      .where(eq(tradingFees.userId, trader));
    expect(fees).toHaveLength(0);
  });

  it('conserves totals under concurrent fees', async () => {
    const trader = await createTestUser();
    const runs = 8;

    await Promise.all(
      Array.from({ length: runs }, () =>
        FeeService.processTradingFee(trader, 'pred_buy', 1000)
      )
    );

    expect(Number((await getUser(trader)).totalFeesPaid)).toBe(runs);
    expect(await getFundBalance()).toBeCloseTo(0.3 * runs, 6);
  });
});

describe('WalletService concurrency and validation', () => {
  afterAll(cleanup);

  it('serializes concurrent debits so balance can never be overspent', async () => {
    const userId = await createTestUser({ virtualBalance: '1000' });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        WalletService.debit(userId, 150, 'test_debit', 'concurrent debit')
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(6);
    expect(Number((await getUser(userId)).virtualBalance)).toBe(100);

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    expect(ledger).toHaveLength(6);
  });

  it('rejects negative and non-finite amounts', async () => {
    const userId = await createTestUser({ virtualBalance: '1000' });

    await expect(
      WalletService.debit(userId, -50, 'test', 'negative debit')
    ).rejects.toThrow('Invalid debit amount');
    await expect(
      WalletService.credit(userId, -50, 'test', 'negative credit')
    ).rejects.toThrow('Invalid credit amount');
    await expect(
      WalletService.credit(userId, Number.NaN, 'test', 'nan credit')
    ).rejects.toThrow('Invalid credit amount');

    expect(Number((await getUser(userId)).virtualBalance)).toBe(1000);
  });

  it('records PnL inside the caller transaction without self-deadlock', async () => {
    const userId = await createTestUser({ virtualBalance: '1000' });

    await withTransaction(async (tx) => {
      await WalletService.debit(
        userId,
        100,
        'test_debit',
        'debit before pnl',
        undefined,
        tx
      );
      await WalletService.recordPnL(userId, 120, 'test_pnl', undefined, tx);
    });

    const row = await getUser(userId);
    expect(Number(row.virtualBalance)).toBe(900);
    expect(Number(row.lifetimePnL)).toBe(120);
    expect(row.earnedPoints).toBe(12);
  });

  it('conserves lifetime PnL under concurrent recordPnL calls', async () => {
    const userId = await createTestUser();

    await Promise.all(
      Array.from({ length: 6 }, () =>
        WalletService.recordPnL(userId, 25, 'test_pnl')
      )
    );

    const row = await getUser(userId);
    expect(Number(row.lifetimePnL)).toBe(150);
    expect(row.earnedPoints).toBe(15);
  });
});

describe('FeeRedistributionService.redistributeFunds', () => {
  afterAll(cleanup);

  it('debits the fund by exactly the amount credited to NPCs', async () => {
    const actor = StaticDataRegistry.getAllActors()[0];
    if (!actor) throw new Error('No static actors available');

    const [existing] = await db
      .select({ tradingBalance: actorState.tradingBalance })
      .from(actorState)
      .where(eq(actorState.id, actor.id));
    touchedActors.set(actor.id, existing ? existing.tradingBalance : null);
    // A zero balance makes this actor the neediest, so it is topped up first.
    await db
      .insert(actorState)
      .values({ id: actor.id, tradingBalance: '0', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: actorState.id,
        set: { tradingBalance: '0', updatedAt: new Date() },
      });
    await setFundBalance(STABILITY_FUND_CONFIG.MIN_FUND_RESERVE + 100_000);

    const result = await FeeRedistributionService.redistributeFunds();

    const detail = result.details.find((d) => d.npcId === actor.id);
    expect(detail?.balanceBefore).toBe(0);
    const [state] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, actor.id));
    expect(Number(state?.tradingBalance)).toBe(detail?.amountReceived ?? -1);
    expect(
      result.details.reduce((sum, d) => sum + d.amountReceived, 0)
    ).toBeCloseTo(result.totalDistributed, 6);
    expect(await getFundBalance()).toBeCloseTo(
      STABILITY_FUND_CONFIG.MIN_FUND_RESERVE +
        100_000 -
        result.totalDistributed,
      6
    );
  });
});
