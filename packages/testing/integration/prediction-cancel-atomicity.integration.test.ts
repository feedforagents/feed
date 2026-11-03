/**
 * Real Postgres evidence (CONTRIBUTING): cancel must claim/mark the position
 * cancelled BEFORE wallet.credit(pred_cancel), restore active on credit
 * failure, and block sells on cancelled markets. Prevents free-money mint
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
    // Market mark deferred until after refunds — still retryable.
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
