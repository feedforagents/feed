/**
 * Integration test: a failed openPosition must not strand the wallet debit.
 *
 * Production wiring (`open-perp.ts`, MCP `buildPerpService`, A2A) injects
 * `createUserWalletAdapter()` with no shared tx client, so WalletService.debit
 * commits in its own `withTransaction` before PerpDbAdapter.transaction runs.
 * When the position write aborts, the compensating credit must restore the
 * balance against a real Postgres database (and the real WalletService).
 *
 * Same stranded-margin class as #1556 (addToPosition) / #1577 (prediction buy);
 * those PRs do not cover the open path. Pattern mirrors
 * `perp-add-strand.integration.test.ts` from #1556, with a production wallet
 * instead of an in-memory TestWallet so the debit/credit path is the real one.
 *
 * Run with:
 *   DATABASE_URL=postgresql://feed:feed_dev_password@127.0.0.1:5432/feed \
 *     bun test packages/testing/integration/perp-open-strand.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
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

beforeAll(async () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  ticker = `OPENSTRAND${suffix}`.toUpperCase();
  orgId = `test-open-strand-org-${suffix}`;
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
    name: 'Open Strand Test',
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
    privyId: `did:privy:test-open-strand-${userId}`,
    username: `open-strand-${userId.slice(-8)}`,
    displayName: `open-strand-${userId.slice(-8)}`,
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

describe('openPosition against real Postgres', () => {
  it('refunds the debit when the position upsert aborts after wallet debit', async () => {
    const adapter = new PerpDbAdapter();
    const service = serviceWith(adapter);
    const before = await readBalance(userId);
    expect(before).toBeCloseTo(STARTING_BALANCE, 6);

    // Production openPosition calls this.db.transaction(...), which constructs
    // a fresh PerpDbAdapter bound to the tx client. Patch the prototype so the
    // upsert inside that real PG transaction fails after the (already
    // committed) wallet debit.
    const originalUpsert = PerpDbAdapter.prototype.upsertPosition;
    PerpDbAdapter.prototype.upsertPosition = async function failUpsert() {
      throw new Error('position insert failed');
    };

    try {
      await expect(
        service.openPosition({
          userId,
          ticker,
          side: 'long',
          size: 100,
          leverage: 10,
        })
      ).rejects.toThrow('position insert failed');
    } finally {
      PerpDbAdapter.prototype.upsertPosition = originalUpsert;
    }

    const after = await readBalance(userId);
    expect(after).toBeCloseTo(before, 6);

    const openRows = await db
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, userId), isNull(perpPositions.closedAt))
      );
    expect(openRows).toHaveLength(0);

    const refunds = await db
      .select()
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          eq(balanceTransactions.type, 'perp_open_refund')
        )
      );
    expect(refunds.length).toBeGreaterThanOrEqual(1);
    // size 100 / lev 10 = margin 10; fee = 100 * 0.001 = 0.1; totalCost = 10.1
    expect(Number(refunds[0]!.amount)).toBeCloseTo(10.1, 6);
  });

  it('still debits exactly once on a successful openPosition', async () => {
    const adapter = new PerpDbAdapter();
    const service = serviceWith(adapter);
    const before = await readBalance(userId);

    const opened = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    });

    const after = await readBalance(userId);
    expect(after).toBeCloseTo(before - 10.1, 6);
    expect(opened.positionId).toBeDefined();

    const openRows = await db
      .select()
      .from(perpPositions)
      .where(
        and(eq(perpPositions.userId, userId), isNull(perpPositions.closedAt))
      );
    expect(openRows).toHaveLength(1);

    // Close so afterAll cleanup is clean and the strand test's isolation holds
    // if the file is re-run out of order.
    await db
      .update(perpPositions)
      .set({ closedAt: new Date() })
      .where(eq(perpPositions.id, opened.positionId));
  });
});
