/**
 * Real Postgres evidence (CONTRIBUTING): cancel must claim/mark the position
 * cancelled BEFORE wallet.credit(pred_cancel), restore active only when that
 * credit fails, and block sells on cancelled markets. A recordPnL failure
 * after credit must not restore the position. Positions left active on an
 * already-cancelled market are refunded on retry. Buy and sell fail once
 * the cancel mark is written. Prevents free-money mint
 * (pred_cancel refund + pred_sell proceeds).
 *
 * PRD §9.1 Currency / §9.2 Prediction markets — MVP Phase 6.
 * Distinct from #1580 / #1559 / #1590 / #1592 / #1593 / #1594 / #1595.
 *
 * Run with:
 *   DATABASE_URL=postgresql://feed:feed_dev_password@127.0.0.1:5432/feed \
 *     bun test packages/testing/integration/prediction-cancel-atomicity.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
  type PredictionServiceDeps,
} from '@feed/core/markets/prediction';
import type { WalletPort } from '@feed/core/markets/shared';
import {
  and,
  balanceTransactions,
  db,
  eq,
  markets,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { createUserWalletAdapter, WalletService } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const STARTING_BALANCE = 10_000;
const SHARES = 100;
const AVG_PRICE = 0.5;
const REFUND = SHARES * AVG_PRICE;

let marketId = '';
let userId = '';
let positionId = '';

const feeConfig = {
  tradingFeeRate: 0.001,
  platformShare: 0.5,
  referrerShare: 0.5,
  minFeeAmount: 0.01,
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
  adapter: PredictionDbAdapter,
  failCredits: { value: boolean }
): PredictionMarketService {
  const deps: PredictionServiceDeps = {
    db: adapter,
    wallet: wrapWallet(failCredits),
    fees: feeConfig,
    clock: { now: () => new Date() },
  };
  return new PredictionMarketService(deps);
}

async function readBalance(id: string): Promise<number> {
  return (await WalletService.getBalance(id)).balance;
}

async function readPositionStatus(): Promise<string | null> {
  const rows = await db
    .select({ status: positions.status })
    .from(positions)
    .where(eq(positions.id, positionId));
  return rows[0]?.status ?? null;
}

async function seedMarketAndPosition(): Promise<void> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  marketId = `test-cancel-atomic-mkt-${suffix}`;
  userId = await generateSnowflakeId();
  positionId = await generateSnowflakeId();
  const now = new Date();
  const endDate = new Date(now.getTime() + 7 * 24 * 3600_000);

  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-cancel-atomic-${userId}`,
    username: `cancel-atomic-${userId.slice(-8)}`,
    displayName: `cancel-atomic-${userId.slice(-8)}`,
    virtualBalance: STARTING_BALANCE.toFixed(2),
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });

  await db.insert(markets).values({
    id: marketId,
    question: `L8 cancel atomicity ${suffix}?`,
    description: 'integration evidence',
    gameId: 'continuous',
    yesShares: '6000',
    noShares: '4000',
    liquidity: '10000',
    resolved: false,
    resolution: null,
    endDate,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(positions).values({
    id: positionId,
    userId,
    marketId,
    side: true,
    shares: String(SHARES),
    avgPrice: String(AVG_PRICE),
    amount: String(REFUND),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

beforeAll(async () => {
  await seedMarketAndPosition();
});

afterAll(async () => {
  if (marketId) {
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, marketId));
    await db.delete(positions).where(eq(positions.marketId, marketId));
    await db.delete(markets).where(eq(markets.id, marketId));
  }
  if (userId) {
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('cancel against real Postgres (claim-before-credit)', () => {
  it('restores active position when pred_cancel credit fails after mark', async () => {
    const before = await readBalance(userId);
    expect(before).toBeCloseTo(STARTING_BALANCE, 6);
    expect(await readPositionStatus()).toBe('active');

    const failCredits = { value: true };
    await expect(
      serviceWith(new PredictionDbAdapter(), failCredits).cancel({
        marketId,
        reason: 'integration credit-fail',
      })
    ).rejects.toThrow('wallet credit failed');

    // Credit never applied; restore put the row back to active.
    expect(await readBalance(userId)).toBeCloseTo(before, 6);
    expect(await readPositionStatus()).toBe('active');

    const m = await db
      .select({ resolved: markets.resolved, resolution: markets.resolution })
      .from(markets)
      .where(eq(markets.id, marketId));
    // No refund landed, so the cancelling mark is cleared and a retry can
    // run against an open market.
    expect(m[0]!.resolved).toBe(false);

    const cancelCredits = await db
      .select()
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          eq(balanceTransactions.type, 'pred_cancel')
        )
      );
    expect(cancelCredits).toHaveLength(0);
  });

  it('happy-path cancel refunds once, marks cancelled, blocks sell', async () => {
    const before = await readBalance(userId);
    const failCredits = { value: false };
    const service = serviceWith(new PredictionDbAdapter(), failCredits);

    const result = await service.cancel({
      marketId,
      reason: 'integration happy path',
    });
    expect(result.positionsRefunded).toBe(1);
    expect(result.totalRefunded).toBeCloseTo(REFUND, 6);

    expect(await readBalance(userId)).toBeCloseTo(before + REFUND, 6);
    expect(await readPositionStatus()).toBe('cancelled');

    const m = await db
      .select({ resolved: markets.resolved, resolution: markets.resolution })
      .from(markets)
      .where(eq(markets.id, marketId));
    expect(m[0]!.resolved).toBe(true);
    expect(m[0]!.resolution).toBeNull();

    const cancelCredits = await db
      .select()
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          eq(balanceTransactions.type, 'pred_cancel')
        )
      );
    expect(cancelCredits).toHaveLength(1);

    await expect(
      service.sell({
        userId,
        marketId,
        shares: SHARES,
        positionId,
      })
    ).rejects.toThrow(/cancelled/);

    // Still exactly one economic cancel credit; sell did not add pred_sell.
    const afterSellCredits = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const reasons = afterSellCredits.map((r) => r.type);
    expect(reasons.filter((t) => t === 'pred_cancel')).toHaveLength(1);
    expect(reasons.filter((t) => t === 'pred_sell')).toHaveLength(0);
  });
});

async function seedOpenPosition(options?: {
  resolved?: boolean;
  resolution?: boolean | null;
}): Promise<{
  marketId: string;
  userId: string;
  positionId: string;
}> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const nextMarketId = `test-cancel-repair-mkt-${suffix}`;
  const nextUserId = await generateSnowflakeId();
  const nextPositionId = await generateSnowflakeId();
  const now = new Date();
  await db.insert(users).values({
    id: nextUserId,
    privyId: `did:privy:test-cancel-repair-${nextUserId}`,
    username: `cancel-repair-${nextUserId.slice(-8)}`,
    displayName: `cancel-repair-${nextUserId.slice(-8)}`,
    virtualBalance: STARTING_BALANCE.toFixed(2),
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });
  await db.insert(markets).values({
    id: nextMarketId,
    question: `L8 cancel repair ${suffix}?`,
    description: 'integration evidence',
    gameId: 'continuous',
    yesShares: '6000',
    noShares: '4000',
    liquidity: '10000',
    resolved: options?.resolved ?? false,
    resolution: options?.resolution ?? null,
    endDate: new Date(now.getTime() + 7 * 24 * 3600_000),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(positions).values({
    id: nextPositionId,
    userId: nextUserId,
    marketId: nextMarketId,
    side: true,
    shares: String(SHARES),
    avgPrice: String(AVG_PRICE),
    amount: String(REFUND),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return {
    marketId: nextMarketId,
    userId: nextUserId,
    positionId: nextPositionId,
  };
}

async function cleanupSeed(seed: {
  marketId: string;
  userId: string;
}): Promise<void> {
  await db
    .delete(predictionPriceHistories)
    .where(eq(predictionPriceHistories.marketId, seed.marketId));
  await db.delete(positions).where(eq(positions.marketId, seed.marketId));
  await db.delete(markets).where(eq(markets.id, seed.marketId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, seed.userId));
  await db.delete(users).where(eq(users.id, seed.userId));
}

describe('cancel repair and in-loop trade block (real Postgres)', () => {
  it('does not restore the position when recordPnL fails after credit', async () => {
    const seed = await seedOpenPosition();
    try {
      const base = createUserWalletAdapter();
      const service = new PredictionMarketService({
        db: new PredictionDbAdapter(),
        wallet: {
          debit: (args) => base.debit(args),
          credit: (args) => base.credit(args),
          recordPnL: async () => {
            throw new Error('recordPnL failed');
          },
          getBalance: (id) => base.getBalance(id),
        },
        fees: feeConfig,
        clock: { now: () => new Date() },
      });
      const before = await readBalance(seed.userId);
      const result = await service.cancel({
        marketId: seed.marketId,
        reason: 'pnl failure',
      });
      expect(result.positionsRefunded).toBe(1);
      expect(result.totalRefunded).toBeCloseTo(REFUND, 6);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const [pos] = await db
        .select({ status: positions.status })
        .from(positions)
        .where(eq(positions.id, seed.positionId));
      expect(pos?.status).toBe('cancelled');
      const [market] = await db
        .select({ resolved: markets.resolved, resolution: markets.resolution })
        .from(markets)
        .where(eq(markets.id, seed.marketId));
      expect(market?.resolved).toBe(true);
      expect(market?.resolution).toBeNull();

      const again = await service.cancel({ marketId: seed.marketId });
      expect(again.positionsRefunded).toBe(0);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const credits = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, seed.userId));
      expect(credits.filter((row) => row.type === 'pred_cancel')).toHaveLength(
        1
      );
    } finally {
      await cleanupSeed(seed);
    }
  });

  it('refunds an active position on a market already marked cancelled', async () => {
    const seed = await seedOpenPosition({ resolved: true, resolution: null });
    try {
      const service = serviceWith(new PredictionDbAdapter(), { value: false });
      const before = await readBalance(seed.userId);
      const repaired = await service.cancel({
        marketId: seed.marketId,
        reason: 'repair stuck cancel',
      });
      expect(repaired.positionsRefunded).toBe(1);
      expect(repaired.totalRefunded).toBeCloseTo(REFUND, 6);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const [pos] = await db
        .select({ status: positions.status })
        .from(positions)
        .where(eq(positions.id, seed.positionId));
      expect(pos?.status).toBe('cancelled');

      await expect(
        service.buy({
          userId: seed.userId,
          marketId: seed.marketId,
          side: 'yes',
          amount: 10,
        })
      ).rejects.toThrow(/resolved/);
      await expect(
        service.sell({
          userId: seed.userId,
          marketId: seed.marketId,
          shares: SHARES,
          positionId: seed.positionId,
        })
      ).rejects.toThrow(/cancelled/);

      const second = await service.cancel({ marketId: seed.marketId });
      expect(second.positionsRefunded).toBe(0);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
    } finally {
      await cleanupSeed(seed);
    }
  });

  it('rejects buy and sell during the refund after the market is marked', async () => {
    const seed = await seedOpenPosition();
    try {
      const base = createUserWalletAdapter();
      let service: PredictionMarketService | null = null;
      const seen: string[] = [];
      service = new PredictionMarketService({
        db: new PredictionDbAdapter(),
        wallet: {
          debit: (args) => base.debit(args),
          credit: async (args) => {
            if (!service) throw new Error('service not ready');
            try {
              await service.buy({
                userId: seed.userId,
                marketId: seed.marketId,
                side: 'no',
                amount: 10,
              });
              seen.push('buy-allowed');
            } catch (error) {
              seen.push(error instanceof Error ? error.message : String(error));
            }
            try {
              await service.sell({
                userId: seed.userId,
                marketId: seed.marketId,
                shares: 10,
                positionId: seed.positionId,
              });
              seen.push('sell-allowed');
            } catch (error) {
              seen.push(error instanceof Error ? error.message : String(error));
            }
            return base.credit(args);
          },
          recordPnL: (args) => base.recordPnL(args),
          getBalance: (id) => base.getBalance(id),
        },
        fees: feeConfig,
        clock: { now: () => new Date() },
      });
      const before = await readBalance(seed.userId);
      const result = await service.cancel({
        marketId: seed.marketId,
        reason: 'in-loop trades',
      });
      expect(result.positionsRefunded).toBe(1);
      expect(seen.some((line) => /resolved/i.test(line))).toBe(true);
      expect(seen.some((line) => /cancelled/i.test(line))).toBe(true);
      expect(seen.some((line) => line.endsWith('allowed'))).toBe(false);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const [pos] = await db
        .select({ status: positions.status })
        .from(positions)
        .where(eq(positions.id, seed.positionId));
      expect(pos?.status).toBe('cancelled');
      const rows = await db
        .select()
        .from(positions)
        .where(eq(positions.marketId, seed.marketId));
      expect(rows.filter((row) => row.status === 'active')).toHaveLength(0);
      const credits = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, seed.userId));
      expect(credits.filter((row) => row.type === 'pred_sell')).toHaveLength(0);
      expect(credits.filter((row) => row.type === 'pred_buy')).toHaveLength(0);
      expect(credits.filter((row) => row.type === 'pred_cancel')).toHaveLength(
        1
      );
    } finally {
      await cleanupSeed(seed);
    }
  });
});

describe('cancel credit ambiguity and resolve row lock (real Postgres)', () => {
  it('keeps the position cancelled when the refund commits then throws', async () => {
    const seed = await seedOpenPosition();
    try {
      const base = createUserWalletAdapter();
      const service = new PredictionMarketService({
        db: new PredictionDbAdapter(),
        wallet: {
          debit: (args) => base.debit(args),
          credit: async (args) => {
            await base.credit(args);
            throw new Error('write EPIPE');
          },
          recordPnL: (args) => base.recordPnL(args),
          getBalance: (id) => base.getBalance(id),
        },
        fees: feeConfig,
        clock: { now: () => new Date() },
      });
      const before = await readBalance(seed.userId);
      await expect(
        service.cancel({ marketId: seed.marketId, reason: 'apply then throw' })
      ).rejects.toThrow('EPIPE');
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const [pos] = await db
        .select({ status: positions.status })
        .from(positions)
        .where(eq(positions.id, seed.positionId));
      expect(pos?.status).toBe('cancelled');

      const retry = await serviceWith(new PredictionDbAdapter(), {
        value: false,
      }).cancel({ marketId: seed.marketId });
      expect(retry.positionsRefunded).toBe(0);
      expect(await readBalance(seed.userId)).toBeCloseTo(before + REFUND, 6);
      const credits = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, seed.userId));
      expect(credits.filter((row) => row.type === 'pred_cancel')).toHaveLength(
        1
      );
    } finally {
      await cleanupSeed(seed);
    }
  });

  it('resolve waits for a concurrent cancel holding the row lock and pays nothing', async () => {
    const seed = await seedOpenPosition();
    try {
      const before = await readBalance(seed.userId);
      let resolveDone = false;
      let startResolve: () => void = () => {};
      const lockHeld = new Promise<void>((r) => {
        startResolve = r;
      });
      let resolving: Promise<void> | null = null;
      // Another process: lock the market row, mark it cancelled, hold the
      // lock while resolve starts, then commit.
      await db.transaction(async (tx) => {
        await tx
          .select({ id: markets.id })
          .from(markets)
          .where(eq(markets.id, seed.marketId))
          .for('update');
        await tx
          .update(markets)
          .set({ resolved: true, resolution: null })
          .where(eq(markets.id, seed.marketId));
        startResolve();
        await lockHeld;
        resolving = serviceWith(new PredictionDbAdapter(), { value: false })
          .resolve({ marketId: seed.marketId, winningSide: 'yes' })
          .then(() => {
            resolveDone = true;
          });
        await new Promise((r) => setTimeout(r, 150));
        expect(resolveDone).toBe(false);
      });
      await resolving;
      expect(resolveDone).toBe(true);
      expect(await readBalance(seed.userId)).toBeCloseTo(before, 6);
      const [market] = await db
        .select({ resolved: markets.resolved, resolution: markets.resolution })
        .from(markets)
        .where(eq(markets.id, seed.marketId));
      expect(market?.resolution).toBeNull();
      const credits = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, seed.userId));
      expect(credits.filter((row) => row.type === 'pred_resolve')).toHaveLength(
        0
      );
    } finally {
      await cleanupSeed(seed);
    }
  });
});
