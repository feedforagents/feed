/** PRD §12 / MVP Phase 5: existing profile and following-list count parity. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  db,
  eq,
  followStatuses,
  follows,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { actors } from '../../pack-default/src/actors-index';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const owned = {
  users: new Set<string>(),
  follows: new Set<string>(),
  actors: new Set<string>(),
  statuses: new Set<string>(),
};
const fixtures = new Map<string, { id: string; username: string }>();
const profileSchema = z.object({
  user: z.object({
    id: z.string(),
    username: z.string(),
    walletAddress: z.string().nullable(),
    twitterUsername: z.string().nullable(),
    stats: z.object({ following: z.number(), followers: z.number() }),
  }),
});
const followingSchema = z.object({
  following: z.array(z.object({ id: z.string(), isActor: z.boolean() })),
  count: z.number(),
  hasMore: z.boolean(),
});
let token = '';

function fixture(label: string) {
  const value = fixtures.get(label);
  assert.ok(value, `Missing fixture ${label}`);
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
async function request(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  return response;
}
async function profile(
  label: string,
  lookup: 'username' | 'id',
  headers: Record<string, string> = {}
) {
  const target = fixture(label);
  const path =
    lookup === 'username'
      ? `/api/users/by-username/${target.username}`
      : `/api/users/${target.id}/profile`;
  const response = await request(path, headers);
  const { user } = profileSchema.parse(await response.json());
  expect(user.id).toBe(target.id);
  return user;
}
async function following(label: string, page = 1, limit = 50) {
  const response = await request(
    `/api/users/${fixture(label).id}/following?limit=${limit}&page=${page}`
  );
  return followingSchema.parse(await response.json());
}

beforeAll(async () => {
  assert.ok(actors.length >= 3, 'Three real registry actors are required');
  const runId = await generateSnowflakeId();
  const labels = [
    'mixed',
    'actoronly',
    'humanonly',
    'zero',
    'h1',
    'h2',
    'h3',
    'incoming',
  ];
  for (const label of labels)
    fixtures.set(label, {
      id: await generateSnowflakeId(),
      username: `p1671_${label}_${runId.slice(-10)}`,
    });
  const now = new Date();
  await insertUsers(
    labels.map((label) => ({
      ...fixture(label),
      displayName: `Following fixture ${label}`,
      stewardId: `pr1671-${fixture(label).id}`,
      walletAddress: label === 'mixed' ? `0x${runId.padStart(40, '0')}` : null,
      twitterUsername: label === 'mixed' ? 'synthetic_pr1671' : null,
      showWalletPublic: false,
      showTwitterPublic: false,
      updatedAt: now,
    }))
  );
  const humanRows = [
    ...['mixed', 'humanonly'].flatMap((label) =>
      ['h1', 'h2', 'h3'].map((human, index) => ({
        id: `${runId}-${label}-${human}`,
        followerId: fixture(label).id,
        followingId: fixture(human).id,
        createdAt: new Date(now.getTime() - index * 1000),
      }))
    ),
    {
      id: `${runId}-incoming`,
      followerId: fixture('incoming').id,
      followingId: fixture('mixed').id,
      createdAt: now,
    },
  ];
  const insertedFollows = await db
    .insert(follows)
    .values(humanRows)
    .returning({ id: follows.id });
  for (const row of insertedFollows) owned.follows.add(row.id);
  const insertedActors = await db
    .insert(userActorFollows)
    .values(
      ['mixed', 'actoronly'].flatMap((label) =>
        actors.slice(0, 2).map((actor, index) => ({
          id: `${runId}-${label}-${actor.id}`,
          userId: fixture(label).id,
          actorId: actor.id,
          createdAt: new Date(now.getTime() - (index + 3) * 1000),
        }))
      )
    )
    .returning({ id: userActorFollows.id });
  for (const row of insertedActors) owned.actors.add(row.id);
  const insertedStatuses = await db
    .insert(followStatuses)
    .values({
      id: `${runId}-npc-incoming`,
      userId: fixture('mixed').id,
      npcId: actors[2]!.id,
      isActive: true,
      followReason: 'quality reply streak',
      followedAt: now,
    })
    .returning({ id: followStatuses.id });
  for (const row of insertedStatuses) owned.statuses.add(row.id);
  token = await createStewardTestToken(`pr1671-${fixture('mixed').id}`);
});

afterAll(async () => {
  if (owned.statuses.size)
    await db
      .delete(followStatuses)
      .where(inArray(followStatuses.id, [...owned.statuses]));
  if (owned.actors.size)
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, [...owned.actors]));
  if (owned.follows.size)
    await db.delete(follows).where(inArray(follows.id, [...owned.follows]));
  await removeUsers(owned.users);
});

for (const [label, expected] of [
  ['mixed', 5],
  ['actoronly', 2],
  ['humanonly', 3],
  ['zero', 0],
] as const) {
  test(`${label}: username, by-id and following list agree`, async () => {
    const byUsername = await profile(label, 'username');
    const byId = await profile(label, 'id');
    const list = await following(label);
    expect(byUsername.stats.following).toBe(expected);
    expect(byId.stats.following).toBe(expected);
    expect(list.count).toBe(expected);
    expect(list.following).toHaveLength(expected);
    expect(list.hasMore).toBe(false);
  });
}
test('following pages retain the complete mixed total and exact relation identities', async () => {
  const found: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const body = await following('mixed', page, 2);
    expect(body.count).toBe(5);
    expect(body.hasMore).toBe(page < 3);
    found.push(...body.following.map((row) => row.id));
  }
  expect(found.sort()).toEqual(
    [
      ...['h1', 'h2', 'h3'].map((label) => fixture(label).id),
      ...actors.slice(0, 2).map((actor) => actor.id),
    ].sort()
  );
});
test('public, signed and cookie profile reads retain NPC followers and linked-identity privacy', async () => {
  for (const headers of [
    {},
    { authorization: `Bearer ${token}` },
    { cookie: `steward-token=${token}` },
  ] as Array<Record<string, string>>) {
    for (const lookup of ['username', 'id'] as const) {
      const user = await profile('mixed', lookup, headers);
      expect(user.stats.following).toBe(5);
      expect(user.stats.followers).toBe(2);
      expect(user.walletAddress).toBeNull();
      expect(user.twitterUsername).toBeNull();
    }
  }
  const response = await request(
    `/api/users/by-username/${fixture('mixed').username.toUpperCase()}`
  );
  expect(profileSchema.parse(await response.json()).user.id).toBe(
    fixture('mixed').id
  );
});
test('a failed insert never gives cleanup ownership of an existing fixture', async () => {
  const partial = new Set<string>();
  const failed = new Set<string>();
  const id = await generateSnowflakeId();
  try {
    await insertUsers(
      [{ id, username: `partial_${id.slice(-12)}`, updatedAt: new Date() }],
      partial
    );
    await expect(
      insertUsers(
        [
          {
            id: fixture('mixed').id,
            username: `collision_${id.slice(-12)}`,
            updatedAt: new Date(),
          },
        ],
        failed
      )
    ).rejects.toThrow();
    expect(partial.size).toBe(1);
    expect(failed.size).toBe(0);
    await removeUsers(failed);
    const [existing] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, fixture('mixed').id));
    expect(existing?.username).toBe(fixture('mixed').username);
  } finally {
    await removeUsers(partial);
  }
  const remaining = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id));
  expect(remaining).toHaveLength(0);
});
