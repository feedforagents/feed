/**
 * GET /api/trades?userId=… (the profile Trades tab) against a real
 * database: paging through a user's trades must reach every trade, and
 * `total` must be the user's full trade count on every page.
 *
 * The route merges three sources (balance transactions, NPC trades,
 * perp positions), and its own contract states the response fields:
 * "total - Total trades before limit" and "hasMore - Whether more
 * trades available". The TradesFeed client pages with limit/offset and
 * stops when hasMore is false.
 *
 * The route applied limit/offset to each source separately before
 * merging, then reported the merged window length as `total`. With two
 * active sources the window holds at most 2×limit rows, so `total`
 * changed from page to page, and rows that lost the merge race on one
 * page were skipped by the next page's per-source offset — a block of
 * the user's trades could never be reached by scrolling.
 *
 * Fixture: one user with 25 prediction balance transactions (all newer)
 * and 25 perp positions (all older), interleaved so the merged order is
 * fully known: balance newest→oldest, then perp newest→oldest.
 * 50 real trades, page size 20 (the client's PAGE_SIZE).
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  db,
  inArray,
  perpPositions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type TradesResponse = {
  trades: Array<{ id: string; type: string }>;
  total: number;
  hasMore: boolean;
};

const BALANCE_COUNT = 25;
const PERP_COUNT = 25;
const REAL_TOTAL = BALANCE_COUNT + PERP_COUNT; // 50
const PAGE_SIZE = 20;

let traderId: string;
let otherId: string;
const balanceIds: string[] = []; // newest → oldest
const perpIds: string[] = []; // newest → oldest
const otherBalanceIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/trades/route').GET;

async function fetchTradesPage(userId: string, limit: number, offset: number) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/trades?userId=${userId}&limit=${limit}&offset=${offset}`
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | TradesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/trades/route'));

  [traderId, otherId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  await db.insert(users).values([
    {
      id: traderId,
      username: `g15t-${traderId}`,
      displayName: 'Profile Trades Fixture Trader',
      updatedAt: now,
    },
    {
      id: otherId,
      username: `g15o-${otherId}`,
      displayName: 'Other User',
      updatedAt: now,
    },
  ]);

  // 25 prediction balance transactions, one minute apart, all within
  // the last 25 minutes (newest first in balanceIds).
  for (let i = 0; i < BALANCE_COUNT; i++) {
    balanceIds.push(await generateSnowflakeId());
  }
  await db.insert(balanceTransactions).values(
    balanceIds.map((id, i) => ({
      id,
      userId: traderId,
      type: i % 2 === 0 ? 'pred_buy' : 'pred_sell',
      amount: '10',
      balanceBefore: '100',
      balanceAfter: '90',
      relatedId: null,
      description: `fixture balance trade ${i}`,
      createdAt: new Date(now.getTime() - i * 60_000),
    }))
  );

  // 25 perp positions, opened one minute apart, all older than every
  // balance transaction (newest first in perpIds).
  for (let i = 0; i < PERP_COUNT; i++) {
    perpIds.push(await generateSnowflakeId());
  }
  await db.insert(perpPositions).values(
    perpIds.map((id, i) => ({
      id,
      userId: traderId,
      ticker: 'ACME',
      organizationId: 'g15-fixture-org',
      side: 'long',
      entryPrice: 100,
      currentPrice: 101,
      size: 10,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 5,
      unrealizedPnLPercent: 5,
      fundingPaid: 0,
      openedAt: new Date(now.getTime() - (60 + i) * 60_000),
      lastUpdated: now,
    }))
  );

  // A second user with 3 balance transactions: the userId filter must
  // keep them out of the trader's pages and total.
  for (let i = 0; i < 3; i++) {
    otherBalanceIds.push(await generateSnowflakeId());
  }
  await db.insert(balanceTransactions).values(
    otherBalanceIds.map((id, i) => ({
      id,
      userId: otherId,
      type: 'pred_buy',
      amount: '7',
      balanceBefore: '50',
      balanceAfter: '43',
      relatedId: null,
      description: `other user trade ${i}`,
      createdAt: new Date(now.getTime() - i * 60_000),
    }))
  );
});

afterAll(async () => {
  await db
    .delete(balanceTransactions)
    .where(
      inArray(balanceTransactions.id, [...balanceIds, ...otherBalanceIds])
    );
  await db.delete(perpPositions).where(inArray(perpPositions.id, perpIds));
  await db.delete(users).where(inArray(users.id, [traderId, otherId]));
});

describe('GET /api/trades profile trades pagination', () => {
  it('reports the full trade count as total on the first page', async () => {
    const { status, body } = await fetchTradesPage(traderId, PAGE_SIZE, 0);
    expect(status).toBe(200);
    expect(body?.trades).toHaveLength(PAGE_SIZE);
    expect(body?.total).toBe(REAL_TOTAL);
    expect(body?.hasMore).toBe(true);
    // Newest 20 merged rows are the 20 newest balance transactions.
    expect(body?.trades.map((t) => t.id)).toEqual(balanceIds.slice(0, 20));
  });

  it('reaches every trade across pages with no gaps and no repeats', async () => {
    const seen: string[] = [];
    const pageSizes: number[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const { status, body } = await fetchTradesPage(
        traderId,
        PAGE_SIZE,
        offset
      );
      expect(status).toBe(200);
      if (!body) throw new Error('missing body');
      pageSizes.push(body.trades.length);
      expect(body.total).toBe(REAL_TOTAL);
      seen.push(...body.trades.map((t) => t.id));
      offset += body.trades.length;
      if (!body.hasMore) break;
    }
    expect(pageSizes).toEqual([20, 20, 10]);
    expect(new Set(seen).size).toBe(REAL_TOTAL);
    expect(new Set(seen)).toEqual(new Set([...balanceIds, ...perpIds]));
    // Merged order is stable: balance newest→oldest, then perps.
    expect(seen).toEqual([...balanceIds, ...perpIds]);
  });

  it('keeps the other user isolated: total matches their own trades', async () => {
    const { status, body } = await fetchTradesPage(otherId, PAGE_SIZE, 0);
    expect(status).toBe(200);
    expect(body?.trades).toHaveLength(3);
    expect(body?.total).toBe(3);
    expect(body?.hasMore).toBe(false);
  });
});
