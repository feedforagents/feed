/**
 * stats.leaderboard against a real database: the A2A points leaderboard
 * must apply the same population rule as the web points leaderboard.
 *
 * The web leaderboard (GET /api/leaderboard, ReputationService
 * .getWalletLeaderboard — "each human wallet ranked by reputation") reads
 * the same users table with isActor=false AND isAgent=false, and
 * ReputationService.getLeaderboard's users query excludes actors and
 * agents in every category ("All modes exclude actors (isActor=false)
 * AND agents (isAgent=false)"). The A2A executor's getLeaderboard applied
 * no filter at all, so NPC actor accounts and agent accounts holding
 * reputation points took the top ranks of the board an agent reads back
 * to its user — ranks that exist on no web surface.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../feed-executor';

type LeaderboardResult = {
  leaderboard: Array<{ id: string; reputationPoints: number }>;
};

let callerId: string;
let humanTopId: string;
let humanMidId: string;
let humanLowId: string;
let actorId: string;
let agentId: string;

const allUserIds: string[] = [];

async function fetchLeaderboard() {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.leaderboard',
    { limit: 50 },
    callerId
  )) as unknown as LeaderboardResult;
  return result.leaderboard;
}

beforeAll(async () => {
  [callerId, humanTopId, humanMidId, humanLowId, actorId, agentId] =
    await Promise.all(Array.from({ length: 6 }, () => generateSnowflakeId()));
  allUserIds.push(
    callerId,
    humanTopId,
    humanMidId,
    humanLowId,
    actorId,
    agentId
  );

  const now = new Date();
  await db.insert(users).values([
    {
      id: callerId,
      username: `test-f14-caller-${callerId}`,
      displayName: 'F14 Caller',
      reputationPoints: 0,
      updatedAt: now,
    },
    {
      id: humanTopId,
      username: `test-f14-human-top-${humanTopId}`,
      displayName: 'F14 Human Top',
      reputationPoints: 400,
      updatedAt: now,
    },
    {
      id: humanMidId,
      username: `test-f14-human-mid-${humanMidId}`,
      displayName: 'F14 Human Mid',
      reputationPoints: 100,
      updatedAt: now,
    },
    {
      id: humanLowId,
      username: `test-f14-human-low-${humanLowId}`,
      displayName: 'F14 Human Low',
      reputationPoints: 50,
      updatedAt: now,
    },
    {
      id: actorId,
      username: `test-f14-actor-${actorId}`,
      displayName: 'F14 NPC Actor',
      reputationPoints: 500,
      isActor: true,
      updatedAt: now,
    },
    {
      id: agentId,
      username: `test-f14-agent-${agentId}`,
      displayName: 'F14 Agent Account',
      reputationPoints: 300,
      isAgent: true,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('A2A stats.leaderboard actor/agent filter', () => {
  it('ranks only human wallets, matching the web points leaderboard', async () => {
    const leaderboard = await fetchLeaderboard();
    const fixtureEntries = leaderboard.filter((entry) =>
      allUserIds.includes(entry.id)
    );

    // The actor (500) and the agent (300) hold more points than every
    // human except the top human, but the web board excludes both
    // populations, so neither may appear here either.
    expect(fixtureEntries.map((entry) => entry.id)).toEqual([
      humanTopId,
      humanMidId,
      humanLowId,
      callerId,
    ]);
    expect(fixtureEntries.map((entry) => entry.reputationPoints)).toEqual([
      400, 100, 50, 0,
    ]);
  });
});
