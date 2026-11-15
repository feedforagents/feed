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

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CACHE_KEYS,
  cachedDb,
  getCache,
  invalidateCache,
  invalidateCachePattern,
  setCache,
} from '@feed/api';
import { balanceTransactions, db, eq, inArray, users } from '@feed/db';
import { WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const testUserIds: string[] = [];

// Sentinel keys in the global `user:follows` namespace. Both carry a fresh
// snowflake suffix, so this run never overwrites an entry another run or
// user wrote. `runSentinelKey` is owned by this run (written by the control
// test) and teardown deletes exactly that key; `foreignSentinelKey`
// simulates another user's entry, is installed by beforeAll before any test
// phase runs, and must survive teardown.
let runSentinelKey: string | undefined;
let foreignSentinelKey: string | undefined;

// Install the foreign sentinel before every phase the isolation claim
// covers: the guard, the mutation paths and teardown. Its survival then
// proves the whole fixture lifecycle leaves unrelated entries alone —
// not just the phases after the last broad invalidation.
beforeAll(async () => {
  const foreignUserId = await generateSnowflakeId();
  foreignSentinelKey = `sentinel:${foreignUserId}`;
  await setCache(foreignSentinelKey, 'foreign-keep-me', {
    namespace: 'user:follows',
  });
});

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
  // Clear only the fixture's own cached keys: the exact balance/user/
  // profile keys (via the balance-scoped invalidator) plus this run's
  // following-feed entries. Never call the broad invalidateUserCache
  // here — it pattern-scans the global `user:follows` namespace and
  // would evict other users' follow cache entries.
  await Promise.all([
    ...testUserIds.map((userId) => cachedDb.invalidateUserBalanceCache(userId)),
    ...testUserIds.map((userId) =>
      invalidateCachePattern(`${userId}:*`, {
        namespace: CACHE_KEYS.POSTS_FOLLOWING,
      })
    ),
    ...(runSentinelKey
      ? [invalidateCache(runSentinelKey, { namespace: 'user:follows' })]
      : []),
  ]);
  // The foreign sentinel simulates another user's follow-cache entry: it
  // must survive this file's teardown, while this run's own sentinel is gone.
  if (foreignSentinelKey) {
    expect(
      await getCache<string>(foreignSentinelKey, { namespace: 'user:follows' })
    ).toBe('foreign-keep-me');
  }
  if (runSentinelKey) {
    expect(
      await getCache<string>(runSentinelKey, { namespace: 'user:follows' })
    ).toBeNull();
  }
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
    // Balance-scoped only: the broad invalidateUserCache pattern-scans the
    // global `user:follows` namespace, which would evict unrelated entries
    // mid-suite. The display path only needs its own exact keys cleared.
    await cachedDb.invalidateUserBalanceCache(userId);

    expect(await cachedBalance(userId)).toBe(900);
  });

  // The control test runs last so its sentinels are checked after the
  // mutation path; the foreign sentinel was installed by beforeAll, so it
  // also covers the guard and earlier mutation phases above.
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

    // Run-specific sentinel in the global follows namespace: the suffix
    // is a fresh snowflake id, so this run never overwrites an entry
    // another run or user wrote. Only a pattern scan could remove it.
    // The foreign sentinel was installed by beforeAll and is asserted
    // below; it is not re-created here.
    runSentinelKey = `sentinel:${userId}`;
    await setCache(runSentinelKey, 'keep-me', { namespace: 'user:follows' });
    if (!foreignSentinelKey) {
      throw new Error('foreign sentinel was not installed by beforeAll');
    }

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
      await getCache<string>(runSentinelKey, { namespace: 'user:follows' })
    ).toBe('keep-me');
    expect(
      await getCache<string>(foreignSentinelKey, { namespace: 'user:follows' })
    ).toBe('foreign-keep-me');
  });
});
