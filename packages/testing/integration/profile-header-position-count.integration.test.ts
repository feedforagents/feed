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
 * status='active'). The header count used to count every position row
 * the user ever held — fully sold ('closed'), settled ('resolved'),
 * and refunded ('cancelled') rows included — so the header kept
 * growing after positions end and no view on the profile could
 * reproduce it. Both stats paths (the cached by-ID stats and the
 * by-username route's own count) now restrict the count to 'active'.
 *
 * Fixture ownership: every helper records an ID only from the successful
 * `returning()` result of its own insert. Teardown deletes exactly the
 * recorded IDs, children before parents, inside one transaction — and
 * refuses instead of deleting a parent when a row this run did not
 * create still references it: positions and price-history rows point
 * at a market with no physical foreign key, so deleting the market
 * would orphan them, and a game-onboarding row is cascade-deleted
 * with its user. The control test below proves each refusal gate with
 * sentinel rows this run never recorded.
 *
 * The by-username profile route counts positions with its own query
 * instead of the cached stats path, so it gets the same 'active' filter
 * and its own response assertion beside the cached-stats oracle.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { cachedDb } from '@feed/api';
import {
  count,
  db,
  eq,
  gameOnboarding,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_USER_POSITIONS: typeof import('../../../apps/web/src/app/api/markets/positions/[userId]/route').GET;
let GET_BY_USERNAME: typeof import('../../../apps/web/src/app/api/users/by-username/[username]/route').GET;

const owned = {
  users: new Set<string>(),
  markets: new Set<string>(),
  positions: new Set<string>(),
};

type OwnedSets = typeof owned;

let targetId: string;
let controlId: string;
let marketId: string;
let targetUsername: string;
let controlUsername: string;

async function insertUser(
  id: string,
  tag: string,
  sets: OwnedSets = owned
): Promise<string> {
  const username = `f197-${tag}-${id.slice(-12)}`;
  const inserted = await db
    .insert(users)
    .values({
      id,
      username,
      displayName: `F197 ${tag}`,
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) sets.users.add(row.id);
  expect(inserted).toEqual([{ id }]);
  return username;
}

async function insertMarket(
  id: string,
  sets: OwnedSets = owned
): Promise<void> {
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
  for (const row of inserted) sets.markets.add(row.id);
  expect(inserted).toEqual([{ id }]);
}

async function insertPosition(
  values: {
    id: string;
    userId: string;
    status: string;
    resolvedAt?: Date | null;
    marketId?: string;
  },
  sets: OwnedSets = owned
): Promise<void> {
  const now = new Date();
  const inserted = await db
    .insert(positions)
    .values({
      id: values.id,
      userId: values.userId,
      marketId: values.marketId ?? marketId,
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
  for (const row of inserted) sets.positions.add(row.id);
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

type ByUsernameBody = {
  user: { stats: { positions: number } };
};

async function callByUsername(username: string): Promise<ByUsernameBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/by-username/${username}`)
  );
  const response = await GET_BY_USERNAME(request, {
    params: Promise.resolve({ username }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ByUsernameBody;
}

/**
 * Delete exactly the rows `sets` owns, in one transaction, refusing
 * instead of deleting a parent while a row this run did not create
 * still references it. Positions and price-history rows carry a
 * marketId with no physical foreign key, so a foreign row under an
 * owned market would be orphaned by the market delete; a
 * game-onboarding row is cascade-deleted with its user. The throw
 * rolls the whole teardown back, so a refusal never leaves a partial
 * cleanup behind.
 */
async function cleanupOwnedSets(sets: OwnedSets): Promise<void> {
  await db.transaction(async (tx) => {
    if (sets.positions.size > 0) {
      await tx
        .delete(positions)
        .where(inArray(positions.id, [...sets.positions]));
    }
    if (sets.markets.size > 0) {
      const marketIds = [...sets.markets];
      const [foreignPositions] = await tx
        .select({ count: count() })
        .from(positions)
        .where(inArray(positions.marketId, marketIds));
      if (Number(foreignPositions?.count ?? 0) > 0) {
        throw new Error(
          `Refusing to delete fixture market: ${foreignPositions?.count} position(s) not owned by this run still reference it`
        );
      }
      const [foreignHistory] = await tx
        .select({ count: count() })
        .from(predictionPriceHistories)
        .where(inArray(predictionPriceHistories.marketId, marketIds));
      if (Number(foreignHistory?.count ?? 0) > 0) {
        throw new Error(
          `Refusing to delete fixture market: ${foreignHistory?.count} price-history row(s) not owned by this run still reference it`
        );
      }
      await tx.delete(markets).where(inArray(markets.id, marketIds));
    }
    if (sets.users.size > 0) {
      const userIds = [...sets.users];
      const [foreignOnboarding] = await tx
        .select({ count: count() })
        .from(gameOnboarding)
        .where(inArray(gameOnboarding.userId, userIds));
      if (Number(foreignOnboarding?.count ?? 0) > 0) {
        throw new Error(
          'Refusing to delete fixture user: a game-onboarding row not owned by this run still references it'
        );
      }
      const [foreignPositions] = await tx
        .select({ count: count() })
        .from(positions)
        .where(inArray(positions.userId, userIds));
      if (Number(foreignPositions?.count ?? 0) > 0) {
        throw new Error(
          `Refusing to delete fixture user: ${foreignPositions?.count} position(s) not owned by this run still reference it`
        );
      }
      await tx.delete(users).where(inArray(users.id, userIds));
    }
  });
}

beforeAll(async () => {
  ({ GET: GET_USER_POSITIONS } = await import(
    '../../../apps/web/src/app/api/markets/positions/[userId]/route'
  ));
  ({ GET: GET_BY_USERNAME } = await import(
    '../../../apps/web/src/app/api/users/by-username/[username]/route'
  ));

  [targetId, controlId, marketId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  targetUsername = await insertUser(targetId, 'target');
  controlUsername = await insertUser(controlId, 'control');
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
  await cleanupOwnedSets(owned);
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

  it('by-username header positions count equals the open positions list total', async () => {
    const body = await callByUsername(targetUsername);
    const list = await callPositions(targetId);
    expect(body.user.stats.positions).toBe(2);
    expect(body.user.stats.positions).toBe(list.predictions.total);
  });

  it('by-username control user with only an open position agrees', async () => {
    const body = await callByUsername(controlUsername);
    expect(body.user.stats.positions).toBe(1);
  });

  it('teardown never deletes a row this run did not create', async () => {
    // Isolated control dataset, owned only by this test. The sentinel
    // rows are inserted directly and never recorded, so cleanup must
    // treat them as foreign rows and refuse.
    const control = {
      users: new Set<string>(),
      markets: new Set<string>(),
      positions: new Set<string>(),
    };
    const [
      controlUserId,
      controlMarketId,
      controlPositionId,
      sentinelPositionId,
      sentinelHistoryId,
      sentinelOnboardingId,
    ] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    try {
      await insertUser(controlUserId, 'sentinel-user', control);
      await insertMarket(controlMarketId, control);
      await insertPosition(
        {
          id: controlPositionId,
          userId: controlUserId,
          status: 'active',
          marketId: controlMarketId,
        },
        control
      );
      await db.insert(positions).values({
        id: sentinelPositionId,
        userId: controlUserId,
        marketId: controlMarketId,
        side: true,
        shares: '10',
        avgPrice: '0.5',
        amount: '5',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(predictionPriceHistories).values({
        id: sentinelHistoryId,
        marketId: controlMarketId,
        yesPrice: 0.5,
        noPrice: 0.5,
        yesShares: '100',
        noShares: '100',
        liquidity: '1000',
        eventType: 'created',
        source: 'f197-control',
      });
      await db.insert(gameOnboarding).values({
        id: sentinelOnboardingId,
        userId: controlUserId,
      });

      // Gate 1: a foreign position under the market refuses, and the
      // refused transaction leaves the owned position in place.
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /Refusing to delete fixture market: .* position/
      );
      expect(
        await db
          .select({ id: positions.id })
          .from(positions)
          .where(eq(positions.id, controlPositionId))
      ).toHaveLength(1);

      // Gate 2: with the foreign position gone, the foreign
      // price-history row still refuses.
      await db.delete(positions).where(eq(positions.id, sentinelPositionId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /price-history row/
      );

      // Gate 3: with the history gone, the foreign game-onboarding
      // row still refuses instead of being cascade-deleted with the user.
      await db
        .delete(predictionPriceHistories)
        .where(eq(predictionPriceHistories.id, sentinelHistoryId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /game-onboarding row/
      );
      expect(
        await db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, sentinelOnboardingId))
      ).toHaveLength(1);

      // With every foreign row removed, cleanup succeeds and deletes
      // exactly the control rows.
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, sentinelOnboardingId));
      await cleanupOwnedSets(control);
      expect(
        await db
          .select({ id: positions.id })
          .from(positions)
          .where(eq(positions.id, controlPositionId))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: markets.id })
          .from(markets)
          .where(eq(markets.id, controlMarketId))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, controlUserId))
      ).toHaveLength(0);
    } finally {
      // Direct deletes by exact ID, children before parents, so a
      // failure above never leaks control rows.
      await db
        .delete(positions)
        .where(inArray(positions.id, [controlPositionId, sentinelPositionId]));
      await db
        .delete(predictionPriceHistories)
        .where(eq(predictionPriceHistories.id, sentinelHistoryId));
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, sentinelOnboardingId));
      await db.delete(markets).where(eq(markets.id, controlMarketId));
      await db.delete(users).where(eq(users.id, controlUserId));
    }
  });
});
