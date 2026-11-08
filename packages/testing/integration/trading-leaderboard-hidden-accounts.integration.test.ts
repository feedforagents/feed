/**
 * Integration Tests: Trading Leaderboard Hidden Accounts
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied. Every test returns early when no database is reachable, the
 * convention of this directory.
 *
 * The main leaderboard page's trading tab (GET /api/leaderboard
 * ?metric=trading, served by TradingLeaderboardService /
 * TradingPerformanceService) must keep the same non-player accounts off
 * the board that the rest of the product already hides: test accounts
 * (isTest flag or a 'test-' id prefix) and banned accounts. Sibling
 * surfaces already exclude them — the reputation tab of the same page
 * filters isTest/isBanned/'test-' in ReputationService, the main feed
 * excludes test authors in SQL before paging, and web people search
 * excludes banned accounts by default. The trading board's row query,
 * its total count, and its own-position lookup must agree, or hidden
 * accounts take top ranks, inflate totalCount/totalPages, and push a
 * real player's own rank down.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { TradingLeaderboardService } from '@feed/api/services/trading-leaderboard-service';
import { db, inArray, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(30000);

let dbAvailable = false;
const testUserIds: string[] = [];

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

async function createTestUser(params: {
  usernamePrefix: string;
  lifetimePnL: number;
  createdAt: Date;
  isActor?: boolean;
  isAgent?: boolean;
  isTest?: boolean;
  isBanned?: boolean;
  testPrefixedId?: boolean;
}): Promise<string> {
  const snowflake = await generateSnowflakeId();
  const id = params.testPrefixedId ? `test-${snowflake}` : snowflake;
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-${id}`,
    username: `${params.usernamePrefix}-${snowflake}`,
    displayName: params.usernamePrefix,
    virtualBalance: '1000',
    totalDeposited: '1000',
    totalWithdrawn: '0',
    lifetimePnL: params.lifetimePnL.toFixed(2),
    reputationPoints: 0,
    isActor: params.isActor ?? false,
    isAgent: params.isAgent ?? false,
    isTest: params.isTest ?? false,
    isBanned: params.isBanned ?? false,
    profileComplete: true,
    createdAt: params.createdAt,
    updatedAt: new Date(),
  });
  testUserIds.push(id);
  return id;
}

const baseTime = new Date('2026-03-01T00:00:00.000Z');
const at = (days: number) =>
  new Date(baseTime.getTime() + days * 24 * 60 * 60 * 1000);

let actorId = '';
let testFlaggedId = '';
let testPrefixedId = '';
let agentId = '';
let bannedId = '';
let normalHighId = '';
let normalTieEarlyId = '';
let normalTieLateId = '';

beforeAll(async () => {
  dbAvailable = await checkDatabaseHealth();
  if (!dbAvailable) return;

  actorId = await createTestUser({
    usernamePrefix: 'lb-hidden-actor',
    lifetimePnL: 950,
    createdAt: at(0),
    isActor: true,
  });
  testFlaggedId = await createTestUser({
    usernamePrefix: 'lb-hidden-test-flag',
    lifetimePnL: 900,
    createdAt: at(1),
    isTest: true,
  });
  agentId = await createTestUser({
    usernamePrefix: 'lb-hidden-agent',
    lifetimePnL: 850,
    createdAt: at(2),
    isAgent: true,
  });
  testPrefixedId = await createTestUser({
    usernamePrefix: 'lb-hidden-test-prefix',
    lifetimePnL: 800,
    createdAt: at(3),
    testPrefixedId: true,
  });
  bannedId = await createTestUser({
    usernamePrefix: 'lb-hidden-banned',
    lifetimePnL: 700,
    createdAt: at(4),
    isBanned: true,
  });
  normalHighId = await createTestUser({
    usernamePrefix: 'lb-hidden-normal-high',
    lifetimePnL: 300,
    createdAt: at(5),
  });
  normalTieEarlyId = await createTestUser({
    usernamePrefix: 'lb-hidden-normal-tie-early',
    lifetimePnL: 100,
    createdAt: at(6),
  });
  normalTieLateId = await createTestUser({
    usernamePrefix: 'lb-hidden-normal-tie-late',
    lifetimePnL: 100,
    createdAt: at(7),
  });
});

afterAll(async () => {
  if (!dbAvailable || testUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, testUserIds));
});

describe('Trading leaderboard hidden accounts', () => {
  test('board lists only real players, with a matching totalCount', async () => {
    if (!dbAvailable) return;

    const result = await TradingLeaderboardService.getWalletLeaderboard(1, 100);

    const ids = result.users.map((entry) => entry.id);
    expect(ids).not.toContain(testFlaggedId);
    expect(ids).not.toContain(testPrefixedId);
    expect(ids).not.toContain(bannedId);
    expect(ids).not.toContain(actorId);
    expect(ids).not.toContain(agentId);
    expect(ids).toEqual([normalHighId, normalTieEarlyId, normalTieLateId]);
    expect(result.users.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(result.totalCount).toBe(3);
    expect(result.totalPages).toBe(1);
  });

  test('own position counts only real players above, and hidden accounts have no position', async () => {
    if (!dbAvailable) return;

    const high = await TradingLeaderboardService.getUserPosition(
      normalHighId,
      'wallet',
      100
    );
    expect(high?.rank).toBe(1);
    expect(high?.page).toBe(1);

    const tieLate = await TradingLeaderboardService.getUserPosition(
      normalTieLateId,
      'wallet',
      100
    );
    expect(tieLate?.rank).toBe(3);

    for (const hiddenId of [testFlaggedId, testPrefixedId, bannedId]) {
      const position = await TradingLeaderboardService.getUserPosition(
        hiddenId,
        'wallet',
        100
      );
      expect(position).toBeNull();
    }
  });

  test('every real player is reachable across page boundaries', async () => {
    if (!dbAvailable) return;

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await TradingLeaderboardService.getWalletLeaderboard(
        page,
        1
      );
      expect(result.totalCount).toBe(3);
      expect(result.totalPages).toBe(3);
      expect(result.users).toHaveLength(1);
      seen.push(result.users[0]?.id ?? '');
      expect(result.users[0]?.rank).toBe(page);
    }
    expect(seen).toEqual([normalHighId, normalTieEarlyId, normalTieLateId]);

    const beyond = await TradingLeaderboardService.getWalletLeaderboard(4, 1);
    expect(beyond.users).toHaveLength(0);
  });
});
