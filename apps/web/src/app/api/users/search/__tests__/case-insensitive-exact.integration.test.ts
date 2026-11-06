/**
 * GET /api/users/search against a real database: the search is documented as
 * case-insensitive, and an exact username match is returned ahead of prefix
 * and substring matches.
 *
 * Usernames may contain upper-case letters and are stored as entered, so a
 * viewer typing `alice` must still find `Alice`, even when more than 20 other
 * usernames start with `alice`. Only authentication is replaced; the
 * database, the asUser adapter and the query run unmodified.
 */

import { beforeAll, describe, expect, it, mock } from 'bun:test';
import path from 'node:path';
import { db, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type SearchResponse = {
  users: Array<{ id: string; username: string }>;
};

const DISTRACTOR_COUNT = 20;

let viewerId: string;
let exactId: string;
let bannedId: string;
let token: string;
const distractorIds: string[] = [];
let GET: typeof import('../route').GET;

beforeAll(async () => {
  viewerId = await generateSnowflakeId();
  exactId = await generateSnowflakeId();
  bannedId = await generateSnowflakeId();
  for (let i = 0; i < DISTRACTOR_COUNT; i++) {
    distractorIds.push(await generateSnowflakeId());
  }
  token = `cs${exactId}`;

  const apiIndex = path.resolve(
    import.meta.dir,
    '../../../../../../../../packages/api/src/index.ts'
  );
  const actualApi = await import(apiIndex);
  mock.module('@feed/api', () => ({
    ...actualApi,
    authenticate: async () => ({
      userId: viewerId,
      dbUserId: viewerId,
    }),
  }));
  ({ GET } = await import('../route'));

  const now = new Date();
  await db.insert(users).values([
    {
      id: viewerId,
      username: `sv-${viewerId}`,
      displayName: 'Search viewer fixture',
      updatedAt: now,
    },
    {
      id: exactId,
      username: token.toUpperCase(),
      displayName: 'Search fixture',
      updatedAt: now,
    },
    {
      // Another case variant of the exact username; banned users stay hidden.
      id: bannedId,
      username: `C${token.slice(1)}`,
      displayName: 'Search fixture',
      isBanned: true,
      updatedAt: now,
    },
    ...distractorIds.map((id, i) => ({
      id,
      username: `${token}a${String(i).padStart(2, '0')}`,
      displayName: 'Search fixture',
      updatedAt: now,
    })),
  ]);
});

async function search(q: string): Promise<SearchResponse> {
  const res = await GET(
    new NextRequest(
      `https://feed.example/api/users/search?q=${encodeURIComponent(q)}`
    )
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResponse;
}

describe('GET /api/users/search (real database)', () => {
  it('fixtures are valid ordinary usernames', () => {
    for (const name of [token.toUpperCase(), `${token}a19`]) {
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('returns the mixed-case exact username when typed in lower case', async () => {
    const body = await search(token);
    const ids = body.users.map((u) => u.id);

    // The query reached the database and saw this run's fixtures.
    expect(ids.some((id) => distractorIds.includes(id))).toBe(true);

    expect(ids).toContain(exactId);
    expect(body.users[0]?.id).toBe(exactId);
    expect(ids).not.toContain(bannedId);
  });

  it('returns the exact username first when typed in the same case', async () => {
    const body = await search(token.toUpperCase());
    const ids = body.users.map((u) => u.id);

    expect(body.users[0]?.id).toBe(exactId);
    // Upper-case input still prefix-matches the lower-case usernames.
    expect(ids.filter((id) => distractorIds.includes(id))).toHaveLength(
      DISTRACTOR_COUNT - 1
    );
  });

  it('prefix-matches usernames regardless of input case', async () => {
    const expected = distractorIds.slice(10);
    for (const q of [`${token}a1`, `${token.toUpperCase()}A1`]) {
      const ids = (await search(q)).users.map((u) => u.id);

      expect(ids).not.toContain(exactId);
      expect([...ids].sort()).toEqual([...expected].sort());
    }
  });
});
