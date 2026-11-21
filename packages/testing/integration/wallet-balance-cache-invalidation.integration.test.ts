/**
 * Integration Tests: Wallet balance cache invalidation (PRD §9.1)
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied. Every test returns early when no database is reachable, the
 * convention of this directory.
 *
 * WalletService.setCacheInvalidationCallback had no installer anywhere in the
 * repo, so debit/credit/recordPnL called a no-op and the cached balance row
 * (`user:balance:<id>`, 30s TTL behind GET /api/users/[userId]/balance) kept
 * serving pre-trade values while the buy/sell response already carried the
 * new one. PRD §9.1 requires the books to agree with what the trader was
 * charged. Each case warms the cache through the same cachedDb.getUserBalance
 * path the balance route uses, mutates through the real WalletService, and
 * asserts the very next read already sees the mutation.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { cachedDb, clearAllCache } from '@feed/api';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  pointsTransactions,
  sql,
  users,
} from '@feed/db';
import { WalletService } from '@feed/engine/services/wallet-service';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(30000);

let dbAvailable = false;
const testUserIds: string[] = [];

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

async function createTestUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-${id}`,
    username: `wbalance-${id}`,
    displayName: 'wbalance',
    virtualBalance: '1000',
    totalDeposited: '1000',
    totalWithdrawn: '0',
    lifetimePnL: '0.00',
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  testUserIds.push(id);
  return id;
}

async function cachedBalance(userId: string): Promise<{
  virtualBalance: number;
  lifetimePnL: number;
}> {
  const row = await cachedDb.getUserBalance(userId);
  return {
    virtualBalance: Number(row?.virtualBalance),
    lifetimePnL: Number(row?.lifetimePnL),
  };
}

describe('wallet balance cache invalidation', () => {
  beforeAll(async () => {
    dbAvailable = await checkDatabaseHealth();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, testUserIds));
    await db
      .delete(pointsTransactions)
      .where(inArray(pointsTransactions.userId, testUserIds));
    await db.delete(users).where(inArray(users.id, testUserIds));
    await clearAllCache();
  });

  test('the balance row is genuinely cached before any mutation runs', async () => {
    if (!dbAvailable) return;

    const userId = await createTestUser();
    expect((await cachedBalance(userId)).virtualBalance).toBe(1000);

    // Bypass WalletService so no invalidation hook can run: the next read
    // must still return the warm value. This is what makes the mutation
    // cases below depend on the hook rather than on the cache never being
    // populated in the first place.
    await db
      .update(users)
      .set({ virtualBalance: '777' })
      .where(eq(users.id, userId));
    expect((await cachedBalance(userId)).virtualBalance).toBe(1000);
  });

  test('debit drops the cached balance', async () => {
    if (!dbAvailable) return;

    const userId = await createTestUser();
    expect((await cachedBalance(userId)).virtualBalance).toBe(1000);

    await WalletService.debit(
      userId,
      100,
      'test_debit',
      'cache invalidation test'
    );

    expect((await cachedBalance(userId)).virtualBalance).toBe(900);
  });

  test('credit drops the cached balance', async () => {
    if (!dbAvailable) return;

    const userId = await createTestUser();
    expect((await cachedBalance(userId)).virtualBalance).toBe(1000);

    await WalletService.credit(
      userId,
      50,
      'test_credit',
      'cache invalidation test'
    );

    expect((await cachedBalance(userId)).virtualBalance).toBe(1050);
  });

  test('recordPnL drops the cached lifetimePnL', async () => {
    if (!dbAvailable) return;

    const userId = await createTestUser();
    expect((await cachedBalance(userId)).lifetimePnL).toBe(0);

    await WalletService.recordPnL(userId, 42, 'test_pnl');

    const after = await cachedBalance(userId);
    expect(after.lifetimePnL).toBe(42);
    expect(after.virtualBalance).toBe(1000);
  });
});
