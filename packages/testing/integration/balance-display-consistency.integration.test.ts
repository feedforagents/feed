/**
 * Integration Tests: balance display consistency after wallet mutations
 *
 * The header / mobile header / wallet surfaces read the balance through
 * `GET /api/users/[userId]/balance`, whose only data path is
 * `cachedDb.getUserBalance` (30 s server cache). Trades, settlement payouts
 * and other credits mutate the balance through `WalletService.debit/credit`,
 * which are supposed to invalidate that cache via the registered
 * cache-invalidation callback. These tests drive the real services against a
 * real Postgres database: warm the cached read, mutate through
 * WalletService, and require the cached read (the display path) to agree
 * with the ledger read (`WalletService.getBalance`).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { cachedDb } from '@feed/api';
import { balanceTransactions, db, eq, inArray, users } from '@feed/db';
import { WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const testUserIds: string[] = [];

async function createTestUser(balance: string): Promise<string> {
  const userId = await generateSnowflakeId();
  const username = `test-bal-${userId.slice(-8)}`;
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-${userId}`,
    username,
    displayName: username,
    profileComplete: true,
    virtualBalance: balance,
    updatedAt: new Date(),
  });
  testUserIds.push(userId);
  return userId;
}

async function cachedBalance(userId: string): Promise<number> {
  const data = await cachedDb.getUserBalance(userId);
  if (!data) throw new Error(`no cached balance for ${userId}`);
  return Number(data.virtualBalance);
}

afterAll(async () => {
  if (testUserIds.length === 0) return;
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, testUserIds));
  await db.delete(users).where(inArray(users.id, testUserIds));
});

describe('balance display path vs wallet ledger', () => {
  it('a settlement-style credit is visible on the cached display path immediately', async () => {
    const userId = await createTestUser('1000');

    // Warm the display cache, as any header/wallet view does.
    expect(await cachedBalance(userId)).toBe(1000);

    // The mutation path every trade/settlement uses.
    await WalletService.credit(
      userId,
      250,
      'pred_resolve',
      'Prediction market settlement payout'
    );

    // Ledger read (trade previews, A2A/MCP) already shows the new balance.
    const ledger = await WalletService.getBalance(userId);
    expect(ledger.balance).toBe(1250);

    // The display path must agree without waiting for the cache TTL.
    expect(await cachedBalance(userId)).toBe(1250);
  });

  it('a buy-style debit is visible on the cached display path immediately', async () => {
    const userId = await createTestUser('1000');

    expect(await cachedBalance(userId)).toBe(1000);

    await WalletService.debit(userId, 400, 'pred_buy', 'Buying shares');

    const ledger = await WalletService.getBalance(userId);
    expect(ledger.balance).toBe(600);

    expect(await cachedBalance(userId)).toBe(600);
  });

  it('guard: an untouched user reads the same balance on both paths', async () => {
    const userId = await createTestUser('777');

    expect(await cachedBalance(userId)).toBe(777);
    const ledger = await WalletService.getBalance(userId);
    expect(ledger.balance).toBe(777);
    // Second read is served from the cache and still agrees.
    expect(await cachedBalance(userId)).toBe(777);
  });

  it('guard: explicit cache invalidation still refreshes the display path', async () => {
    const userId = await createTestUser('500');

    expect(await cachedBalance(userId)).toBe(500);

    await db
      .update(users)
      .set({ virtualBalance: '900' })
      .where(eq(users.id, userId));
    await cachedDb.invalidateUserCache(userId);

    expect(await cachedBalance(userId)).toBe(900);
  });
});
