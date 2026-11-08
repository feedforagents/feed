/**
 * GET /api/users/[userId]/activity against a real database: each source
 * window must be cut on the rows the feed can actually display, and
 * pagination.hasMore must tell the truth about whether more displayable
 * activity exists beyond the returned window.
 *
 * On base, the points branch applies `.limit(limit)` to raw
 * PointsTransaction rows and only then drops reason='trading_pnl' rows in
 * memory, so recent trading activity (which writes a trading_pnl points
 * row for every P&L update, EarnedPointsService) silently eats the whole
 * window: a user whose newest points rows are trading_pnl sees an empty
 * points feed even with plenty of older points activity. The trades
 * branch does the same with a limit*2 fetch of *all* BalanceTransaction
 * rows (deposits, funding and fee rows included) before filtering to
 * trade types in memory. And because every source is capped at `limit`
 * displayable-or-not rows, the merged pool can never exceed `limit` for a
 * single-type request, so hasMore is always false there — even when more
 * matching activity exists. The sibling profile trades route states the
 * contract this restores (fixed in #1693): windows are cut after the
 * display filter, and paging metadata reflects the real displayable set.
 *
 * The request is authenticated with the existing CI synthetic bearer. The
 * only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  db,
  inArray,
  pointsTransactions,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ActivityResponse = {
  userId: string;
  activities: Array<{ type: string; id: string }>;
  pagination: { limit: number; count: number; hasMore: boolean };
};

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/activity/route').GET;

const ownedUsers: string[] = [];

async function fixtureUser(tag: string): Promise<string> {
  const userId = await generateSnowflakeId();
  ownedUsers.push(userId);
  await db.insert(users).values({
    id: userId,
    username: `g23${tag}-${userId}`,
    displayName: `Activity Fixture ${tag}`,
    updatedAt: new Date(),
  });
  return userId;
}

async function fetchActivity(userId: string, query: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/activity?${query}`),
    {
      headers: { authorization: `Bearer steward:test:${userId}` },
    }
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId }),
  });
  const body = (await response.json().catch(() => null)) as
    | ActivityResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

const base = Date.now();
const minutesAgo = (m: number) => new Date(base - m * 60_000);

async function pointsRow(
  userId: string,
  reason: string,
  minutes: number,
  amount: number
) {
  await db.insert(pointsTransactions).values({
    id: await generateSnowflakeId(),
    userId,
    amount,
    pointsBefore: 1000,
    pointsAfter: 1000 + amount,
    reason,
    createdAt: minutesAgo(minutes),
  });
}

let pnlUser: string;
let manyPointsUser: string;
let tradeUser: string;
let postUser: string;
let smallUser: string;

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/activity/route'
  ));

  // Points window eaten by trading_pnl: the five newest points rows are
  // trading_pnl (never displayed), five older rows are real points
  // activity that must fill the limit=5 window.
  pnlUser = await fixtureUser('pnl');
  for (let i = 1; i <= 5; i++) {
    await pointsRow(pnlUser, 'trading_pnl', i, 10);
  }
  for (let i = 6; i <= 10; i++) {
    await pointsRow(pnlUser, 'achievement_unlock', i, 25);
  }

  // More points activity than the window: seven displayable rows.
  manyPointsUser = await fixtureUser('many');
  for (let i = 1; i <= 7; i++) {
    await pointsRow(manyPointsUser, 'achievement_unlock', i, 5);
  }

  // Trade window eaten by non-trade balance rows: the ten newest balance
  // rows are deposits, six older rows are actual trades.
  tradeUser = await fixtureUser('trade');
  const balanceRow = async (type: string, minutes: number, amount: string) => {
    await db.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId: tradeUser,
      type,
      amount,
      balanceBefore: '100.00',
      balanceAfter: '110.00',
      createdAt: minutesAgo(minutes),
    });
  };
  for (let i = 1; i <= 10; i++) {
    await balanceRow('deposit', i, '50.00');
  }
  for (let i = 11; i <= 16; i++) {
    await balanceRow('pred_buy', i, '10.00');
  }

  // More posts than the window: seven posts.
  postUser = await fixtureUser('post');
  for (let i = 1; i <= 7; i++) {
    await db.insert(posts).values({
      id: await generateSnowflakeId(),
      content: `activity fixture post ${i}`,
      authorId: postUser,
      timestamp: minutesAgo(i),
      createdAt: minutesAgo(i),
    });
  }

  // Control: fewer displayable rows than the window.
  smallUser = await fixtureUser('small');
  for (let i = 1; i <= 3; i++) {
    await pointsRow(smallUser, 'achievement_unlock', i, 5);
  }
});

afterAll(async () => {
  if (ownedUsers.length === 0) return;
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, ownedUsers));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, ownedUsers));
  await db.delete(posts).where(inArray(posts.authorId, ownedUsers));
  await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('user activity feed pagination windows', () => {
  it('points: trading_pnl rows do not eat the points window', async () => {
    const { status, body } = await fetchActivity(
      pnlUser,
      'type=points&limit=5'
    );
    expect(status).toBe(200);
    const res = body as ActivityResponse;
    expect(res.activities).toHaveLength(5);
    expect(res.activities.every((a) => a.type === 'points')).toBe(true);
    expect(res.pagination.count).toBe(5);
    expect(res.pagination.hasMore).toBe(false);
  });

  it('points: hasMore is true when more points activity exists', async () => {
    const { status, body } = await fetchActivity(
      manyPointsUser,
      'type=points&limit=5'
    );
    expect(status).toBe(200);
    const res = body as ActivityResponse;
    expect(res.activities).toHaveLength(5);
    expect(res.pagination.hasMore).toBe(true);
  });

  it('trade: non-trade balance rows do not eat the trade window', async () => {
    const { status, body } = await fetchActivity(
      tradeUser,
      'type=trade&limit=5'
    );
    expect(status).toBe(200);
    const res = body as ActivityResponse;
    expect(res.activities).toHaveLength(5);
    expect(res.activities.every((a) => a.type === 'trade')).toBe(true);
    expect(res.pagination.hasMore).toBe(true);
  });

  it('post: hasMore is true when more posts exist', async () => {
    const { status, body } = await fetchActivity(postUser, 'type=post&limit=5');
    expect(status).toBe(200);
    const res = body as ActivityResponse;
    expect(res.activities).toHaveLength(5);
    expect(res.pagination.hasMore).toBe(true);
  });

  it('control: hasMore stays false when the window covers everything', async () => {
    const { status, body } = await fetchActivity(
      smallUser,
      'type=points&limit=5'
    );
    expect(status).toBe(200);
    const res = body as ActivityResponse;
    expect(res.activities).toHaveLength(3);
    expect(res.pagination.hasMore).toBe(false);
  });
});
