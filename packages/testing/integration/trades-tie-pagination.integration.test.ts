/**
 * GET /api/trades?userId=… (a user's wallet transaction list, rendered
 * by the TradesFeed infinite scroll and the profile Trades tab) against
 * a real database: offset-paging through the whole list must reach
 * every transaction exactly once.
 *
 * The route reads each source with `orderBy: { createdAt: 'desc' }`
 * alone and applies limit/offset per page. Balance transactions written
 * by one engine batch share a single `createdAt` — the column defaults
 * to Postgres `now()`, the transaction timestamp, so one multi-row
 * insert stamps every row with the same value. A tie group therefore
 * has no defined order, and each page's top-N sort is free to pick a
 * different subset of it: rows can repeat across pages while others
 * never appear on any page, no matter how far the user scrolls.
 *
 * The traversal below pages by offset until a short page arrives and
 * does not rely on `hasMore`/`total`: whether those fields are truthful
 * is a separate, already-owned question (open PR #1693). This suite
 * measures only the set completeness of offset paging itself.
 *
 * The only stub is the `server-only` marker package; the route is
 * public (rate-limit disabled via env for the run) and every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { balanceTransactions, db, eq, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type TradesResponse = {
  trades: Array<{ id: string; type: string }>;
  total: number;
  hasMore: boolean;
};

const TIE_COUNT = 300;
const OLDER_COUNT = 40;
const REAL_TOTAL = TIE_COUNT + OLDER_COUNT;

let traderId: string;
const tieIds: string[] = [];
const olderIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/trades/route').GET;

async function fetchTradesPage(limit: number, offset: number) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/trades?userId=${traderId}&limit=${limit}&offset=${offset}`
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | TradesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function traverse(limit: number) {
  const seen: string[] = [];
  for (let page = 0; page < 60; page++) {
    const { status, body } = await fetchTradesPage(limit, page * limit);
    expect(status).toBe(200);
    if (!body || !('trades' in body)) throw new Error('missing trades body');
    seen.push(...body.trades.map((t) => t.id));
    if (body.trades.length < limit) break;
  }
  return seen;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/trades/route'));

  traderId = await generateSnowflakeId();

  const now = new Date();
  await db.insert(users).values({
    id: traderId,
    username: `f2t-${traderId}`,
    displayName: 'Wallet Transactions Tie Fixture Trader',
    updatedAt: now,
  });

  // 300 wallet transactions in ONE multi-row insert with no explicit
  // createdAt: the default stamps every row with the same transaction
  // timestamp, forming a single 300-row tie group (newest in the list).
  for (let i = 0; i < TIE_COUNT; i++) {
    tieIds.push(await generateSnowflakeId());
  }
  await db.insert(balanceTransactions).values(
    tieIds.map((id, i) => ({
      id,
      userId: traderId,
      type: 'pred_buy',
      amount: '10',
      balanceBefore: '100',
      balanceAfter: '90',
      relatedId: null,
      description: `f2 tie trade ${i}`,
    }))
  );

  // 40 older transactions, one hour apart, all older than the tie group.
  for (let i = 0; i < OLDER_COUNT; i++) {
    olderIds.push(await generateSnowflakeId());
  }
  await db.insert(balanceTransactions).values(
    olderIds.map((id, i) => ({
      id,
      userId: traderId,
      type: 'pred_sell',
      amount: '5',
      balanceBefore: '90',
      balanceAfter: '95',
      relatedId: null,
      description: `f2 older trade ${i}`,
      createdAt: new Date(now.getTime() - (i + 2) * 3_600_000),
    }))
  );
});

afterAll(async () => {
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.id, [...tieIds, ...olderIds]));
  await db.delete(users).where(eq(users.id, traderId));
});

describe('GET /api/trades wallet transaction tie pagination', () => {
  it('fixture premise: the batch insert shares one createdAt', async () => {
    const rows = await db
      .select({ createdAt: balanceTransactions.createdAt })
      .from(balanceTransactions)
      .where(inArray(balanceTransactions.id, tieIds));
    expect(rows).toHaveLength(TIE_COUNT);
    const stamps = new Set(rows.map((r) => r.createdAt.getTime()));
    expect(stamps.size).toBe(1);
  });

  it('reaches every transaction exactly once at limit=25', async () => {
    const seen = await traverse(25);
    expect(seen.length).toBe(REAL_TOTAL);
    expect(new Set(seen).size).toBe(REAL_TOTAL);
    expect(new Set(seen)).toEqual(new Set([...tieIds, ...olderIds]));
  }, 60_000);

  it('reaches every transaction exactly once at limit=7', async () => {
    const seen = await traverse(7);
    expect(seen.length).toBe(REAL_TOTAL);
    expect(new Set(seen).size).toBe(REAL_TOTAL);
    expect(new Set(seen)).toEqual(new Set([...tieIds, ...olderIds]));
  }, 60_000);
});
