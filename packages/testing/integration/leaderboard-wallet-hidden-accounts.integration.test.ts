/**
 * Web leaderboard (GET /api/leaderboard, metric=reputation, type=wallet)
 * against a real database: the wallet board must not rank test or banned
 * accounts.
 *
 * The board already curates its membership — ReputationService
 * .getWalletLeaderboard excludes actors (isActor) and agents (isAgent).
 * Two other non-player classes slip through:
 *
 * - Test accounts. Every sibling discovery surface removes them in SQL:
 *   the main feed excludes test authors before paginating
 *   (DatabaseService.getRecentPosts), an author's own post list is empty
 *   for a test user (DatabaseService.getPostsByActor), and the following
 *   feed filters out test users (CachedDatabaseService). A test account
 *   is a user row with isTest = true or an id starting with 'test-'.
 * - Banned accounts. The web people search excludes them outright
 *   (GET /api/users/search base filters: isBanned = false).
 *
 * A test or banned account with a high reputationPoints balance tops the
 * public board, pushes real players down, and inflates totalCount —
 * while getUserPosition counts the same hidden accounts, so a real
 * player's "your rank" is depressed by accounts that should not be on
 * the board at all.
 *
 * The list, its totalCount, and getUserPosition must share one membership
 * rule, the same way actors/agents are already excluded from all three.
 *
 * Nothing is mocked: ReputationService runs against the real database,
 * exactly as the /api/leaderboard route calls it. Fixtures are owned by
 * this suite and removed afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReputationService } from '@feed/api';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

let suffix: string;

let normalHighId: string;
let normalLowId: string;
let normalTieId: string;
let testFlaggedId: string;
let testPrefixedId: string;
let bannedId: string;
let actorId: string;
let agentId: string;

const allIds = () => [
  normalHighId,
  normalLowId,
  normalTieId,
  testFlaggedId,
  testPrefixedId,
  bannedId,
  actorId,
  agentId,
];

function fixtureUser(
  id: string,
  label: string,
  points: number,
  createdAtOffsetMs: number,
  flags: {
    isTest?: boolean;
    isBanned?: boolean;
    isActor?: boolean;
    isAgent?: boolean;
  } = {}
) {
  const createdAt = new Date(BASE_TIME + createdAtOffsetMs);
  return {
    id,
    username: `g14-${suffix}-${label}`,
    displayName: 'Leaderboard fixture',
    reputationPoints: points,
    isTest: flags.isTest ?? false,
    isBanned: flags.isBanned ?? false,
    isActor: flags.isActor ?? false,
    isAgent: flags.isAgent ?? false,
    createdAt,
    updatedAt: createdAt,
  };
}

beforeAll(async () => {
  suffix = (await generateSnowflakeId()).slice(-10);
  normalHighId = `g14-high-${suffix}`;
  normalLowId = `g14-low-${suffix}`;
  normalTieId = `g14-tie-${suffix}`;
  testFlaggedId = `g14-testflag-${suffix}`;
  testPrefixedId = `test-g14-${suffix}`;
  bannedId = `g14-banned-${suffix}`;
  actorId = `g14-actor-${suffix}`;
  agentId = `g14-agent-${suffix}`;

  await db.insert(users).values([
    fixtureUser(actorId, 'actor', 950, 0, { isActor: true }),
    fixtureUser(testFlaggedId, 'testflag', 900, 1_000, { isTest: true }),
    fixtureUser(agentId, 'agent', 850, 2_000, { isAgent: true }),
    fixtureUser(testPrefixedId, 'testprefix', 800, 3_000),
    fixtureUser(bannedId, 'banned', 700, 4_000, { isBanned: true }),
    fixtureUser(normalHighId, 'high', 300, 5_000),
    fixtureUser(normalLowId, 'low', 100, 6_000),
    // Same points as normalLow but created later: the board's tiebreak
    // (points desc, createdAt asc, id asc) must place it after normalLow.
    fixtureUser(normalTieId, 'tie', 100, 7_000),
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, allIds()));
});

describe('wallet reputation leaderboard membership', () => {
  it('lists only real players: test and banned accounts never appear', async () => {
    const board = await ReputationService.getWalletLeaderboard(1, 100);
    const ids = board.users.map((entry) => entry.id);

    expect(ids).toContain(normalHighId);
    expect(ids).toContain(normalLowId);
    expect(ids).toContain(normalTieId);
    expect(ids).not.toContain(testFlaggedId);
    expect(ids).not.toContain(testPrefixedId);
    expect(ids).not.toContain(bannedId);
    // Controls: already excluded before this fix.
    expect(ids).not.toContain(actorId);
    expect(ids).not.toContain(agentId);
    // The fixtures are the only users in this database.
    expect(board.totalCount).toBe(3);
  });

  it('ranks follow the visible board, including across pages and ties', async () => {
    const board = await ReputationService.getWalletLeaderboard(1, 100);
    const rankOf = (id: string) =>
      board.users.find((entry) => entry.id === id)?.rank;

    expect(rankOf(normalHighId)).toBe(1);
    expect(rankOf(normalLowId)).toBe(2);
    expect(rankOf(normalTieId)).toBe(3);

    const page1 = await ReputationService.getWalletLeaderboard(1, 1);
    const page2 = await ReputationService.getWalletLeaderboard(2, 1);
    expect(page1.users.map((entry) => entry.id)).toEqual([normalHighId]);
    expect(page2.users.map((entry) => entry.id)).toEqual([normalLowId]);
    expect(page1.totalPages).toBe(3);
  });

  it('user position agrees with the list and skips hidden accounts', async () => {
    const high = await ReputationService.getUserPosition(
      normalHighId,
      'wallet',
      100
    );
    expect(high?.rank).toBe(1);

    const tie = await ReputationService.getUserPosition(
      normalTieId,
      'wallet',
      100
    );
    expect(tie?.rank).toBe(3);

    // Hidden accounts have no position on the board, the same way
    // actors and agents already return null.
    expect(
      await ReputationService.getUserPosition(testFlaggedId, 'wallet', 100)
    ).toBeNull();
    expect(
      await ReputationService.getUserPosition(bannedId, 'wallet', 100)
    ).toBeNull();
  });
});
