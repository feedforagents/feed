/** PRD §12 / MVP phase 5: real HTTP search ranks exact usernames before prefixes. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { db, inArray, userBlocks, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

const schema = z.object({
  users: z.array(z.object({ id: z.string(), username: z.string() })),
});
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const ownedUserIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];
const prefixIds: string[] = [];
let viewerId: string;
let exactId: string;
let agentId: string;
let upperPrefixId: string;
let token: string;
let excludedIds: string[];
async function userId() {
  return generateSnowflakeId();
}

beforeAll(async () => {
  viewerId = await userId();
  exactId = await userId();
  agentId = await userId();
  upperPrefixId = await userId();
  const banned = await userId(),
    blocked = await userId(),
    blockedBy = await userId(),
    muted = await userId(),
    actor = await userId();
  excludedIds = [viewerId, banned, blocked, blockedBy, muted, actor];
  token = `csx${exactId}`;
  for (let i = 0; i < 20; i++) prefixIds.push(await userId());
  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values([
      { id: viewerId, username: `${token}viewer`, updatedAt: now },
      { id: exactId, username: `CSX${exactId}`, updatedAt: now },
      { id: agentId, username: `CSx${exactId}`, isAgent: true, updatedAt: now },
      {
        id: upperPrefixId,
        username: `${token.toUpperCase()}B20`,
        updatedAt: now,
      },
      { id: banned, username: `csX${exactId}`, isBanned: true, updatedAt: now },
      { id: blocked, username: `cSx${exactId}`, updatedAt: now },
      { id: blockedBy, username: `cSX${exactId}`, updatedAt: now },
      { id: muted, username: `Csx${exactId}`, updatedAt: now },
      { id: actor, username: `CsX${exactId}`, isActor: true, updatedAt: now },
      ...prefixIds.map((id, i) => ({
        id,
        username: `${token}a${String(i).padStart(2, '0')}`,
        updatedAt: now,
      })),
    ])
    .returning({ id: users.id });
  ownedUserIds.push(...insertedUsers.map((row) => row.id));
  const candidateBlockIds = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: candidateBlockIds[0]!, blockerId: viewerId, blockedId: blocked },
      { id: candidateBlockIds[1]!, blockerId: blockedBy, blockedId: viewerId },
    ])
    .returning({ id: userBlocks.id });
  blockIds.push(...insertedBlocks.map((row) => row.id));
  const insertedMutes = await db
    .insert(userMutes)
    .values({
      id: await generateSnowflakeId(),
      muterId: viewerId,
      mutedId: muted,
    })
    .returning({ id: userMutes.id });
  muteIds.push(...insertedMutes.map((row) => row.id));
});

afterAll(async () => {
  if (blockIds.length)
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
  if (muteIds.length)
    await db.delete(userMutes).where(inArray(userMutes.id, muteIds));
  if (ownedUserIds.length)
    await db.delete(users).where(inArray(users.id, ownedUserIds));
});

async function search(query: string, includeAgents = false) {
  const url = new URL('/api/users/search', baseUrl);
  url.searchParams.set('q', query);
  if (includeAgents) url.searchParams.set('includeAgents', 'true');
  const response = await fetch(url, {
    headers: { authorization: `Bearer steward:test:${viewerId}` },
  });
  assert.equal(response.status, 200);
  return schema.parse(await response.json()).users;
}

test('requires real authentication', async () => {
  const response = await fetch(
    new URL(`/api/users/search?q=${token}`, baseUrl)
  );
  expect(response.status).toBe(401);
});
for (const uppercase of [false, true]) {
  test(`puts the exact username first for ${uppercase ? 'upper' : 'lower'}-case input`, async () => {
    const rows = await search(uppercase ? token.toUpperCase() : token);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.id).toBe(exactId);
    expect(rows.map((row) => row.id)).toContain(upperPrefixId);
    expect(rows.filter((row) => prefixIds.includes(row.id))).toHaveLength(18);
  });
}
test('excludes both block directions, mutes, bans, actors, agents and the viewer', async () => {
  const ids = (await search(token)).map((row) => row.id);
  for (const id of [...excludedIds, agentId]) expect(ids).not.toContain(id);
});
test('matches prefixes independently of input case', async () => {
  for (const query of [`${token}a1`, `${token.toUpperCase()}A1`]) {
    expect((await search(query)).map((row) => row.id).sort()).toEqual(
      [...prefixIds.slice(10)].sort()
    );
  }
});
test('includes agents only when requested while preserving moderation filters', async () => {
  const ids = (await search(token, true)).map((row) => row.id);
  expect(ids).toContain(agentId);
  expect(ids).toContain(exactId);
  expect(ids).toHaveLength(20);
  for (const id of excludedIds) expect(ids).not.toContain(id);
});
test('treats SQL-looking search input as a value', async () => {
  expect(await search(`${token}' OR true --`)).toEqual([]);
});

for (const exactCount of [8, 32]) {
  test(`ranks ${exactCount} folded-exact usernames before prefixes within the response cap`, async () => {
    const ownedIds: string[] = [];
    const exactIds = new Set<string>();
    const namespace = `rank${await generateSnowflakeId()}`;
    const query = `${namespace}abcde`;
    const fixtures: Array<{ id: string; username: string; updatedAt: Date }> =
      [];
    for (let bits = 0; bits < exactCount; bits++) {
      const id = await generateSnowflakeId();
      exactIds.add(id);
      const suffix = [...'abcde']
        .map((character, index) =>
          bits & (1 << index) ? character.toUpperCase() : character
        )
        .join('');
      fixtures.push({
        id,
        username: namespace + suffix,
        updatedAt: new Date(),
      });
    }
    for (const username of [
      `${namespace.toUpperCase()}ABCDE0`,
      `${namespace}abcde1`,
    ]) {
      fixtures.push({
        id: await generateSnowflakeId(),
        username,
        updatedAt: new Date(),
      });
    }
    try {
      const inserted = await db
        .insert(users)
        .values(fixtures)
        .returning({ id: users.id });
      ownedIds.push(...inserted.map((row) => row.id));
      let previousIds: string[] | undefined;
      for (const input of [query, query.toUpperCase(), query]) {
        const rows = await search(input);
        const ids = rows.map((row) => row.id);
        const returnedExactIds = ids.filter((id) => exactIds.has(id));
        expect(ids).toHaveLength(Math.min(20, exactCount + 2));
        expect(new Set(ids).size).toBe(ids.length);
        expect(returnedExactIds).toHaveLength(Math.min(20, exactCount));
        expect(ids.slice(0, returnedExactIds.length)).toEqual(returnedExactIds);
        if (previousIds) expect(ids).toEqual(previousIds);
        previousIds = ids;
      }
    } finally {
      if (ownedIds.length)
        await db.delete(users).where(inArray(users.id, ownedIds));
    }
  });
}
