/**
 * Integration test: a failed flip debit must not leave a committed unpaid inverse.
 *
 * Production wiring (MCP buildWalletPort, close-perp/open-perp, A2A) injects
 * createUserWalletAdapter() with no shared tx client, so WalletService.debit
 * runs its own withTransaction when called from inside PerpDbAdapter.transaction.
 * Correct shape: net wallet mutation LAST inside the DB callback so a debit
 * throw aborts the callback and rolls the flip back. Post-commit debit would
 * leave a committed-but-unpaid short (Slopbot regression on #1592).
 *
 * Run with:
 *   DATABASE_URL=postgresql://feed:feed_dev_password@127.0.0.1:5432/feed \
 *     bun test packages/testing/integration/perp-flip-debit-fail.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
} from '@feed/core/markets/perps';
import type { FeeProcessor, WalletPort } from '@feed/core/markets/shared';
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
let longPositionId = '';

const priceImpact: PriceImpactPort = {
  async applyAndGetPrice() {
    return BASE_PRICE;
  },
  async getBasePrice() {
    return BASE_PRICE;
  },
};

function serviceWith(adapter: PerpDbAdapter): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: adapter,
    wallet: createUserWalletAdapter(),
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
  ticker = `FLIPDEBIT${suffix}`.toUpperCase();
  orgId = `test-flip-debit-org-${suffix}`;
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
    name: 'Flip Debit Fail Test',
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
    privyId: `did:privy:test-flip-debit-${userId}`,
    username: `flip-debit-${userId.slice(-8)}`,
    displayName: `flip-debit-${userId.slice(-8)}`,
    virtualBalance: STARTING_BALANCE.toFixed(2),
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });

  // Seed an open long so the flip path is exercised (not a fresh open).
  const adapter = new PerpDbAdapter();
  const opened = await serviceWith(adapter).openPosition({
    userId,
    ticker,
    side: 'long',
    size: 100,
    leverage: 10,
  });
  longPositionId = opened.positionId;
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

describe('flip against real Postgres (wallet last in TX)', () => {
  it('rolls back the flip when net debit fails — no committed-but-unpaid short', async () => {
    const beforeRows = await openRows();
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0]!.side).toBe('long');
    expect(beforeRows[0]!.id).toBe(longPositionId);

    // Drain spendable balance so the flip's net debit (~0.2) fails inside the
    // TX callback. Post-commit debit would leave the short committed unpaid.
    await db
      .update(users)
      .set({ virtualBalance: '0.00' })
      .where(eq(users.id, userId));
    const before = await readBalance(userId);
    expect(before).toBeCloseTo(0, 6);

    const adapter = new PerpDbAdapter();
    await expect(
      serviceWith(adapter).openPosition({
        userId,
        ticker,
        side: 'short',
        size: 200,
        leverage: 10,
      })
    ).rejects.toThrow();

    const after = await readBalance(userId);
    expect(after).toBeCloseTo(before, 6);

    const rows = await openRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.side).toBe('long');
    expect(rows[0]!.id).toBe(longPositionId);
    expect(rows[0]!.size).toBeCloseTo(100, 6);

    // Restore balance for the success case below.
    await db
      .update(users)
      .set({ virtualBalance: '5000.00' })
      .where(eq(users.id, userId));
  });

  it('still flips and debits when the wallet can pay', async () => {
    const before = await readBalance(userId);
    expect(before).toBeGreaterThan(1);

    const adapter = new PerpDbAdapter();
    const flipped = await serviceWith(adapter).openPosition({
      userId,
      ticker,
      side: 'short',
      size: 200,
      leverage: 10,
    });

    const after = await readBalance(userId);
    expect(after).toBeLessThan(before);
    expect(flipped.side).toBe('short');

    const rows = await openRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.side).toBe('short');
    expect(rows[0]!.id).toBe(flipped.positionId);
  });
});

/**
 * Post-commit recordPnL failure on a flip that real Postgres already committed.
 * The wallet adapter is the production one; only recordPnL is fault-injected.
 * An error-driven client retry must not send a second flip.
 */
describe('flip recordPnL failure after commit (real Postgres)', () => {
  it('returns the committed flip when recordPnL keeps failing, and fees still run', async () => {
    await withIsolatedLong('pnl-fail', async ({ userId: id, ticker: tick }) => {
      const wallet = walletThatFailsPnL(Number.POSITIVE_INFINITY);
      const fees = recordingFees();
      const before = await readBalance(id);
      const lifetimeBefore = await readLifetimePnL(id);
      const flipsBefore = await countFlipDebits(id);

      let clientAttempts = 0;
      const flipped = await (async () => {
        try {
          clientAttempts++;
          return await serviceWithWallet(
            new PerpDbAdapter(),
            wallet,
            fees
          ).openPosition({
            userId: id,
            ticker: tick,
            side: 'short',
            size: 200,
            leverage: 10,
          });
        } catch {
          clientAttempts++;
          return await serviceWithWallet(
            new PerpDbAdapter(),
            wallet,
            fees
          ).openPosition({
            userId: id,
            ticker: tick,
            side: 'short',
            size: 200,
            leverage: 10,
          });
        }
      })();

      expect(clientAttempts).toBe(1);
      expect(flipped.side).toBe('short');
      expect(flipped.rebalanceType).toBe('flip');
      expect(wallet.pnlAttempts).toBe(3);

      const after = await readBalance(id);
      expect(after).toBeLessThan(before);
      expect(await countFlipDebits(id)).toBe(flipsBefore + 1);
      expect(await readLifetimePnL(id)).toBeCloseTo(lifetimeBefore, 6);

      const rows = await db
        .select()
        .from(perpPositions)
        .where(
          and(eq(perpPositions.userId, id), isNull(perpPositions.closedAt))
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.side).toBe('short');
      expect(rows[0]!.size).toBeCloseTo(100, 6);
      expect(fees.types.sort()).toEqual(['perp_close', 'perp_flip_position']);
    });
  });

  it('retries recordPnL on the committed flip without a second wallet debit', async () => {
    await withIsolatedLong(
      'pnl-retry',
      async ({ userId: id, ticker: tick }) => {
        const wallet = walletThatFailsPnL(1);
        const before = await readBalance(id);
        const lifetimeBefore = await readLifetimePnL(id);

        const flipped = await serviceWithWallet(
          new PerpDbAdapter(),
          wallet
        ).openPosition({
          userId: id,
          ticker: tick,
          side: 'short',
          size: 200,
          leverage: 10,
        });

        expect(flipped.side).toBe('short');
        expect(wallet.pnlAttempts).toBe(2);
        expect(await readBalance(id)).toBeLessThan(before);
        expect(await countFlipDebits(id)).toBe(1);
        expect(await readLifetimePnL(id)).not.toBeCloseTo(lifetimeBefore, 6);

        const rows = await db
          .select()
          .from(perpPositions)
          .where(
            and(eq(perpPositions.userId, id), isNull(perpPositions.closedAt))
          );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.side).toBe('short');
        expect(rows[0]!.id).toBe(flipped.positionId);
      }
    );
  });
});

function serviceWithWallet(
  adapter: PerpDbAdapter,
  wallet: WalletPort,
  feeProcessor?: FeeProcessor
): PerpMarketService {
  const deps: PerpServiceDeps = {
    db: adapter,
    wallet,
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.5,
      referrerShare: 0.5,
      minFeeAmount: 0.01,
    },
    priceImpact,
    feeProcessor,
  };
  return new PerpMarketService(deps);
}

function walletThatFailsPnL(
  times: number
): WalletPort & { pnlAttempts: number } {
  const real = createUserWalletAdapter();
  let failuresLeft = times;
  const wrapped: WalletPort & { pnlAttempts: number } = {
    pnlAttempts: 0,
    debit: (params) => real.debit(params),
    credit: (params) => real.credit(params),
    getBalance: (id) => real.getBalance(id),
    recordPnL: async (params) => {
      wrapped.pnlAttempts++;
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error('recordPnL failed');
      }
      await real.recordPnL(params);
    },
  };
  return wrapped;
}

function recordingFees(): FeeProcessor & { types: string[] } {
  const types: string[] = [];
  return {
    types,
    async processTradingFee(params) {
      types.push(params.type);
      return { feeCharged: 0 };
    },
  };
}

async function readLifetimePnL(id: string): Promise<number> {
  const [row] = await db
    .select({ lifetimePnL: users.lifetimePnL })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return Number(row?.lifetimePnL ?? 0);
}

async function countFlipDebits(id: string): Promise<number> {
  const rows = await db
    .select({ id: balanceTransactions.id })
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.userId, id),
        eq(balanceTransactions.type, 'perp_flip_position')
      )
    );
  return rows.length;
}

async function withIsolatedLong(
  label: string,
  run: (fx: { userId: string; ticker: string }) => Promise<void>
): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const tick = `FLIPPNL${suffix}`.toUpperCase();
  const org = `test-flip-pnl-org-${suffix}`;
  const id = await generateSnowflakeId();
  const now = new Date();

  await db.insert(organizationState).values({
    id: org,
    currentPrice: BASE_PRICE,
    basePrice: BASE_PRICE,
    updatedAt: now,
  });
  await db.insert(perpMarketSnapshots).values({
    ticker: tick,
    organizationId: org,
    name: `Flip PnL ${label}`,
    currentPrice: BASE_PRICE,
    high24h: BASE_PRICE,
    low24h: BASE_PRICE,
    fundingRate: {
      ticker: tick,
      rate: 0,
      nextFundingTime: now.toISOString(),
      predictedRate: 0,
    },
  });
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-flip-pnl-${id}`,
    username: `flip-pnl-${id.slice(-8)}`,
    displayName: `flip-pnl-${id.slice(-8)}`,
    virtualBalance: STARTING_BALANCE.toFixed(2),
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });

  try {
    await serviceWith(new PerpDbAdapter()).openPosition({
      userId: id,
      ticker: tick,
      side: 'long',
      size: 100,
      leverage: 10,
    });
    await run({ userId: id, ticker: tick });
  } finally {
    await db.delete(perpPositions).where(eq(perpPositions.ticker, tick));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, tick));
    await db.delete(organizationState).where(eq(organizationState.id, org));
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
}
