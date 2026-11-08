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
  const id = await generateSnowflakeId();
  ownedUserIds.push(id);
  return id;
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
  await db.insert(users).values([
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
  ]);
  blockIds.push(await generateSnowflakeId(), await generateSnowflakeId());
  muteIds.push(await generateSnowflakeId());
  await db.insert(userBlocks).values([
    { id: blockIds[0]!, blockerId: viewerId, blockedId: blocked },
    { id: blockIds[1]!, blockerId: blockedBy, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values({ id: muteIds[0]!, muterId: viewerId, mutedId: muted });
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
