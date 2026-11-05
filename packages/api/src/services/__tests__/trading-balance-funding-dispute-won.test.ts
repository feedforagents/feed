import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  fakeFeedDbModule,
  getFakeTxns,
  getFakeUser,
  resetFakeDb,
  seedFakeUser,
} from './fake-feed-db';

mock.module('@feed/db', fakeFeedDbModule);

let snowflakeCounter = 0;
mock.module('@feed/shared', () => ({
  generateSnowflakeId: async () => `test-id-${++snowflakeCounter}`,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

mock.module('../../cache', () => ({
  CACHE_KEYS: { USER_BALANCE: 'user-balance', USER: 'user' },
  invalidateCache: async () => {},
}));

import { TradingBalanceFundingService } from '../trading-balance-funding-service';

describe('creditDisputeWon clamped-reversal over-credit', () => {
  beforeEach(() => {
    resetFakeDb();
    snowflakeCounter = 0;
  });

  it('re-credits only what the dispute actually deducted when the balance was below the dispute amount', async () => {
    // User deposited $100 (10,000 pts) then spent 8,000 trading.
    seedFakeUser('u1', 2000, 10_000, 0);

    // Dispute for $100: only 2,000 pts can be withheld (balance floor 0).
    const reversal = await TradingBalanceFundingService.reversePurchaseFunding(
      'u1',
      'pi_1',
      'dispute',
      100,
      'evt_dispute_created_1'
    );
    expect(reversal.success).toBe(true);
    expect(reversal.balanceDelta).toBe(-2000);
    expect(getFakeUser('u1').virtualBalance).toBe(0);
    expect(getFakeUser('u1').totalWithdrawn).toBe(2000);

    // Merchant wins the dispute: only the 2,000 withheld points come back.
    const win = await TradingBalanceFundingService.creditDisputeWon(
      'u1',
      'dp_1',
      100,
      'evt_dispute_won_1',
      'pi_1'
    );
    expect(win.success).toBe(true);
    expect(win.balanceDelta).toBe(2000);
    expect(win.newBalance).toBe(2000);
    expect(getFakeUser('u1').virtualBalance).toBe(2000);
    expect(getFakeUser('u1').totalWithdrawn).toBe(0);

    // The win ledger row records what was actually credited.
    const winRow = getFakeTxns().find((t) => t.type === 'stripe_dispute_won');
    expect(winRow).toBeDefined();
    expect(Number(winRow!.amount)).toBe(2000);
  });

  it('still re-credits the full amount when the dispute deducted the full amount', async () => {
    seedFakeUser('u1', 10_000, 10_000, 0);
    await TradingBalanceFundingService.reversePurchaseFunding(
      'u1',
      'pi_1',
      'dispute',
      100,
      'evt_dispute_created_1'
    );
    expect(getFakeUser('u1').virtualBalance).toBe(0);

    const win = await TradingBalanceFundingService.creditDisputeWon(
      'u1',
      'dp_1',
      100,
      'evt_dispute_won_1',
      'pi_1'
    );
    expect(win.balanceDelta).toBe(10_000);
    expect(win.newBalance).toBe(10_000);
    expect(getFakeUser('u1').virtualBalance).toBe(10_000);
  });

  it('falls back to the full amount when no matching reversal exists', async () => {
    seedFakeUser('u1', 2000, 2000, 5000);
    const win = await TradingBalanceFundingService.creditDisputeWon(
      'u1',
      'dp_1',
      50,
      'evt_dispute_won_1',
      'pi_unknown'
    );
    expect(win.balanceDelta).toBe(5000);
    expect(win.newBalance).toBe(7000);
  });
});
