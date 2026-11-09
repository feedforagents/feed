/** Test-account membership for A2A users.search, PRD §8.2/§12; A2A still retires in MVP Phase 1. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateApiKey, hashApiKey } from '@feed/api';
import { db, inArray, userApiKeys, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const owned = { users: new Set<string>(), keys: new Set<string>() };
const fixtures = new Map<string, string>();
const entrySchema = z.strictObject({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  reputationPoints: z.number(),
  bio: z.string().nullable(),
  isAgent: z.boolean(),
});
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object({
    kind: z.literal('task'),
    contextId: z.string(),
    status: z.object({ state: z.literal('completed') }),
    artifacts: z.array(
      z.object({
        parts: z.array(
          z.object({
            kind: z.literal('data'),
            data: z.object({ users: z.array(entrySchema) }),
          })
        ),
      })
    ),
  }),
});
let rawKey = '';
let token = '';
let usernameToken = '';
let displayToken = '';
const eligible: string[] = [];

function id(label: string) {
  const value = fixtures.get(label);
  assert.ok(value, `Missing owned fixture ${label}`);
  return value;
}
async function insertUsers(rows: Array<typeof users.$inferInsert>) {
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
}
async function send(query: string, limit?: number) {
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}/api/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Feed-Api-Key': rawKey,
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'user',
          parts: [
            {
              kind: 'data',
              data: { operation: 'users.search', params: { query, limit } },
            },
          ],
        },
        configuration: { blocking: true },
      },
    }),
  });
  return { response, requestId };
}
async function search(query = token, limit?: number) {
  const { response, requestId } = await send(query, limit);
  expect(response.status).toBe(200);
  const payload = responseSchema.parse(await response.json());
  expect(payload.id).toBe(requestId);
  expect(payload.result.contextId).toBe(id('caller'));
  const parts = payload.result.artifacts.flatMap((artifact) => artifact.parts);
  expect(parts).toHaveLength(1);
  return parts[0]!.data.users;
}

beforeAll(async () => {
  token = randomUUID().replaceAll('-', '').slice(0, 12);
  usernameToken = `${token}u`;
  displayToken = `${token}d`;
  // A test account by the platform membership rule (isTest flag OR a
  // 'test-' id prefix) can carry the prefix without the flag; the feed
  // surfaces treat both forms as test accounts.
  fixtures.set('prefixname', `test-${await generateSnowflakeId()}`);
  fixtures.set('prefixdisplay', `test-${await generateSnowflakeId()}`);
  for (const label of ['flagtest', 'banned', 'normaluser', 'caller']) {
    fixtures.set(label, await generateSnowflakeId());
  }
  await insertUsers([
    {
      id: id('caller'),
      username: `plain_${id('caller')}`,
      displayName: 'Population fixture caller',
      updatedAt: new Date(),
    },
    {
      id: id('prefixname'),
      username: `${usernameToken}_prefixname`,
      displayName: 'Prefix fixture name',
      isTest: false,
      updatedAt: new Date(),
    },
    {
      id: id('prefixdisplay'),
      username: `plain_${id('prefixdisplay')}`,
      displayName: `${displayToken} prefixdisplay`,
      isTest: false,
      updatedAt: new Date(),
    },
    {
      id: id('flagtest'),
      username: `${usernameToken}_flagtest`,
      displayName: 'Flag fixture',
      isTest: true,
      updatedAt: new Date(),
    },
    {
      id: id('banned'),
      username: `${usernameToken}_banned`,
      displayName: 'Banned fixture',
      isBanned: true,
      updatedAt: new Date(),
    },
    {
      id: id('normaluser'),
      username: `${usernameToken}_normaluser`,
      displayName: `${displayToken} normaluser`,
      updatedAt: new Date(),
    },
  ]);
  eligible.push(id('normaluser'));
  const key = generateApiKey();
  const insertedKeys = await db
    .insert(userApiKeys)
    .values({
      id: await generateSnowflakeId(),
      userId: id('caller'),
      keyHash: hashApiKey(key),
      name: 'Owned users.search prefix regression',
      expiresAt: null,
      revokedAt: null,
    })
    .returning({ id: userApiKeys.id });
  for (const row of insertedKeys) owned.keys.add(row.id);
  rawKey = key;
});

afterAll(async () => {
  if (owned.keys.size)
    await db
      .delete(userApiKeys)
      .where(inArray(userApiKeys.id, [...owned.keys]));
  if (owned.users.size)
    await db.delete(users).where(inArray(users.id, [...owned.users]));
});

test('excludes test accounts identified by the test- id prefix alone', async () => {
  const found = await search();
  expect(found.map((row) => row.id).sort()).toEqual([...eligible].sort());
});

test('applies the prefix exclusion to username and display-name matches', async () => {
  expect((await search(usernameToken)).map((row) => row.id)).toEqual([
    id('normaluser'),
  ]);
  expect((await search(displayToken)).map((row) => row.id)).toEqual([
    id('normaluser'),
  ]);
});

test('fills a small limit with eligible rows only', async () => {
  const found = await search(token, 1);
  expect(found).toHaveLength(1);
  expect(eligible).toContain(found[0]!.id);
});
