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
 * with its user. It locks the owned parents first (FOR UPDATE), so a
 * concurrent writer cannot attach a dependent between the check and
 * the delete, and it also refuses on the other foreign keys that
 * cascade or set NULL off a user or market (PnL snapshots, whitelist
 * rows and grants, whitelist config, market questions). The control
 * test below proves each refusal gate with sentinel rows this run
 * never recorded.
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
  questions,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
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
 * game-onboarding row is cascade-deleted with its user, and the other
 * foreign keys off a user or market cascade or set NULL the same way.
 * The owned parents are locked first (FOR UPDATE): a concurrent
 * writer attaching such a dependent takes FOR KEY SHARE on the parent
 * row and blocks until this transaction ends, so the counts below
 * cannot miss a row that lands between the check and the delete. The
 * throw rolls the whole teardown back, so a refusal never leaves a
 * partial cleanup behind.
 */
async function cleanupOwnedSets(sets: OwnedSets): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the owned parents before inspecting dependents (see the
    // doc comment above). Positions have no physical foreign key, so
    // their delete needs no lock; the parents are locked first.
    if (sets.markets.size > 0) {
      await tx
        .select({ id: markets.id })
        .from(markets)
        .where(inArray(markets.id, [...sets.markets]))
        .for('update');
    }
    if (sets.users.size > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [...sets.users]))
        .for('update');
    }
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
      // Question.marketId is SET NULL on market delete: a foreign
      // question would silently lose its market.
      const [foreignQuestions] = await tx
        .select({ count: count() })
        .from(questions)
        .where(inArray(questions.marketId, marketIds));
      if (Number(foreignQuestions?.count ?? 0) > 0) {
        throw new Error(
          `Refusing to delete fixture market: ${foreignQuestions?.count} question(s) not owned by this run still reference it`
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
      // The other foreign keys off a user: PnL snapshots and whitelist
      // rows cascade with the user, while whitelist grants and the
      // whitelist config are SET NULL — all four would silently mutate
      // a row this run did not create. (AdminRole is RESTRICT /
      // NO ACTION, so a foreign admin row already fails the delete
      // itself instead of mutating silently.)
      const [foreignSnapshots] = await tx
        .select({ count: count() })
        .from(userPnLSnapshots)
        .where(inArray(userPnLSnapshots.userId, userIds));
      if (Number(foreignSnapshots?.count ?? 0) > 0) {
        throw new Error(
          `Refusing to delete fixture user: ${foreignSnapshots?.count} PnL snapshot(s) not owned by this run still reference it`
        );
      }
      const [foreignWhitelistUsers] = await tx
        .select({ count: count() })
        .from(whitelist)
        .where(inArray(whitelist.userId, userIds));
      if (Number(foreignWhitelistUsers?.count ?? 0) > 0) {
        throw new Error(
          'Refusing to delete fixture user: a whitelist row not owned by this run still references it'
        );
      }
      const [foreignWhitelistGrants] = await tx
        .select({ count: count() })
        .from(whitelist)
        .where(inArray(whitelist.grantedBy, userIds));
      if (Number(foreignWhitelistGrants?.count ?? 0) > 0) {
        throw new Error(
          'Refusing to delete fixture user: a whitelist grant not owned by this run still references it'
        );
      }
      const [foreignWhitelistConfig] = await tx
        .select({ count: count() })
        .from(whitelistConfig)
        .where(inArray(whitelistConfig.updatedBy, userIds));
      if (Number(foreignWhitelistConfig?.count ?? 0) > 0) {
        throw new Error(
          'Refusing to delete fixture user: a whitelist config not owned by this run still references it'
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
      controlUserCId,
      sentinelQuestionId,
      sentinelSnapshotId,
      sentinelWhitelistUserId,
      sentinelWhitelistGrantId,
      sentinelConfigId,
    ] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    // A questionNumber outside the fixture range; the insert fails
    // loudly on a collision instead of reusing a foreign question.
    const sentinelQuestionNumber = Math.floor(
      1_000_000_000 + Math.random() * 1_000_000_000
    );
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
      // Third user, inserted directly and never recorded: the
      // whitelist sentinels need a granter / grantee outside the
      // control sets so each whitelist gate trips on its own.
      await db.insert(users).values({
        id: controlUserCId,
        username: `f197-sentinel-granter-${controlUserCId.slice(-12)}`,
        displayName: 'F197 sentinel-granter',
        isTest: false,
        isBanned: false,
        updatedAt: new Date(),
      });
      await db.insert(questions).values({
        id: sentinelQuestionId,
        questionNumber: sentinelQuestionNumber,
        marketId: controlMarketId,
        text: 'F197 sentinel question',
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: new Date(),
        status: 'active',
        updatedAt: new Date(),
      });
      await db.insert(userPnLSnapshots).values({
        id: sentinelSnapshotId,
        userId: controlUserId,
        snapshotAt: new Date(),
      });
      await db.insert(whitelist).values({
        id: sentinelWhitelistUserId,
        userId: controlUserId,
        source: 'admin_manual',
        grantedBy: controlUserCId,
      });
      await db.insert(whitelist).values({
        id: sentinelWhitelistGrantId,
        userId: controlUserCId,
        source: 'admin_manual',
        grantedBy: controlUserId,
      });
      await db.insert(whitelistConfig).values({
        id: sentinelConfigId,
        updatedBy: controlUserId,
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

      // Gate 3: with the history gone, the foreign question under the
      // market still refuses instead of being SET NULL by the delete.
      await db
        .delete(predictionPriceHistories)
        .where(eq(predictionPriceHistories.id, sentinelHistoryId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /question\(s\) not owned/
      );
      expect(
        await db
          .select({ id: questions.id })
          .from(questions)
          .where(eq(questions.id, sentinelQuestionId))
      ).toHaveLength(1);

      // Gate 4: with the question gone, the foreign game-onboarding
      // row still refuses instead of being cascade-deleted with the user.
      await db.delete(questions).where(eq(questions.id, sentinelQuestionId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /game-onboarding row/
      );
      expect(
        await db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, sentinelOnboardingId))
      ).toHaveLength(1);

      // Gate 5: with the onboarding gone, the foreign PnL snapshot
      // still refuses instead of cascading with the user.
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, sentinelOnboardingId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(/PnL snapshot/);

      // Gate 6: with the snapshot gone, the foreign whitelist row
      // (userId) still refuses instead of cascading.
      await db
        .delete(userPnLSnapshots)
        .where(eq(userPnLSnapshots.id, sentinelSnapshotId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(/whitelist row/);

      // Gate 7: with that row gone, the foreign whitelist grant
      // (grantedBy) still refuses instead of being SET NULL.
      await db
        .delete(whitelist)
        .where(eq(whitelist.id, sentinelWhitelistUserId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /whitelist grant/
      );

      // Gate 8: with the grant gone, the foreign whitelist config
      // (updatedBy) still refuses instead of being SET NULL.
      await db
        .delete(whitelist)
        .where(eq(whitelist.id, sentinelWhitelistGrantId));
      await expect(cleanupOwnedSets(control)).rejects.toThrow(
        /whitelist config/
      );

      // With every foreign row removed, cleanup succeeds and deletes
      // exactly the control rows.
      await db
        .delete(whitelistConfig)
        .where(eq(whitelistConfig.id, sentinelConfigId));
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
      await db.delete(questions).where(eq(questions.id, sentinelQuestionId));
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, sentinelOnboardingId));
      await db
        .delete(userPnLSnapshots)
        .where(eq(userPnLSnapshots.id, sentinelSnapshotId));
      await db
        .delete(whitelist)
        .where(
          inArray(whitelist.id, [
            sentinelWhitelistUserId,
            sentinelWhitelistGrantId,
          ])
        );
      await db
        .delete(whitelistConfig)
        .where(eq(whitelistConfig.id, sentinelConfigId));
      await db.delete(markets).where(eq(markets.id, controlMarketId));
      await db.delete(users).where(eq(users.id, controlUserId));
      await db.delete(users).where(eq(users.id, controlUserCId));
    }
  });
});
