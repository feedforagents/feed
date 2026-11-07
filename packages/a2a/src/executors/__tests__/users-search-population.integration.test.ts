/**
 * A2A users.search against a real database: the executor's people search
 * must apply the same population exclusions as the web people search
 * (GET /api/users/search). The web route returns real users only: banned
 * accounts are excluded by its base filters, and test accounts are
 * excluded from every user-facing surface (the following feed strips
 * test authors from followedIds, the main feed excludes test authors in
 * SQL, and a test author's profile post list is empty). The A2A
 * searchUsers handler filtered on nothing, so an agent searching for a
 * person received banned and test accounts alongside real users.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../feed-executor';

type SearchUsersResult = {
  users: Array<{ id: string; username: string | null }>;
};

let searcherId: string;
let normalId: string;
let bannedId: string;
let testId: string;
let token: string;

const allUserIds: string[] = [];

async function searchUsers(query: string) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'users.search',
    { query },
    searcherId
  )) as unknown as SearchUsersResult;
  return result.users;
}

beforeAll(async () => {
  [searcherId, normalId, bannedId, testId] = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  allUserIds.push(searcherId, normalId, bannedId, testId);
  // One shared token so a single query matches every fixture.
  token = `f22seek${normalId.slice(-6)}`;

  const now = new Date();
  await db.insert(users).values([
    {
      id: normalId,
      username: `${token}-normal`,
      displayName: 'F22 Normal User',
      updatedAt: now,
    },
    {
      // Matches on username; banned users stay hidden on the web search.
      id: bannedId,
      username: `${token}-banned`,
      displayName: 'F22 Banned User',
      isBanned: true,
      updatedAt: now,
    },
    {
      // Matches on display name; test accounts are not real users.
      id: testId,
      username: `f22plain${testId.slice(-6)}`,
      displayName: `${token} Test Account`,
      isTest: true,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('A2A users.search population rules', () => {
  it('returns real users but not banned or test accounts', async () => {
    const found = await searchUsers(token);
    const ids = found.map((u) => u.id);

    // The query reached the database and saw this run's fixtures.
    expect(ids).toContain(normalId);
    expect(ids).not.toContain(bannedId);
    expect(ids).not.toContain(testId);
  });
});
