/**
 * Profile header position count against a real database: the positions
 * number on a profile is documented as the number of OPEN positions, and
 * it must agree with the open positions list the profile links to.
 *
 * The profile route's own OpenAPI describes stats.positions as "Number
 * of open positions" — unlike the neighbouring stats, which it
 * describes as totals ("Total comments made", "Total posts created").
 * The profile's positions list (GET /api/markets/positions/[userId],
 * default status=open) defines open prediction positions as exactly the
 * 'active' ones: "Open prediction positions are exactly the 'active'
 * ones; resolved or closed positions belong to the closed view." The
 * canonical open-position reads agree (market metrics counts only
 * status='active' positions; the NPC positions context loads only
 * status='active'). The header count in getUserProfileStats still
 * counts every position row the user ever held — fully sold ('closed'),
 * settled ('resolved'), and refunded ('cancelled') rows included — so
 * the header keeps growing after positions end and no view on the
 * profile can reproduce it.
 *
 * Fixture ownership: every helper records an ID only from the successful
 * `returning()` result of its own insert. Teardown deletes exactly the
 * recorded IDs, children before parents.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { cachedDb } from '@feed/api';
import { db, inArray, markets, positions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_USER_POSITIONS: typeof import('../../../apps/web/src/app/api/markets/positions/[userId]/route').GET;

const owned = {
  users: new Set<string>(),
  markets: new Set<string>(),
  positions: new Set<string>(),
};

let targetId: string;
let controlId: string;
let marketId: string;

async function insertUser(id: string, tag: string): Promise<void> {
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f197-${tag}-${id.slice(-12)}`,
      displayName: `F197 ${tag}`,
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
  expect(inserted).toEqual([{ id }]);
}

async function insertMarket(id: string): Promise<void> {
  const now = new Date();
  const inserted = await db
    .insert(markets)
    .values({
      id,
      question: 'F197 fixture market',
      liquidity: '1000',
      yesShares: '100',
      noShares: '100',
      endDate: new Date(now.getTime() + 86_400_000),
      updatedAt: now,
    })
    .returning({ id: markets.id });
  for (const row of inserted) owned.markets.add(row.id);
  expect(inserted).toEqual([{ id }]);
}

async function insertPosition(values: {
  id: string;
  userId: string;
  status: string;
  resolvedAt?: Date | null;
}): Promise<void> {
  const now = new Date();
  const inserted = await db
    .insert(positions)
    .values({
      id: values.id,
      userId: values.userId,
      marketId,
      side: true,
      shares: '10',
      avgPrice: '0.5',
      amount: '5',
      status: values.status,
      createdAt: now,
      updatedAt: now,
      resolvedAt: values.resolvedAt ?? null,
    })
    .returning({ id: positions.id });
  for (const row of inserted) owned.positions.add(row.id);
  expect(inserted).toEqual([{ id: values.id }]);
}

type PositionsBody = {
  predictions: { total: number; positions: Array<{ id: string }> };
};

async function callPositions(
  userId: string,
  status?: string
): Promise<PositionsBody> {
  const query = status
    ? `?type=prediction&status=${status}`
    : '?type=prediction';
  const request = new NextRequest(
    new Request(`http://localhost/api/markets/positions/${userId}${query}`)
  );
  const response = await GET_USER_POSITIONS(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PositionsBody;
}

beforeAll(async () => {
  ({ GET: GET_USER_POSITIONS } = await import(
    '../../../apps/web/src/app/api/markets/positions/[userId]/route'
  ));

  [targetId, controlId, marketId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await insertUser(targetId, 'target');
  await insertUser(controlId, 'control');
  await insertMarket(marketId);

  const [openA, openB, closedId, resolvedId, cancelledId, controlPosId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  // Target: two still open, and one in each ended state the position
  // writers produce — fully sold, settled by resolution, and refunded
  // by market cancellation.
  await insertPosition({ id: openA, userId: targetId, status: 'active' });
  await insertPosition({ id: openB, userId: targetId, status: 'active' });
  await insertPosition({ id: closedId, userId: targetId, status: 'closed' });
  await insertPosition({
    id: resolvedId,
    userId: targetId,
    status: 'resolved',
    resolvedAt: new Date(),
  });
  await insertPosition({
    id: cancelledId,
    userId: targetId,
    status: 'cancelled',
  });
  // Control: a single open position and nothing else.
  await insertPosition({
    id: controlPosId,
    userId: controlId,
    status: 'active',
  });
});

afterAll(async () => {
  if (owned.positions.size > 0) {
    await db
      .delete(positions)
      .where(inArray(positions.id, [...owned.positions]));
  }
  if (owned.markets.size > 0) {
    await db.delete(markets).where(inArray(markets.id, [...owned.markets]));
  }
  if (owned.users.size > 0) {
    await db.delete(users).where(inArray(users.id, [...owned.users]));
  }
});

describe('profile header position count', () => {
  it('open positions list delivers only the active positions', async () => {
    const body = await callPositions(targetId);
    expect(body.predictions.total).toBe(2);
    expect(body.predictions.positions).toHaveLength(2);
  });

  it('closed positions list delivers the closed and resolved positions', async () => {
    const body = await callPositions(targetId, 'closed');
    expect(body.predictions.total).toBe(2);
  });

  it('header positions count equals the open positions list total', async () => {
    const stats = await cachedDb.getUserProfileStats(targetId);
    const list = await callPositions(targetId);
    expect(stats.positions).toBe(2);
    expect(stats.positions).toBe(list.predictions.total);
  });

  it('control user with only an open position agrees on both counts', async () => {
    const stats = await cachedDb.getUserProfileStats(controlId);
    const list = await callPositions(controlId);
    expect(stats.positions).toBe(1);
    expect(stats.positions).toBe(list.predictions.total);
  });
});
