/**
 * Integration test: a failed add-to-position must not strand the wallet debit.
 *
 * The wallet is not part of the DB transaction. When the transaction aborts
 * after the debit (here: a concurrent close commits between the lookup and the
 * row lock), the compensating credit must restore the balance against a real
 * database.
 *
 * Run with: DATABASE_URL=... bun test packages/testing/integration/perp-add-strand.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { WalletPort } from '@feed/core/markets/perps';
import {
  PerpDbAdapter,
  PerpMarketService,
  type PerpServiceDeps,
  type PriceImpactPort,
} from '@feed/core/markets/perps';
import {
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
} from '@feed/db';

class TestWallet implements WalletPort {
  private balances = new Map<string, number>();
  readonly log: Array<{ type: string; amount: number; reason: string }> = [];

  constructor(private defaultBalance = 10_000) {}

  async debit(p: { userId: string; amount: number; reason: string }) {
    const bal = this.balances.get(p.userId) ?? this.defaultBalance;
    if (bal < p.amount)
      throw new Error(`Insufficient funds: ${bal} < ${p.amount}`);
    this.balances.set(p.userId, bal - p.amount);
    this.log.push({ type: 'debit', amount: p.amount, reason: p.reason });
  }

  async credit(p: { userId: string; amount: number; reason: string }) {
    const bal = this.balances.get(p.userId) ?? this.defaultBalance;
    this.balances.set(p.userId, bal + p.amount);
    this.log.push({ type: 'credit', amount: p.amount, reason: p.reason });
  }

  async recordPnL() {}

  async getBalance(userId: string) {
    return { balance: this.balances.get(userId) ?? this.defaultBalance };
  }
}

const BASE_PRICE = 100;
let ticker = '';
let orgId = '';
const user = `test-add-strand-${Date.now()}`;

const priceImpact: PriceImpactPort = {
  async applyAndGetPrice() {
    return BASE_PRICE;
  },
  async getBasePrice() {
    return BASE_PRICE;
  },
};

function serviceWith(
  wallet: TestWallet,
  adapter: PerpDbAdapter
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
  };
  return new PerpMarketService(deps);
}

beforeAll(async () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  ticker = `ADDSTRAND${suffix}`.toUpperCase();
  orgId = `test-add-strand-org-${suffix}`;
  const now = new Date();
  await (await import('@feed/db')).db.insert(organizationState).values({
    id: orgId,
    currentPrice: BASE_PRICE,
    basePrice: BASE_PRICE,
    updatedAt: now,
  });
  await (await import('@feed/db')).db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: orgId,
    name: 'Add Strand Test',
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
});

afterAll(async () => {
  const { db } = await import('@feed/db');
  await db.delete(perpPositions).where(eq(perpPositions.ticker, ticker));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await db.delete(organizationState).where(eq(organizationState.id, orgId));
});

describe('add-to-position against real Postgres', () => {
  it('refunds the debit when the position is closed before the row lock', async () => {
    const wallet = new TestWallet();
    const adapter = new PerpDbAdapter();
    const service = serviceWith(wallet, adapter);

    const opened = await service.openPosition({
      userId: user,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    });
    const before = (await wallet.getBalance(user)).balance;

    // Simulate the concurrent close committing between the optimistic lookup
    // and the transaction's row lock.
    const lookup = adapter.getOpenPositionByUserAndTicker.bind(adapter);
    let fired = false;
    adapter.getOpenPositionByUserAndTicker = async (u: string, t: string) => {
      const position = await lookup(u, t);
      if (position && !fired) {
        fired = true;
        const { db } = await import('@feed/db');
        await db
          .update(perpPositions)
          .set({ closedAt: new Date() })
          .where(eq(perpPositions.id, position.id));
      }
      return position;
    };

    await expect(
      service.openPosition({
        userId: user,
        ticker,
        side: 'long',
        size: 100,
        leverage: 10,
      })
    ).rejects.toThrow('Position no longer exists or was closed');

    const after = (await wallet.getBalance(user)).balance;
    console.log('LOG', JSON.stringify(wallet.log));
    expect(after).toBeCloseTo(before, 6);
    expect(
      wallet.log.some((entry) => entry.reason === 'perp_add_to_position_refund')
    ).toBe(true);
    expect(opened.positionId).toBeDefined();
  });
});
