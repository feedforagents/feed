/**
 * PRD §§9.1/12, MVP Phase 6: the existing cached balance display must agree
 * with committed wallet mutations. All five original cases use a canonical
 * leased child database and its real process-private memory cache. No shared
 * rows or Redis keys are adopted or cleaned up by this fixture.
 */
import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import {
  runIsolatedBalanceDisplayCases,
  verifyBalanceDisplayChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_BALANCE_DISPLAY_CHILD) {
  test('runs all five balance display cases in a leased fresh database', async () => {
    await runIsolatedBalanceDisplayCases();
  }, 300_000);
} else {
  // Establish positive physical ownership before application import side effects.
  await verifyBalanceDisplayChildLease();
  if (process.env.FEED_DISABLE_REDIS !== '1' || process.env.REDIS_URL) {
    throw new Error('Balance fixture requires a private memory cache');
  }
  const { CACHE_KEYS, cachedDb, getCache, invalidateCache, setCache } =
    await import('@feed/api');
  const { closeDatabase, db, eq, users } = await import('@feed/db');
  const { WalletService } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');

  const testUserIds: string[] = [];

  // These nonce keys live only in the child process's real memory cache.
  // Both are installed before all five cases; the second simulates a foreign
  // entry and must survive the primary cleanup before exact control removal.
  let runSentinelKey: string | undefined;
  let foreignSentinelKey: string | undefined;
  let followingKey: string | undefined;

  async function createTestUser(balance: string): Promise<string> {
    const userId = await generateSnowflakeId();
    const username = `test-bal-${userId.slice(-8)}`;
    const [created] = await db
      .insert(users)
      .values({
        id: userId,
        privyId: `did:privy:test-${userId}`,
        username,
        displayName: username,
        profileComplete: true,
        virtualBalance: balance,
        updatedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!created || created.id !== userId)
      throw new Error('User acquisition failed');
    testUserIds.push(created.id);
    return userId;
  }

  async function cachedBalance(userId: string): Promise<number> {
    const data = await cachedDb.getUserBalance(userId);
    if (!data) throw new Error(`no cached balance for ${userId}`);
    return Number(data.virtualBalance);
  }

  beforeAll(async () => {
    // Both keys are acquired by this child before any balance guard or mutation.
    // The second simulates a different owner, but is still this fixture's key.
    runSentinelKey = `sentinel:${await generateSnowflakeId()}`;
    foreignSentinelKey = `sentinel:${await generateSnowflakeId()}`;
    await setCache(runSentinelKey, 'keep-me', { namespace: 'user:follows' });
    await setCache(foreignSentinelKey, 'foreign-keep-me', {
      namespace: 'user:follows',
    });
  });

  afterAll(async () => {
    try {
      // The whole fresh child database owns all users and wallet ledger effects.
      // Never delete rows by owner here: the parent drops only its verified lease
      // after this process and every database client have drained.
      await Promise.all([
        ...testUserIds.map((userId) =>
          cachedDb.invalidateUserBalanceCache(userId)
        ),
        ...(followingKey
          ? [
              invalidateCache(followingKey, {
                namespace: CACHE_KEYS.POSTS_FOLLOWING,
              }),
            ]
          : []),
        ...(runSentinelKey
          ? [invalidateCache(runSentinelKey, { namespace: 'user:follows' })]
          : []),
      ]);
      if (foreignSentinelKey) {
        expect(
          await getCache<string>(foreignSentinelKey, {
            namespace: 'user:follows',
          })
        ).toBe('foreign-keep-me');
      }
      if (runSentinelKey) {
        expect(
          await getCache<string>(runSentinelKey, { namespace: 'user:follows' })
        ).toBeNull();
      }
    } finally {
      try {
        await Promise.all(
          [runSentinelKey, foreignSentinelKey]
            .filter((key): key is string => key !== undefined)
            .map((key) => invalidateCache(key, { namespace: 'user:follows' }))
        );
      } finally {
        await closeDatabase();
      }
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
      await cachedDb.invalidateUserBalanceCache(userId);

      expect(await cachedBalance(userId)).toBe(900);
    });

    it('control: a wallet mutation leaves unrelated follow/feed cache entries alone', async () => {
      const ownSentinel = runSentinelKey;
      const foreignSentinel = foreignSentinelKey;
      if (!ownSentinel || !foreignSentinel) {
        throw new Error('Sentinel setup did not complete');
      }
      const userId = await createTestUser('1000');
      const authorId = await createTestUser('1000');

      // Warm the owner's following-feed cache, as the feed view does.
      // getPostsForFollowing caches under `<userId>:100:offset:0` in the
      // posts:following namespace (default limit 100, no cursor).
      const followingCacheKey = `${userId}:100:offset:0`;
      followingKey = followingCacheKey;
      await cachedDb.getPostsForFollowing(userId, [authorId]);
      expect(
        await getCache(followingCacheKey, {
          namespace: CACHE_KEYS.POSTS_FOLLOWING,
        })
      ).not.toBeNull();

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
        await getCache(followingCacheKey, {
          namespace: CACHE_KEYS.POSTS_FOLLOWING,
        })
      ).not.toBeNull();
      expect(
        await getCache<string>(ownSentinel, { namespace: 'user:follows' })
      ).toBe('keep-me');
      expect(
        await getCache<string>(foreignSentinel, { namespace: 'user:follows' })
      ).toBe('foreign-keep-me');
    });
  });
}
