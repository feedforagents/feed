import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Repo-style drizzle fake (mirrors referral-service.test.ts): the funding
// service's chained query builders are replaced with capturable chains so
// the test can assert on the exact values a reversal writes.
interface SqlCapture {
  text: string;
  values: unknown[];
}

let userBalance: number;
let updatePayloads: Array<Record<string, unknown>>;
let insertedRows: Array<Record<string, unknown>>;
let selectCallIndex: number;

function resetState(balance: number) {
  userBalance = balance;
  updatePayloads = [];
  insertedRows = [];
  selectCallIndex = 0;
}

function createSelectChain() {
  const callIndex = selectCallIndex;
  selectCallIndex += 1;
  const chain: Record<string, unknown> = {};
  chain.from = mock(() => chain);
  chain.where = mock(() => chain);
  chain.limit = mock(() => chain);
  chain.for = mock(() => chain);
  chain.then = (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null
  ) => {
    // First select is the user-row lock (returns the current balance);
    // later selects are idempotency lookups (no existing rows).
    const result =
      callIndex === 0 ? [{ virtualBalance: String(userBalance) }] : [];
    return Promise.resolve(result).then(onFulfilled, onRejected);
  };
  return chain;
}

const fakeTx = {
  select: mock(() => createSelectChain()),
  update: mock(() => {
    const chain: Record<string, unknown> = {};
    chain.set = mock((payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return chain;
    });
    chain.where = mock(() => Promise.resolve(undefined));
    return chain;
  }),
  insert: mock(() => ({
    values: mock((row: Record<string, unknown>) => {
      insertedRows.push(row);
      return Promise.resolve(undefined);
    }),
  })),
  execute: mock(() => Promise.resolve(undefined)),
};

const mockDb = {
  transaction: mock(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx)
  ),
};

mock.module('@feed/db', () => ({
  and: (...conditions: unknown[]) => conditions,
  balanceTransactions: {
    id: 'balanceTransactions.id',
    userId: 'balanceTransactions.userId',
    type: 'balanceTransactions.type',
    amount: 'balanceTransactions.amount',
    balanceBefore: 'balanceTransactions.balanceBefore',
    balanceAfter: 'balanceTransactions.balanceAfter',
    description: 'balanceTransactions.description',
    relatedId: 'balanceTransactions.relatedId',
    createdAt: 'balanceTransactions.createdAt',
  },
  db: mockDb,
  desc: (value: unknown) => value,
  eq: (left: unknown, right: unknown) => ({ left, right }),
  inArray: (left: unknown, right: unknown) => ({ left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ text: strings.join('?'), values }) as SqlCapture,
  users: {
    id: 'users.id',
    virtualBalance: 'users.virtualBalance',
    totalDeposited: 'users.totalDeposited',
    totalWithdrawn: 'users.totalWithdrawn',
  },
  WELCOME_BONUS_BALANCE_DESCRIPTION: 'Welcome bonus',
}));

mock.module('@feed/shared', () => ({
  generateSnowflakeId: mock(async () => 'test-id'),
  logger: { info: mock(() => {}), warn: mock(() => {}) },
}));

mock.module('../../cache', () => ({
  CACHE_KEYS: { USER_BALANCE: 'user_balance', USER: 'user' },
  invalidateCache: mock(async () => {}),
}));

const { TradingBalanceFundingService } = await import(
  '../trading-balance-funding-service'
);

function totalWithdrawnIncrement(): number | undefined {
  for (const payload of updatePayloads) {
    const capture = payload.totalWithdrawn as SqlCapture | undefined;
    if (capture) return capture.values[0] as number;
  }
  return undefined;
}

describe('TradingBalanceFundingService.reversePurchaseFunding', () => {
  beforeEach(() => {
    resetState(0);
  });

  it('increments totalWithdrawn by the amount actually deducted when the balance covers only part of the reversal', async () => {
    // User bought $1 of points (100 units) and spent all but 50, then the
    // payment is refunded. The balance can only give back 50.
    resetState(50);

    const result = await TradingBalanceFundingService.reversePurchaseFunding(
      'u1',
      'pi_1',
      'refund',
      1,
      'evt_1'
    );

    expect(result.success).toBe(true);
    expect(result.balanceDelta).toBe(-50);
    expect(result.newBalance).toBe(0);
    // The ledger row records the actual deduction.
    expect(insertedRows[0]?.amount).toBe('-50');
    // The service's own rule: refunds increment totalWithdrawn "by the
    // reversed economic amount" — the amount this transaction reversed,
    // which is 50, not the 100 requested.
    expect(totalWithdrawnIncrement()).toBe(50);
  });

  it('increments totalWithdrawn by the full amount when the balance covers the reversal', async () => {
    resetState(500);

    const result = await TradingBalanceFundingService.reversePurchaseFunding(
      'u1',
      'pi_1',
      'dispute',
      1,
      'evt_2'
    );

    expect(result.success).toBe(true);
    expect(result.balanceDelta).toBe(-100);
    expect(insertedRows[0]?.amount).toBe('-100');
    expect(totalWithdrawnIncrement()).toBe(100);
  });
});
