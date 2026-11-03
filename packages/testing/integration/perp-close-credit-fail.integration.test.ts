/**
 * Integration test: closePosition credit failure must reopen the position.
 *
 * Production close wiring (close-perp.ts, MCP, A2A) injects
 * createUserWalletAdapter() with no shared tx, so the close DB transaction
 * commits before WalletService.credit runs. When credit throws, the fix
 * best-effort reopens via PerpDbAdapter.upsertPosition({ closedAt: null })
 * against real Postgres (Drizzle onConflictDoUpdate writes null closedAt).
 *
 * Run with:
 *   DATABASE_URL=postgresql://feed:feed_dev_password@127.0.0.1:5432/feed \
 *     bun test packages/testing/integration/perp-close-credit-fail.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
  type WalletPort,
} from '@feed/core/markets/perps';
import {
  and,
  balanceTransactions,
  db,
  eq,
  isNull,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  users,
} from '@feed/db';
import { createUserWalletAdapter, WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const BASE_PRICE = 100;
const STARTING_BALANCE = 10_000;

let ticker = '';
let orgId = '';
let userId = '';
let positionId = '';

const priceImpact: PriceImpactPort = {
  async applyAndGetPrice() {
    return BASE_PRICE;
  },
  async getBasePrice() {
    return BASE_PRICE;
  },
};

function wrapWallet(failCredits: { value: boolean }): WalletPort {
  const base = createUserWalletAdapter();
  return {
    debit: (args) => base.debit(args),
    credit: async (args) => {
      if (failCredits.value) {
        throw new Error('wallet credit failed');
      }
      return base.credit(args);
    },
    recordPnL: (args) => base.recordPnL(args),
    getBalance: (id) => base.getBalance(id),
  };
}

function serviceWith(
  adapter: PerpDbAdapter,
  failCredits: { value: boolean }
): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: adapter,
    wallet: wrapWallet(failCredits),
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.5,
      referrerShare: 0.5,
      minFeeAmount: 0.01,
    },
    priceImpact,
  };
  return new PerpMarketService(deps);
}

async function readBalance(id: string): Promise<number> {
  return (await WalletService.getBalance(id)).balance;
}

async function openRows() {
  return db
    .select()
    .from(perpPositions)
    .where(
      and(eq(perpPositions.userId, userId), isNull(perpPositions.closedAt))
    );
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  ticker = `CLOSECRED${suffix}`.toUpperCase();
  orgId = `test-close-credit-org-${suffix}`;
  userId = await generateSnowflakeId();
  const now = new Date();

  await db.insert(organizationState).values({
    id: orgId,
    currentPrice: BASE_PRICE,
    basePrice: BASE_PRICE,
    updatedAt: now,
  });
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'Close Credit Fail Test',
    currentPrice: BASE_PRICE,
    high24h: BASE_PRICE,
    low24h: BASE_PRICE,
    fundingRate: {
      ticker,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-close-credit-${userId}`,
    username: `close-credit-${userId.slice(-8)}`,
    displayName: `close-credit-${userId.slice(-8)}`,
    virtualBalance: STARTING_BALANCE.toFixed(2),
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });

  const opened = await serviceWith(new PerpDbAdapter(), {
    value: false,
  }).openPosition({
    userId,
    ticker,
    side: 'long',
    size: 100,
    leverage: 10,
  });
  positionId = opened.positionId;
});

afterAll(async () => {
  await db.delete(perpPositions).where(eq(perpPositions.ticker, ticker));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await db.delete(organizationState).where(eq(organizationState.id, orgId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('closePosition against real Postgres (credit-fail reopen)', () => {
  it('reopens the position when settlement credit fails after DB close', async () => {
    const before = await readBalance(userId);
    // Margin 10 + fee 0.1 already debited on open.
    expect(before).toBeCloseTo(STARTING_BALANCE - 10.1, 6);
    expect(await openRows()).toHaveLength(1);

    const failCredits = { value: true };
    await expect(
      serviceWith(new PerpDbAdapter(), failCredits).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('wallet credit failed');

    // Balance unchanged: credit never applied; reopen restored the row.
    const afterFail = await readBalance(userId);
    expect(afterFail).toBeCloseTo(before, 6);

    const rows = await openRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(positionId);
    expect(rows[0]!.closedAt).toBeNull();

    // Raw row confirms Drizzle upsert wrote null closedAt (not left closed).
    const raw = await db
      .select({ id: perpPositions.id, closedAt: perpPositions.closedAt })
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(raw[0]!.closedAt).toBeNull();

    // Retry close once credit works.
    failCredits.value = false;
    const closed = await serviceWith(
      new PerpDbAdapter(),
      failCredits
    ).closePosition({
      userId,
      positionId,
    });
    expect(closed.positionId).toBe(positionId);
    expect(await openRows()).toHaveLength(0);

    const afterClose = await readBalance(userId);
    // Settlement ≈ margin 10 - fee 0.1 = 9.9 → balance ≈ 9989.9 + 9.9 = 9999.8
    expect(afterClose).toBeGreaterThan(before);
    expect(afterClose).toBeCloseTo(STARTING_BALANCE - 0.2, 1);
  });
});
