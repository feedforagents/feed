/**
 * Keep the retained legacy A2A reputation board's population consistent with
 * ReputationService.getWalletLeaderboard while these surfaces await removal
 * (PRD §13, MVP phase 1). This is not the profit leaderboard in PRD §9.4.
 * Requires a disposable PostgreSQL database with the schema applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { db, inArray, max, users } from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

type LeaderboardEntry = {
  id: string;
  username: string;
  displayName: string;
  reputationPoints: number;
};

const fixtureIds: string[] = [];
const humanIds: string[] = [];
const excludedIds: string[] = [];
let callerId: string;
let basePoints: number;

async function fetchLeaderboard(params: Record<string, JsonValue> = {}) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.leaderboard',
    params,
    callerId
  )) as { leaderboard: LeaderboardEntry[] };
  return result.leaderboard;
}

beforeAll(async () => {
  // Rank owned fixtures above existing seed users without changing anyone
  // else's records. Leave room for every fixture in PostgreSQL's int column.
  const [existing] = await db
    .select({ points: max(users.reputationPoints) })
    .from(users);
  basePoints = Math.max(0, existing?.points ?? 0) + 1;
  if (basePoints > 2147483547) {
    throw new Error(
      'Disposable test database needs 100 points of int headroom'
    );
  }
  const pendingIds: string[] = [];
  for (let index = 0; index < 63; index++) {
    const id = await generateSnowflakeId();
    pendingIds.push(id);
    if (index < 60) humanIds.push(id);
    else excludedIds.push(id);
  }
  callerId = humanIds[0]!;
  await db.insert(users).values(
    pendingIds.map((id, index) => ({
      id,
      username: `a2a-board-${id}`,
      displayName: `A2A board fixture ${index}`,
      // Two top humans tie. Their relative order is intentionally unspecified.
      reputationPoints: basePoints + (index === 59 ? 58 : index),
      isActor: index === 60 || index === 62,
      isAgent: index === 61 || index === 62,
      updatedAt: new Date(),
    }))
  );
  // The bulk insert is atomic. Only its successful rows belong to this suite.
  fixtureIds.push(...pendingIds);
});

afterAll(async () => {
  if (fixtureIds.length > 0) {
    await db.delete(users).where(inArray(users.id, fixtureIds));
  }
});

describe('A2A legacy leaderboard population and limits', () => {
  it('excludes actor, agent, and dual-flag accounts before applying the limit', async () => {
    const leaderboard = await fetchLeaderboard({ limit: 50 });
    expect(leaderboard).toHaveLength(50);
    expect(leaderboard.every((entry) => humanIds.includes(entry.id))).toBe(
      true
    );
    for (const id of excludedIds) {
      expect(leaderboard.some((entry) => entry.id === id)).toBe(false);
    }
    expect(leaderboard.map((entry) => entry.reputationPoints)).toEqual([
      basePoints + 58,
      ...Array.from({ length: 49 }, (_, index) => basePoints + 58 - index),
    ]);
    expect(new Set(leaderboard.map((entry) => entry.id)).size).toBe(50);
  });

  it('keeps tied humans and the response shape without prescribing tie order', async () => {
    const leaderboard = await fetchLeaderboard({ limit: 2 });
    expect(leaderboard.map((entry) => entry.id).sort()).toEqual(
      humanIds.slice(-2).sort()
    );
    for (const entry of leaderboard) {
      expect(Object.keys(entry).sort()).toEqual([
        'displayName',
        'id',
        'reputationPoints',
        'username',
      ]);
      expect(entry.username).toBe(`a2a-board-${entry.id}`);
      expect(entry.reputationPoints).toBe(basePoints + 58);
    }
  });

  it('preserves default, explicit, capped, and fallback limits', async () => {
    for (const [params, expectedLength] of [
      [{}, 10],
      [{ limit: 1 }, 1],
      [{ limit: 50 }, 50],
      [{ limit: 100 }, 50],
      [{ limit: 0 }, 10],
      [{ limit: -1 }, 10],
      [{ limit: '3' }, 3],
    ] as const) {
      const leaderboard = await fetchLeaderboard(params);
      expect(leaderboard).toHaveLength(expectedLength);
      expect(leaderboard.every((entry) => humanIds.includes(entry.id))).toBe(
        true
      );
    }
  });
});
