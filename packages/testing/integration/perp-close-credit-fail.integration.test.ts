/**
 * Integration test: closePosition credit failure must reopen the position.
 *
 * Production close wiring (close-perp.ts, MCP, A2A) injects
 * createUserWalletAdapter() with no shared tx, so the close DB transaction
 * commits before WalletService.credit runs. When credit is known not to have
 * applied, the fix reopens against real Postgres and reverses volume. A
 * timeout after the credit has landed must leave the close in place.
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
import { WalletCreditNotAppliedError } from '@feed/core/markets/shared';
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

type CreditMode =
  | 'ok'
  | 'not-applied'
  | 'timeout-after-applied'
  | 'timeout-before-applied'
  | 'tamper-then-not-applied';

const priceImpact: PriceImpactPort = {
  async applyAndGetPrice() {
    return BASE_PRICE;
  },
  async getBasePrice() {
    return BASE_PRICE;
  },
};

function wrapWallet(
  mode: { value: CreditMode },
  tamperPositionId: { value: string }
): WalletPort {
  const base = createUserWalletAdapter();
  return {
    debit: (args) => base.debit(args),
    credit: async (args) => {
      if (mode.value === 'tamper-then-not-applied') {
        await db
          .update(perpPositions)
          .set({ fundingPaid: 77 })
          .where(eq(perpPositions.id, tamperPositionId.value));
        throw new WalletCreditNotAppliedError('wallet credit failed');
      }
      if (mode.value === 'not-applied') {
        throw new WalletCreditNotAppliedError('wallet credit failed');
      }
      if (mode.value === 'timeout-before-applied') {
        throw new Error('credit timeout');
      }
      const result = await base.credit(args);
      if (mode.value === 'timeout-after-applied') {
        throw new Error('credit timeout');
      }
      return result;
    },
    recordPnL: (args) => base.recordPnL(args),
    getBalance: (id) => base.getBalance(id),
  };
}

function serviceWith(
  adapter: PerpDbAdapter,
  mode: { value: CreditMode },
  tamperPositionId: { value: string }
): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: adapter,
    wallet: wrapWallet(mode, tamperPositionId),
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

async function readMarket(): Promise<{
  volume24h: number;
  openInterest: number;
}> {
  const [row] = await db
    .select({
      volume24h: perpMarketSnapshots.volume24h,
      openInterest: perpMarketSnapshots.openInterest,
    })
    .from(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  return {
    volume24h: Number(row?.volume24h ?? 0),
    openInterest: Number(row?.openInterest ?? 0),
  };
}

async function closeOpenPositions(): Promise<void> {
  const rows = await openRows();
  for (const row of rows) {
    await serviceWith(
      new PerpDbAdapter(),
      { value: 'ok' },
      { value: '' }
    ).closePosition({
      userId,
      positionId: row.id,
    });
  }
}

async function openLong(size = 100): Promise<string> {
  // Same user and ticker consolidate into one open row. Finish any leftover
  // position so each test starts from a fresh open of `size`.
  await closeOpenPositions();
  const opened = await serviceWith(
    new PerpDbAdapter(),
    { value: 'ok' },
    { value: '' }
  ).openPosition({
    userId,
    ticker,
    side: 'long',
    size,
    leverage: 10,
  });
  return opened.positionId;
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
    const positionId = await openLong();
    const before = await readBalance(userId);
    const marketBefore = await readMarket();

    const mode: { value: CreditMode } = { value: 'not-applied' };
    await expect(
      serviceWith(new PerpDbAdapter(), mode, {
        value: positionId,
      }).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('wallet credit failed');

    const afterFail = await readBalance(userId);
    expect(afterFail).toBeCloseTo(before, 6);

    const rows = await openRows();
    expect(rows.some((row) => row.id === positionId)).toBe(true);
    const raw = await db
      .select({ id: perpPositions.id, closedAt: perpPositions.closedAt })
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(raw[0]!.closedAt).toBeNull();

    const marketAfter = await readMarket();
    expect(marketAfter.volume24h).toBeCloseTo(marketBefore.volume24h, 6);
    expect(marketAfter.openInterest).toBeCloseTo(marketBefore.openInterest, 6);

    mode.value = 'ok';
    const closed = await serviceWith(new PerpDbAdapter(), mode, {
      value: positionId,
    }).closePosition({
      userId,
      positionId,
    });
    expect(closed.positionId).toBe(positionId);
    expect((await openRows()).some((row) => row.id === positionId)).toBe(false);

    const afterClose = await readBalance(userId);
    expect(afterClose).toBeGreaterThan(before);
  });

  it('restores partial-close mark-to-market and reverses volume', async () => {
    const positionId = await openLong();
    await db
      .update(perpPositions)
      .set({
        unrealizedPnL: 42,
        unrealizedPnLPercent: 3.5,
        fundingPaid: 1.25,
      })
      .where(eq(perpPositions.id, positionId));
    const marketBefore = await readMarket();

    await expect(
      serviceWith(
        new PerpDbAdapter(),
        { value: 'not-applied' },
        { value: positionId }
      ).closePosition({
        userId,
        positionId,
        percentage: 0.5,
        exitPriceOverride: 110,
      })
    ).rejects.toThrow('wallet credit failed');

    const [row] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(row!.closedAt).toBeNull();
    expect(Number(row!.size)).toBeCloseTo(100, 6);
    expect(Number(row!.fundingPaid)).toBeCloseTo(1.25, 6);
    expect(Number(row!.unrealizedPnL)).toBeCloseTo(42, 6);
    expect(Number(row!.unrealizedPnLPercent)).toBeCloseTo(3.5, 6);

    const marketAfter = await readMarket();
    expect(marketAfter.volume24h).toBeCloseTo(marketBefore.volume24h, 6);
    expect(marketAfter.openInterest).toBeCloseTo(marketBefore.openInterest, 6);
  });

  it('refuses to reopen when funding changed after the close', async () => {
    const positionId = await openLong();
    const marketBefore = await readMarket();

    await expect(
      serviceWith(
        new PerpDbAdapter(),
        { value: 'tamper-then-not-applied' },
        { value: positionId }
      ).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('wallet credit failed');

    const [row] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(row!.closedAt).not.toBeNull();
    expect(Number(row!.fundingPaid)).toBeCloseTo(77, 6);

    const marketAfter = await readMarket();
    expect(marketAfter.volume24h).toBeCloseTo(marketBefore.volume24h + 100, 6);
    expect(marketAfter.openInterest).toBeCloseTo(
      marketBefore.openInterest - 100,
      6
    );
  });

  it('leaves the close in place when credit times out after it is applied', async () => {
    const positionId = await openLong();
    const before = await readBalance(userId);
    const marketBefore = await readMarket();

    await expect(
      serviceWith(
        new PerpDbAdapter(),
        { value: 'timeout-after-applied' },
        { value: positionId }
      ).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('credit timeout');

    const [row] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(row!.closedAt).not.toBeNull();
    const paid = await readBalance(userId);
    expect(paid).toBeGreaterThan(before);

    const marketAfter = await readMarket();
    expect(marketAfter.volume24h).toBeCloseTo(marketBefore.volume24h + 100, 6);
    expect(marketAfter.openInterest).toBeCloseTo(
      marketBefore.openInterest - 100,
      6
    );

    await expect(
      serviceWith(
        new PerpDbAdapter(),
        { value: 'ok' },
        { value: positionId }
      ).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('already closed');
    expect(await readBalance(userId)).toBeCloseTo(paid, 6);
  });

  it('reopens when a timeout happens before the credit is applied', async () => {
    const positionId = await openLong();
    const before = await readBalance(userId);
    const marketBefore = await readMarket();

    await expect(
      serviceWith(
        new PerpDbAdapter(),
        { value: 'timeout-before-applied' },
        { value: positionId }
      ).closePosition({
        userId,
        positionId,
      })
    ).rejects.toThrow('credit timeout');

    expect(await readBalance(userId)).toBeCloseTo(before, 6);
    const [row] = await db
      .select({ closedAt: perpPositions.closedAt })
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId));
    expect(row!.closedAt).toBeNull();
    const marketAfter = await readMarket();
    expect(marketAfter.volume24h).toBeCloseTo(marketBefore.volume24h, 6);
    expect(marketAfter.openInterest).toBeCloseTo(marketBefore.openInterest, 6);
  });
});
