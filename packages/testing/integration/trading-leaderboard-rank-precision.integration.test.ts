/**
 * Integration Tests: Trading Leaderboard Rank Precision (PRD §9.4, D-15b)
 *
 * The profit board has two read paths —
 *   A. TradingLeaderboardService.getWalletLeaderboard (paged list)
 *   B. TradingLeaderboardService.getUserPosition ("my rank")
 * and both must follow the same total order (netProfit desc, createdAt
 * asc, id asc). These tests pin that agreement for exact netProfit ties,
 * identical createdAt ties, and createdAt values that differ only below
 * millisecond precision: production rows are stamped by the DB default
 * now() with microseconds, so a rank computation that round-trips
 * createdAt through a JS Date (millisecond precision) undercounts
 * wallets created in the same millisecond and reports a rank that
 * disagrees with the list itself.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { TradingLeaderboardService } from '@feed/api/services/trading-leaderboard-service';
import { TradingPerformanceService } from '@feed/api/services/trading-performance-service';
import { db, inArray, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(60000);

const PAGE_SIZE = 7;
const fixtureIds: string[] = [];

async function createUser(params: {
  prefix: string;
  lifetimePnL: string;
  createdAt: Date;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:f133-${id}`,
    username: `${params.prefix}-${id}`,
    displayName: params.prefix,
    virtualBalance: '1000',
    totalDeposited: '1000',
    totalWithdrawn: '0',
    lifetimePnL: params.lifetimePnL,
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    createdAt: params.createdAt,
    updatedAt: new Date(),
  });
  fixtureIds.push(id);
  return id;
}

async function createUserRawCreatedAt(params: {
  prefix: string;
  lifetimePnL: string;
  createdAtLiteral: string;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.execute(sql`
    INSERT INTO "User" (
      "id", "privyId", "username", "displayName", "virtualBalance",
      "totalDeposited", "totalWithdrawn", "lifetimePnL", "reputationPoints",
      "isActor", "isAgent", "profileComplete", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${`did:privy:f133-${id}`}, ${`${params.prefix}-${id}`},
      ${params.prefix}, '1000', '1000', '0', ${params.lifetimePnL}, 0,
      false, false, true, ${params.createdAtLiteral}::timestamp,
      ${params.createdAtLiteral}::timestamp
    )
  `);
  fixtureIds.push(id);
  return id;
}

async function fullScanIds(): Promise<string[]> {
  const rows = await TradingPerformanceService.getWalletLeaderboardRows(
    100000,
    0
  );
  return rows.map((row) => row.id);
}

afterAll(async () => {
  if (fixtureIds.length > 0) {
    await db.delete(users).where(inArray(users.id, fixtureIds));
  }
});

describe('Trading leaderboard rank precision', () => {
  test('paged traversal reaches every fixture exactly once, in full-scan order', async () => {
    // Exact-tie group: identical netProfit AND identical createdAt (8 users).
    const tieCreatedAt = new Date('2026-02-10T00:00:00.000Z');
    for (let i = 0; i < 8; i++) {
      await createUser({
        prefix: 'f133-tie-exact',
        lifetimePnL: '4242.25',
        createdAt: tieCreatedAt,
      });
    }
    // Spread group: distinct profits and days.
    for (let i = 0; i < 15; i++) {
      await createUser({
        prefix: 'f133-spread',
        lifetimePnL: (100 + i * 100).toFixed(2),
        createdAt: new Date(
          `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
        ),
      });
    }

    const scan = await fullScanIds();
    const scanFixtures = scan.filter((id) => fixtureIds.includes(id));
    expect(scanFixtures.length).toBe(fixtureIds.length);

    const first = await TradingLeaderboardService.getWalletLeaderboard(
      1,
      PAGE_SIZE
    );
    expect(first.totalCount).toBe(scan.length);

    const traversed: string[] = [];
    for (let page = 1; page <= first.totalPages; page++) {
      const result = await TradingLeaderboardService.getWalletLeaderboard(
        page,
        PAGE_SIZE
      );
      for (const entry of result.users) {
        if (fixtureIds.includes(entry.id)) traversed.push(entry.id);
        // Rank labels must be the global ranks, sequential per page.
        expect(entry.rank).toBe(
          (page - 1) * PAGE_SIZE + result.users.indexOf(entry) + 1
        );
      }
    }
    expect(traversed).toEqual(scanFixtures);
  });

  test('my-rank agrees with the list order for tied users', async () => {
    // Self-owned fixtures: an exact-tie group (identical netProfit AND
    // identical createdAt), created by this test rather than inherited
    // from the traversal test above, so the assertions below run — and
    // mean the same thing — when this test executes on its own.
    const tieCreatedAt = new Date('2026-02-20T00:00:00.000Z');
    const ownIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      ownIds.push(
        await createUser({
          prefix: 'f133-myrank-tie',
          lifetimePnL: '5151.75',
          createdAt: tieCreatedAt,
        })
      );
    }
    // Precondition: the board under assertion is this test's own
    // non-empty fixture set.
    expect(ownIds.length).toBe(8);

    const scan = await fullScanIds();
    for (const id of ownIds) {
      const scanIndex = scan.indexOf(id);
      expect(scanIndex).toBeGreaterThanOrEqual(0);
      const position = await TradingLeaderboardService.getUserPosition(
        id,
        'wallet',
        PAGE_SIZE
      );
      expect(position).not.toBeNull();
      expect(position?.rank).toBe(scanIndex + 1);
      expect(position?.page).toBe(Math.ceil((scanIndex + 1) / PAGE_SIZE));
      expect(position?.entry.id).toBe(id);
    }
  });

  test('sub-millisecond createdAt ties: rank still agrees with list order', async () => {
    // Same netProfit; createdAt differs only in microseconds, like rows
    // stamped by the DB default now() in production.
    const a = await createUserRawCreatedAt({
      prefix: 'f133-us-a',
      lifetimePnL: '3131.50',
      createdAtLiteral: '2026-03-01 00:00:00.123456',
    });
    const b = await createUserRawCreatedAt({
      prefix: 'f133-us-b',
      lifetimePnL: '3131.50',
      createdAtLiteral: '2026-03-01 00:00:00.123200',
    });

    const scan = await fullScanIds();
    const indexA = scan.indexOf(a);
    const indexB = scan.indexOf(b);
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    // Stored order: B (…123200) strictly before A (…123456).
    expect(indexB).toBeLessThan(indexA);

    for (const [id, scanIndex] of [
      [a, indexA],
      [b, indexB],
    ] as const) {
      const position = await TradingLeaderboardService.getUserPosition(
        id,
        'wallet',
        PAGE_SIZE
      );
      expect(position?.rank).toBe(scanIndex + 1);
    }
  });
});
