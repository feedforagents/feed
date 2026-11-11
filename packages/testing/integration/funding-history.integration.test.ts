/**
 * PRD §9.1 and MVP Phase 6 steps 1–2: existing funding history visibility.
 * GET /api/users/trading-balance/funding against a real database: the
 * funding history the settings Billing tab renders must be the user's
 * complete funding ledger.
 *
 * The Billing tab presents the returned array as the whole history: the
 * section header badges it with `transactions.length` and the expand
 * button reads "Show all {N} transactions". The route returns no total,
 * no hasMore and accepts no pagination parameters, so whatever the
 * service returns is all the user can ever see — funding rows (card and
 * crypto purchases, refunds, disputes, deposits such as the daily-login
 * reward) that fall outside the returned window appear on no other
 * surface either (the profile trades feed only lists pred/perp types).
 *
 * The service capped the history at 100 rows, so a user whose funding
 * ledger grew past 100 rows silently lost the oldest
 * rows, including real-money purchases, while the tab presented the
 * truncated window as the complete history.
 *
 * Fixtures insert ledger rows in the exact shape the real writers
 * produce (TradingBalanceFundingService purchases/deposits and
 * historical DailyLoginService deposit rows; no new reward policy),
 * with distinct createdAt values and
 * a chained balanceBefore/balanceAfter sequence.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, balanceTransactions, db, eq, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type FundingResponse = {
  transactions: Array<{
    id: string;
    type: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: string;
  }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/trading-balance/funding/route').GET;

function ownership() {
  return {
    users: new Map<string, typeof users.$inferSelect>(),
    transactions: new Map<string, typeof balanceTransactions.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

async function makeUser(
  receipt = owned,
  requestedId?: string
): Promise<string> {
  const id = requestedId ?? (await generateSnowflakeId());
  const now = new Date();
  const rows = await db
    .insert(users)
    .values({
      id,
      username: `fh-${id}`,
      displayName: 'Funding History Fixture User',
      // Explicit millisecond timestamps round-trip exactly through the driver.
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== 1) throw new Error('Incomplete User RETURNING');
  return id;
}

async function insertRow(
  userId: string,
  type: string,
  amount: number,
  balanceBefore: number,
  createdAt: Date,
  description: string | null = null,
  receipt = owned
): Promise<string> {
  const id = await generateSnowflakeId();
  const rows = await db
    .insert(balanceTransactions)
    .values({
      id,
      userId,
      type,
      amount: String(amount),
      balanceBefore: String(balanceBefore),
      balanceAfter: String(balanceBefore + amount),
      description,
      createdAt,
    })
    .returning();
  for (const row of rows) receipt.transactions.set(row.id, row);
  if (rows.length !== 1)
    throw new Error('Incomplete BalanceTransaction RETURNING');
  return id;
}

async function cleanup(receipt: Ownership) {
  const failures: Error[] = [];
  // Cast the acquired complete tuple back through its actual SQL row type.
  // This compares all columns atomically, including NULLs, decimals and dates;
  // to_jsonb also gives User's json column a defined equality operation.
  const actions = [
    ...[...receipt.transactions.values()].map((row) => async () => {
      await db
        .delete(balanceTransactions)
        .where(
          and(
            eq(balanceTransactions.id, row.id),
            sql`to_jsonb(${balanceTransactions}) = to_jsonb(jsonb_populate_record(NULL::"BalanceTransaction", ${JSON.stringify(row)}::jsonb))`
          )
        );
      const remaining = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.id, row.id));
      if (remaining.length)
        throw new Error(`Owned BalanceTransaction remains: ${row.id}`);
      receipt.transactions.delete(row.id);
    }),
    ...[...receipt.users.values()].map((row) => async () => {
      await db.delete(users).where(
        and(
          eq(users.id, row.id),
          sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${JSON.stringify(row)}::jsonb))`,
          // A failed or unowned ledger row must keep its parent alive.
          sql`NOT EXISTS (SELECT 1 FROM ${balanceTransactions} WHERE ${balanceTransactions.userId} = ${row.id})`
        )
      );
      const remaining = await db
        .select()
        .from(users)
        .where(eq(users.id, row.id));
      if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
      receipt.users.delete(row.id);
    }),
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (receipt.transactions.size || receipt.users.size)
    failures.push(
      new Error(
        `Funding cleanup retains ledger IDs ${[...receipt.transactions.keys()]} and User IDs ${[...receipt.users.keys()]}`
      )
    );
  if (failures.length)
    throw new AggregateError(failures, 'Owned funding fixture cleanup failed');
}

async function fetchFunding(userId: string) {
  const request = new NextRequest(
    `http://localhost/api/users/trading-balance/funding?userId=${userId}`,
    { headers: { 'x-dev-user-id': userId } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FundingResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/trading-balance/funding/route'
  ));
});

afterAll(async () => cleanup(owned));

describe('GET /api/users/trading-balance/funding', () => {
  it('returns the complete history past 100 rows, including the oldest purchase', async () => {
    const userId = await makeUser();
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    let bal = 0;
    const purchaseId = await insertRow(
      userId,
      'stripe_purchase',
      10000,
      bal,
      new Date(base),
      JSON.stringify({ amountUSD: 100, paymentProvider: 'stripe' })
    );
    bal += 10000;
    for (let i = 1; i <= 104; i++) {
      await insertRow(
        userId,
        'deposit',
        10,
        bal,
        new Date(base + i * 60_000),
        `Daily login reward (Day ${i})`
      );
      bal += 10;
    }

    const { status, body } = await fetchFunding(userId);
    expect(status).toBe(200);
    if (!body || !('transactions' in body)) {
      throw new Error('expected a transactions response');
    }

    // Every funding row is returned, newest first, oldest last.
    expect(body.transactions.length).toBe(105);
    expect(body.transactions.at(-1)?.id).toBe(purchaseId);
    // The amounts the tab can sum reconcile with the funding ledger,
    // and the newest row carries the ledger's final balance.
    const sum = body.transactions.reduce((s, t) => s + Number(t.amount), 0);
    expect(sum).toBe(bal);
    expect(body.transactions[0]?.balanceAfter).toBe(String(bal));
    const timestamps = body.transactions.map((t) =>
      new Date(t.createdAt).getTime()
    );
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('returns a short history exactly and excludes non-funding rows', async () => {
    const userId = await makeUser();
    const base = new Date('2026-02-01T00:00:00Z').getTime();
    await insertRow(userId, 'deposit', 500, 0, new Date(base));
    await insertRow(userId, 'pred_buy', -200, 500, new Date(base + 1000));
    await insertRow(
      userId,
      'stripe_purchase',
      1000,
      300,
      new Date(base + 2000)
    );
    await insertRow(userId, 'stripe_refund', -100, 1300, new Date(base + 3000));

    const { status, body } = await fetchFunding(userId);
    expect(status).toBe(200);
    if (!body || !('transactions' in body)) {
      throw new Error('expected a transactions response');
    }
    expect(body.transactions.map((t) => t.type)).toEqual([
      'stripe_refund',
      'stripe_purchase',
      'deposit',
    ]);
  });

  it('cleans real partial inserts without owning a colliding control', async () => {
    const partial = ownership();
    const control = ownership();
    const controlId = await generateSnowflakeId();
    try {
      await makeUser(control, controlId);
      const before = await db
        .select()
        .from(users)
        .where(eq(users.id, controlId));
      expect(before).toHaveLength(1);
      const partialId = await makeUser(partial);
      const transactionId = await insertRow(
        partialId,
        'deposit',
        10,
        0,
        new Date('2026-03-01T00:00:00Z'),
        'owned partial funding row',
        partial
      );
      // A separate real statement fails after both partial inserts committed.
      await expect(makeUser(partial, controlId)).rejects.toMatchObject({
        cause: { code: '23505' },
      });
      expect([...partial.users.keys()]).toEqual([partialId]);
      expect([...partial.transactions.keys()]).toEqual([transactionId]);
      await cleanup(partial);
      expect(partial.transactions.size).toBe(0);
      expect(partial.users.size).toBe(0);
      expect(
        await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.id, transactionId))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, partialId))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, controlId))
      ).toEqual(before);
      await cleanup(partial); // Empty successful cleanup is safe to repeat.
    } finally {
      // Always attempt both independent groups; failed IDs remain in their maps.
      const failures: Error[] = [];
      for (const receipt of [partial, control]) {
        try {
          await cleanup(receipt);
        } catch (error) {
          failures.push(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Partial funding cleanup failed');
    }
  });
});
