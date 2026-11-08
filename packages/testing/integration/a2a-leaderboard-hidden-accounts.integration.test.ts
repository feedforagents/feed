import { afterAll, beforeAll, expect, test } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

/**
 * A2A stats.leaderboard is the agent-facing points leaderboard (listed in
 * docs/skills.md under the stats-discovery skill). On base it reads the
 * users table with no membership filter at all, a `reputationPoints`-only
 * sort, and a take-only cap (default 10, max 50) with no offset — so test
 * and banned accounts hold the top ranks an agent reads back to its user,
 * and every rank past the cap is unreachable.
 *
 * The web points leaderboard over the same table applies one membership
 * rule (ReputationService walletLeaderboardMembership, #1692): not an
 * actor, not an agent, not a test account (isTest flag or a 'test-' id
 * prefix), not banned. Open PR #1664 adds only the actor/agent half of
 * that rule to this handler; the hidden human tiers and the reachability
 * defect remain.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const callerId = `lb-caller-${suffix}`;

// Hidden tiers, all holding more points than every visible fixture.
const testFlagId = `lb-testflag-${suffix}`;
const testIdId = `test-lb-${suffix}`;
const bannedId = `lb-banned-${suffix}`;
const actorId = `lb-actor-${suffix}`;
const agentAccId = `lb-agent-${suffix}`;
const hiddenIds = [testFlagId, testIdId, bannedId, actorId, agentAccId];

// 60 visible humans with distinct points (600_000 down to 541_000).
const distinctIds: string[] = [];
for (let i = 0; i < 60; i++) distinctIds.push(`lb-dist-${suffix}-${i}`);
// 30 visible humans sharing one point value (300_000) — the tie batch.
const tieIds: string[] = [];
for (let i = 0; i < 30; i++) tieIds.push(`lb-tie-${suffix}-${i}`);
const visibleIds = [...distinctIds, ...tieIds];
const allIds = [callerId, ...hiddenIds, ...visibleIds];

async function seed(): Promise<void> {
  const now = new Date();
  const base = { updatedAt: now };
  await db.insert(users).values([
    {
      ...base,
      id: callerId,
      username: callerId,
      isAgent: true,
      reputationPoints: 0,
    },
    {
      ...base,
      id: testFlagId,
      username: testFlagId,
      isTest: true,
      reputationPoints: 990_000,
    },
    { ...base, id: testIdId, username: testIdId, reputationPoints: 980_000 },
    {
      ...base,
      id: bannedId,
      username: bannedId,
      isBanned: true,
      reputationPoints: 970_000,
    },
    {
      ...base,
      id: actorId,
      username: actorId,
      isActor: true,
      reputationPoints: 960_000,
    },
    {
      ...base,
      id: agentAccId,
      username: agentAccId,
      isAgent: true,
      reputationPoints: 950_000,
    },
  ]);
  await db.insert(users).values(
    distinctIds.map((id, i) => ({
      ...base,
      id,
      username: id,
      reputationPoints: 600_000 - i * 1_000,
    }))
  );
  await db.insert(users).values(
    tieIds.map((id) => ({
      ...base,
      id,
      username: id,
      reputationPoints: 300_000,
    }))
  );
}

beforeAll(seed);

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, allIds));
});

interface LeaderboardResult {
  leaderboard: Array<{ id: string; reputationPoints: number }>;
}

async function getLeaderboard(
  params: Record<string, number>
): Promise<LeaderboardResult['leaderboard']> {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.leaderboard',
    params,
    callerId
  )) as unknown as LeaderboardResult;
  return result.leaderboard;
}

test('hidden tiers never appear on the A2A leaderboard', async () => {
  const board = await getLeaderboard({ limit: 50 });
  const ids = board.map((e) => e.id);
  for (const hidden of hiddenIds) {
    expect(ids).not.toContain(hidden);
  }
  // The top of the board is the visible distinct-points order.
  const fixtureOrder = ids.filter((id) => distinctIds.includes(id));
  expect(fixtureOrder).toEqual(distinctIds.slice(0, fixtureOrder.length));
  expect(board[0]?.reputationPoints).toBe(600_000);
});

test('offset paging reaches every visible account exactly once past the cap', async () => {
  const seen: string[] = [];
  for (let offset = 0; offset <= 500; offset += 50) {
    const page = await getLeaderboard({ limit: 50, offset });
    const fixturePage = page
      .map((e) => e.id)
      .filter((id) => visibleIds.includes(id));
    seen.push(...fixturePage);
    if (page.length < 50) break;
  }
  expect(new Set(seen).size).toBe(seen.length);
  expect([...seen].sort()).toEqual([...visibleIds].sort());
});

test('paging through a 30-way points tie is deterministic', async () => {
  const walks: string[][] = [];
  for (let w = 0; w < 3; w++) {
    const tieSeen: string[] = [];
    for (let offset = 0; offset <= 500; offset += 10) {
      const page = await getLeaderboard({ limit: 10, offset });
      tieSeen.push(
        ...page.map((e) => e.id).filter((id) => tieIds.includes(id))
      );
      if (page.length < 10) break;
    }
    walks.push(tieSeen);
  }
  for (const walk of walks) {
    expect([...walk].sort()).toEqual([...tieIds].sort());
  }
  expect(walks[1]).toEqual(walks[0]);
  expect(walks[2]).toEqual(walks[0]);
});
