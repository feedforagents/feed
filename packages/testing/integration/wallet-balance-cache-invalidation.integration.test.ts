/** Committed wallet P&L must reach the cached balance display (PRD §9.1). */
import { expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const standalone = 'standalone P&L write refreshes the cached wallet';
const settlement = 'settlement refreshes the cached wallet after commit';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks wallet P&L cache invalidation in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'wallet-pnl-cache-invalidation',
      file: 'packages/testing/integration/wallet-balance-cache-invalidation.integration.test.ts',
      cases: [standalone, settlement],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  if (process.env.FEED_DISABLE_REDIS !== '1' || process.env.REDIS_URL) {
    throw new Error('Wallet P&L fixture requires a private memory cache');
  }

  const { cachedDb } = await import('@feed/api');
  const { db, users } = await import('@feed/db');
  const { createPerpSettlement, WalletService } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');

  async function createUser() {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `test-wallet-pnl-${id}`,
      virtualBalance: '1000',
      totalDeposited: '1000',
      lifetimePnL: '0.00',
      updatedAt: new Date(),
    });
    return id;
  }

  async function displayedWallet(userId: string) {
    const row = await cachedDb.getUserBalance(userId);
    if (!row) throw new Error(`Missing wallet balance for ${userId}`);
    return {
      balance: Number(row.virtualBalance),
      lifetimePnL: Number(row.lifetimePnL),
    };
  }

  test(standalone, async () => {
    const userId = await createUser();
    const before = await displayedWallet(userId);
    expect(before).toEqual({ balance: 1000, lifetimePnL: 0 });

    const committed = await WalletService.recordPnL(userId, 42, 'test_pnl');
    const after = await displayedWallet(userId);
    console.info('Standalone wallet P&L', { userId, before, committed, after });
    expect(committed.newLifetimePnL).toBe(42);
    expect(after).toEqual({ balance: 1000, lifetimePnL: 42 });
  });

  test(settlement, async () => {
    const userId = await createUser();
    const before = await displayedWallet(userId);
    expect(before).toEqual({ balance: 1000, lifetimePnL: 0 });

    const beforeCommit = await createPerpSettlement().run(
      userId,
      async (_positions, wallet) => {
        await wallet.recordPnL({ userId, pnl: -42, reason: 'perp_close' });
        // Another reader still sees the old committed row. If the adapter
        // invalidates early, this read repopulates the cache before commit.
        return displayedWallet(userId);
      }
    );
    expect(beforeCommit).toEqual(before);

    const afterCommit = await displayedWallet(userId);
    console.info('Settlement wallet P&L', {
      userId,
      before,
      beforeCommit,
      afterCommit,
    });
    expect(afterCommit).toEqual({ balance: 1000, lifetimePnL: -42 });
  });
}
