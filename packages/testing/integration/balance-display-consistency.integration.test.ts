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
import { CACHE_KEYS, cachedDb, getCache, setCache } from '@feed/api';
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
  // Clear the fixture's owned cached keys (balance/user/profile entries
  // warmed by the tests, plus any following-feed entries) so no test
  // user's stale cache survives the run.
  await Promise.all(
    testUserIds.map((userId) => cachedDb.invalidateUserCache(userId))
  );
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

  it('control: a wallet mutation leaves unrelated follow/feed cache entries alone', async () => {
    const userId = await createTestUser('1000');
    const authorId = await createTestUser('1000');

    // Warm the owner's following-feed cache, as the feed view does.
    // getPostsForFollowing caches under `<userId>:100:offset:0` in the
    // posts:following namespace (default limit 100, no cursor).
    const followingKey = `${userId}:100:offset:0`;
    await cachedDb.getPostsForFollowing(userId, [authorId]);
    expect(
      await getCache(followingKey, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      })
    ).not.toBeNull();

    // Sentinel in the global follows namespace: nothing writes here, so
    // only a pattern scan could remove it.
    await setCache('sentinel', 'keep-me', { namespace: 'user:follows' });

    // The mutation path every trade/settlement uses.
    await WalletService.credit(
      userId,
      250,
      'pred_resolve',
      'Prediction market settlement payout'
    );

    // The balance display still refreshes: the new callback invalidates
    // the exact balance keys.
    expect(await cachedBalance(userId)).toBe(1250);

    // ...but the unrelated entries survive: no pattern scan ran.
    expect(
      await getCache(followingKey, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      })
    ).not.toBeNull();
    expect(
      await getCache('sentinel', { namespace: 'user:follows' })
    ).toBe('keep-me');
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
