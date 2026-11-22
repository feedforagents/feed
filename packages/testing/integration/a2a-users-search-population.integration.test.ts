/** Retained lookup/moderation, PRD §8.2/§12; A2A still retires in MVP Phase 1. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateApiKey, hashApiKey } from '@feed/api';
import { db, eq, inArray, userApiKeys, users } from '@feed/db';
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
async function insertUsers(
  rows: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  for (const row of inserted) ownership.add(row.id);
}
async function removeUsers(ownership: Set<string>) {
  if (ownership.size)
    await db.delete(users).where(inArray(users.id, [...ownership]));
}
async function send(
  query: string,
  limit?: number | string,
  key: string | undefined = rawKey
) {
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (key) headers['X-Feed-Api-Key'] = key;
  const response = await fetch(`${baseUrl}/api/a2a`, {
    method: 'POST',
    headers,
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
async function search(query = token, limit?: number | string) {
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
  const labels = [
    'banneduser',
    'banneddisplay',
    'testuser',
    'testdisplay',
    'normaluser',
    'normaldisplay',
    'agent',
    'actor',
    'caller',
  ];
  for (const label of labels) fixtures.set(label, await generateSnowflakeId());
  token = `p22${id('caller').slice(-10)}`;
  usernameToken = `${token}u`;
  displayToken = `${token}d`;
  await insertUsers(
    labels.map((label) => ({
      id: id(label),
      username:
        label.endsWith('display') || label === 'caller'
          ? `plain_${id(label)}`
          : `${usernameToken}_${label}`,
      displayName: label.endsWith('display')
        ? `${displayToken} ${label}`
        : `Population fixture ${label}`,
      bio: `Owned population fixture ${label}`,
      isBanned: label.startsWith('banned'),
      isTest: label.startsWith('test'),
      isAgent: label === 'agent',
      isActor: label === 'actor',
      reputationPoints: 17,
      updatedAt: new Date(),
    }))
  );
  eligible.push(...['normaluser', 'normaldisplay', 'agent', 'actor'].map(id));
  const key = generateApiKey();
  const insertedKeys = await db
    .insert(userApiKeys)
    .values({
      id: await generateSnowflakeId(),
      userId: id('caller'),
      keyHash: hashApiKey(key),
      name: 'Owned users.search HTTP regression',
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
  await removeUsers(owned.users);
});

test('excludes banned/test matches while retaining real users, agents and actors', async () => {
  const found = await search();
  expect(found.map((row) => row.id).sort()).toEqual([...eligible].sort());
  expect(found.find((row) => row.id === id('agent'))?.isAgent).toBe(true);
  expect(found.find((row) => row.id === id('actor'))?.isAgent).toBe(false);
  for (const row of found) {
    expect(row.reputationPoints).toBe(17);
    expect(row.bio).toStartWith('Owned population fixture');
  }
});
test('applies both exclusions to username and display-name matches', async () => {
  expect((await search(usernameToken)).map((row) => row.id).sort()).toEqual(
    ['normaluser', 'agent', 'actor'].map(id).sort()
  );
  expect((await search(displayToken)).map((row) => row.id)).toEqual([
    id('normaldisplay'),
  ]);
});
test('fills small limits with eligible rows and preserves existing limit parsing', async () => {
  for (const [limit, expected] of [
    [1, 1],
    [2, 2],
    ['2', 2],
    [0, 4],
  ] as const) {
    const found = await search(token, limit);
    expect(found).toHaveLength(expected);
    expect(found.every((row) => eligible.includes(row.id))).toBe(true);
  }
});
test('keeps case-insensitive matching and whitespace trimming', async () => {
  expect(
    (await search(`  ${token.toUpperCase()}  `)).map((row) => row.id).sort()
  ).toEqual([...eligible].sort());
});
test('returns no invented users for an unmatched query', async () => {
  expect(await search(`${token}absent`)).toEqual([]);
});
test('requires a real stored per-user key and binds the task to its owner', async () => {
  for (const key of ['', generateApiKey()]) {
    const { response } = await send(token, 2, key);
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  }
  expect(
    (await search(token, 1)).every((row) => eligible.includes(row.id))
  ).toBe(true);
});
test('failed setup cleanup owns only successfully returned inserts', async () => {
  const partial = new Set<string>();
  const failed = new Set<string>();
  const partialId = await generateSnowflakeId();
  try {
    await insertUsers(
      [
        {
          id: partialId,
          username: `partial_${partialId}`,
          updatedAt: new Date(),
        },
      ],
      partial
    );
    await expect(
      insertUsers(
        [
          {
            id: id('normaluser'),
            username: `collision_${partialId}`,
            updatedAt: new Date(),
          },
        ],
        failed
      )
    ).rejects.toThrow();
    expect(partial.size).toBe(1);
    expect(failed.size).toBe(0);
    await removeUsers(failed);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id('normaluser')));
    expect(rows).toHaveLength(1);
  } finally {
    await removeUsers(partial);
  }
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, partialId));
  expect(rows).toHaveLength(0);
});
