/**
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
 * ledger grew past 100 rows — reachable through ordinary daily-login
 * deposit rows alone, about one per day — silently lost the oldest
 * rows, including real-money purchases, while the tab still counted
 * and summed only the truncated window.
 *
 * Fixtures insert ledger rows in the exact shape the real writers
 * produce (TradingBalanceFundingService purchases/deposits and
 * DailyLoginService deposit rows), with distinct createdAt values and
 * a chained balanceBefore/balanceAfter sequence.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { balanceTransactions, db, inArray, users } from '@feed/db';
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

const userIds: string[] = [];

async function makeUser(): Promise<string> {
  const id = await generateSnowflakeId();
  userIds.push(id);
  await db.insert(users).values({
    id,
    username: `fh-${id}`,
    displayName: 'Funding History Fixture User',
    updatedAt: new Date(),
  });
  return id;
}

async function insertRow(
  userId: string,
  type: string,
  amount: number,
  balanceBefore: number,
  createdAt: Date,
  description: string | null = null
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(balanceTransactions).values({
    id,
    userId,
    type,
    amount: String(amount),
    balanceBefore: String(balanceBefore),
    balanceAfter: String(balanceBefore + amount),
    description,
    createdAt,
  });
  return id;
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

afterAll(async () => {
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

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
});
