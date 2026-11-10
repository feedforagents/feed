/** PRD §§8.1/8.2/9.5/12, MVP phases3/5: retained NPC/viewer follow reads. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  actorFollows,
  actorState,
  and,
  db,
  eq,
  follows,
  inArray,
  or,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const endpoint = new URL(base);
if (
  endpoint.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Owned loopback HTTP server required');
const entrySchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    isActor: z.boolean(),
    followedAt: z.string(),
    viewerFollows: z.boolean().optional(),
  })
  .passthrough();
const followingSchema = z.object({
  following: z.array(entrySchema),
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
const followersSchema = z.object({
  followers: z.array(entrySchema),
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
const owned = {
  users: new Set<string>(),
  actorFollows: new Set<string>(),
  userActorFollows: new Set<string>(),
  follows: new Set<string>(),
};
const identities = new Map<string, string>(),
  tokens = new Map<string, string>();
let npcId = '',
  npcUsername = '',
  clientIp = '',
  canonicalUsersBefore = '',
  actorStateBefore = '',
  graphBefore = '';
let actorIds: string[] = [],
  validExistingCount = 0;
let apiActorWriteAttempted = false;
function value(map: Map<string, string>, key: string): string {
  const result = map.get(key);
  if (!result) throw new Error('Missing owned fixture ' + key);
  return result;
}
const user = (key: string) => value(identities, key);
function actor(index: number): string {
  const result = actorIds[index];
  if (!result) throw new Error('Missing registry fixture');
  return result;
}
function digest(rows: object[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function canonicalUsersDigest() {
  return digest(
    await db
      .select()
      .from(users)
      .where(eq(users.isActor, true))
      .orderBy(users.id)
  );
}
async function actorStateDigest() {
  return digest(await db.select().from(actorState).orderBy(actorState.id));
}
async function canonicalGraphDigest() {
  return digest(
    await db
      .select()
      .from(actorFollows)
      .where(
        or(
          eq(actorFollows.followerId, npcId),
          eq(actorFollows.followingId, npcId)
        )
      )
      .orderBy(actorFollows.id)
  );
}
function auth(viewer?: string, cookie = false): Record<string, string> {
  if (!viewer) return {};
  const token = value(tokens, viewer);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}
async function request(
  path: string,
  viewer?: string,
  method = 'GET',
  cookie = false,
  extraHeaders: Record<string, string> = {}
) {
  return fetch(new URL(path, base), {
    method,
    headers: {
      'x-forwarded-for': clientIp,
      ...auth(viewer, cookie),
      ...extraHeaders,
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}
async function following(
  target = npcId,
  query = '?limit=100',
  viewer?: string,
  cookie = false
) {
  const response = await request(
    `/api/users/${encodeURIComponent(target)}/following${query}`,
    viewer,
    'GET',
    cookie
  );
  expect(response.status).toBe(200);
  return followingSchema.parse(await response.json());
}
async function insertUser(label: string, isActor = false) {
  const id = await generateSnowflakeId(),
    stewardId = `p1691-${id}`;
  const rows = await db
    .insert(users)
    .values({
      id,
      username: `p1691_${id}`,
      displayName: label,
      stewardId,
      isActor,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  expect(rows).toHaveLength(1);
  for (const row of rows) owned.users.add(row.id);
  identities.set(label, id);
  tokens.set(label, await createStewardTestToken(stewardId));
  return id;
}
async function insertActorFollow(
  followerId: string,
  followingId: string,
  createdAt: Date
) {
  const rows = await db
    .insert(actorFollows)
    .values({
      id: await generateSnowflakeId(),
      followerId,
      followingId,
      createdAt,
    })
    .returning({ id: actorFollows.id });
  expect(rows).toHaveLength(1);
  for (const row of rows) owned.actorFollows.add(row.id);
}
async function insertActorRelation(
  userId: string,
  actorId: string,
  createdAt: Date
) {
  const rows = await db
    .insert(userActorFollows)
    .values({ id: await generateSnowflakeId(), userId, actorId, createdAt })
    .returning({ id: userActorFollows.id });
  expect(rows).toHaveLength(1);
  for (const row of rows) owned.userActorFollows.add(row.id);
}
async function insertHumanFollow(followerId: string, followingId: string) {
  const rows = await db
    .insert(follows)
    .values({
      id: await generateSnowflakeId(),
      followerId,
      followingId,
      createdAt: new Date(),
    })
    .returning({ id: follows.id });
  expect(rows).toHaveLength(1);
  for (const row of rows) owned.follows.add(row.id);
}

beforeAll(async () => {
  canonicalUsersBefore = await canonicalUsersDigest();
  actorStateBefore = await actorStateDigest();
  const registry = StaticDataRegistry.getAllActors().filter(
      (entry) => !entry.id.startsWith('test-')
    ),
    target = registry[0];
  if (!target || registry.length < 6 || !target.username)
    throw new Error('Insufficient registry actors');
  npcId = target.id;
  npcUsername = target.username;
  actorIds = registry.slice(1, 6).map((entry) => entry.id);
  const run = await generateSnowflakeId();
  clientIp = `198.18.${Number(run.slice(-4, -2))}.${Number(run.slice(-2)) + 1}`;
  graphBefore = await canonicalGraphDigest();
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, npcId));
  if (existingUser) expect(existingUser.isActor).toBe(true);
  else {
    const rows = await db
      .insert(users)
      .values({
        id: npcId,
        username: npcId,
        displayName: target.name,
        isActor: true,
        updatedAt: new Date(),
      })
      .returning({ id: users.id });
    expect(rows).toHaveLength(1);
    for (const row of rows) owned.users.add(row.id);
  }
  const existing = await db
    .select()
    .from(actorFollows)
    .where(eq(actorFollows.followerId, npcId));
  validExistingCount = existing.filter((row) =>
    StaticDataRegistry.getActor(row.followingId)
  ).length;
  const incomingNpc = await db
    .select({ createdAt: actorFollows.createdAt })
    .from(actorFollows)
    .where(eq(actorFollows.followingId, npcId));
  const incomingUsers = await db
    .select({ createdAt: userActorFollows.createdAt })
    .from(userActorFollows)
    .where(eq(userActorFollows.actorId, npcId));
  const newest = [...existing, ...incomingNpc, ...incomingUsers].reduce(
    (latest, row) => Math.max(latest, row.createdAt.getTime()),
    Date.now()
  );
  for (let index = 0; index < 3; index++)
    await insertActorFollow(
      npcId,
      actor(index),
      new Date(newest + 10000 - index * 1000)
    );
  await insertActorFollow(
    npcId,
    `p1691-unregistered-${run}`,
    new Date(newest + 11000)
  );
  await insertActorFollow(actor(3), npcId, new Date(newest + 12000));
  for (const label of ['viewer', 'other', 'human', 'friend'])
    await insertUser(label);
  await insertUser('unregistered', true);
  await insertActorRelation(user('viewer'), actor(0), new Date(newest + 13000));
  await insertActorRelation(user('other'), actor(1), new Date(newest + 13000));
  await insertActorRelation(user('viewer'), npcId, new Date(newest + 13000));
  await insertActorRelation(user('human'), actor(1), new Date());
  await insertActorRelation(user('unregistered'), actor(2), new Date());
  await insertHumanFollow(user('human'), user('friend'));
  await insertHumanFollow(user('unregistered'), user('friend'));
});
afterAll(async () => {
  if (apiActorWriteAttempted) {
    // The API write is confined to this successfully inserted fresh viewer.
    // Capture its persisted ID even if the HTTP response/assertion failed.
    expect(owned.users.has(user('viewer'))).toBe(true);
    const rows = await db
      .select({ id: userActorFollows.id })
      .from(userActorFollows)
      .where(
        and(
          eq(userActorFollows.userId, user('viewer')),
          eq(userActorFollows.actorId, actor(0))
        )
      );
    for (const row of rows) owned.userActorFollows.add(row.id);
  }
  for (const [table, ids] of [
    [actorFollows, owned.actorFollows],
    [userActorFollows, owned.userActorFollows],
    [follows, owned.follows],
  ] as const) {
    if (ids.size) {
      await db.delete(table).where(inArray(table.id, [...ids]));
      expect(
        await db
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, [...ids]))
      ).toHaveLength(0);
    }
  }
  if (owned.users.size) {
    await db.delete(users).where(inArray(users.id, [...owned.users]));
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [...owned.users]))
    ).toHaveLength(0);
  }
  if (canonicalUsersBefore)
    expect(await canonicalUsersDigest()).toBe(canonicalUsersBefore);
  if (actorStateBefore) expect(await actorStateDigest()).toBe(actorStateBefore);
  if (graphBefore) expect(await canonicalGraphDigest()).toBe(graphBefore);
  console.log(
    'PR1691_OWNED_CLEANUP',
    JSON.stringify({
      remaining: 0,
      canonicalUsersUnchanged: true,
      actorStateUnchanged: true,
      preexistingGraphUnchanged: true,
    })
  );
});

describe('normal NPC follow reads with safe real HTTP fixtures', () => {
  it('routes canonical User-present IDs and registry usernames to the same NPC graph', async () => {
    const byId = await following(),
      byUsername = await following(npcUsername);
    expect(byId.count).toBe(validExistingCount + 3);
    expect(byUsername.count).toBe(byId.count);
    expect(byId.following.slice(0, 3).map((entry) => entry.id)).toEqual(
      actorIds.slice(0, 3)
    );
    expect(byUsername.following.slice(0, 3).map((entry) => entry.id)).toEqual(
      actorIds.slice(0, 3)
    );
    expect(byId.following.every((entry) => entry.isActor)).toBe(true);
  });
  it('filters unknown actors before paging and keeps count and empty-page boundaries', async () => {
    const first = await following(npcId, '?page=1&limit=2'),
      second = await following(npcId, '?page=2&limit=2'),
      beyond = await following(
        npcId,
        `?page=${validExistingCount + 5}&limit=2`
      );
    expect(first.following.map((entry) => entry.id)).toEqual(
      actorIds.slice(0, 2)
    );
    expect(first.count).toBe(validExistingCount + 3);
    expect(first.hasMore).toBe(true);
    expect(second.following[0]?.id).toBe(actor(2));
    expect(second.count).toBe(first.count);
    expect(beyond.following).toHaveLength(0);
    expect(beyond.count).toBe(first.count);
    expect(beyond.hasMore).toBe(false);
  });
  it('returns page-bounded viewer state with normal Bearer/cookie caller isolation', async () => {
    const viewer = await following(
        npcId,
        `?limit=2&userId=${user('other')}`,
        'viewer'
      ),
      other = await following(npcId, '?limit=2', 'other', true);
    expect(viewer.following.map((entry) => entry.viewerFollows)).toEqual([
      true,
      false,
    ]);
    expect(other.following.map((entry) => entry.viewerFollows)).toEqual([
      false,
      true,
    ]);
    const empty = await following(
      npcId,
      `?page=${validExistingCount + 5}&limit=2`,
      'viewer'
    );
    expect(empty.following).toHaveLength(0);
  });
  it('ordinary authenticated unfollow/follow changes only that viewer state', async () => {
    const graph = await canonicalGraphDigest(),
      path = `/api/users/${encodeURIComponent(actor(0))}/follow`;
    let response = await request(path, 'viewer');
    expect(response.status).toBe(200);
    expect(
      z.object({ isFollowing: z.boolean() }).parse(await response.json())
        .isFollowing
    ).toBe(true);
    response = await request(path, 'viewer', 'DELETE');
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(
      (await following(npcId, '?limit=2', 'viewer')).following[0]?.viewerFollows
    ).toBe(false);
    expect(
      (await following(npcId, '?limit=2', 'other')).following[1]?.viewerFollows
    ).toBe(true);
    apiActorWriteAttempted = true;
    response = await request(path, 'viewer', 'POST');
    const body = z.object({ id: z.string() }).parse(await response.json());
    const rows = await db
      .select()
      .from(userActorFollows)
      .where(
        and(
          eq(userActorFollows.id, body.id),
          eq(userActorFollows.userId, user('viewer')),
          eq(userActorFollows.actorId, actor(0))
        )
      );
    expect(rows).toHaveLength(1);
    owned.userActorFollows.add(body.id);
    expect(response.status).toBe(201);
    expect(
      (await following(npcId, '?limit=2', 'viewer')).following[0]?.viewerFollows
    ).toBe(true);
    expect(await canonicalGraphDigest()).toBe(graph);
  });
  it('uses the same canonical NPC metadata for the existing followers dispatcher', async () => {
    const response = await request(
      `/api/users/${encodeURIComponent(npcId)}/followers?limit=100`
    );
    expect(response.status).toBe(200);
    const result = followersSchema.parse(await response.json());
    expect(result.followers.slice(0, 2).map((entry) => entry.id)).toEqual([
      user('viewer'),
      actor(3),
    ]);
    expect(result.followers[0]?.isActor).toBe(false);
    expect(result.followers[1]?.isActor).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
  it('preserves ordinary human mixed follows and viewer enrichment', async () => {
    const result = await following(user('human'), '?limit=100', 'other');
    expect(result.count).toBe(2);
    expect(new Set(result.following.map((entry) => entry.id))).toEqual(
      new Set([user('friend'), actor(1)])
    );
    expect(
      result.following.find((entry) => entry.id === actor(1))?.viewerFollows
    ).toBe(true);
    expect(
      result.following.find((entry) => entry.id === user('friend'))
        ?.viewerFollows
    ).toBe(false);
  });
  it('preserves the User branch for unregistered actor-flagged Users', async () => {
    const result = await following(user('unregistered'));
    expect(result.count).toBe(2);
    expect(new Set(result.following.map((entry) => entry.id))).toEqual(
      new Set([user('friend'), actor(2)])
    );
  });
  it('retains invalid-input, optional-auth and unauthenticated mutation behavior', async () => {
    for (const query of ['?page=0', '?limit=0', '?limit=101']) {
      const response = await request(`/api/users/${npcId}/following${query}`);
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    const missingId = await generateSnowflakeId();
    const missing = await request(`/api/users/${missingId}/following`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    for (const method of ['POST', 'DELETE']) {
      const response = await request(
        `/api/users/${actor(0)}/follow`,
        undefined,
        method
      );
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    const optional = await request(
      `/api/users/${npcId}/following?limit=2`,
      undefined,
      'GET',
      false,
      { authorization: 'Bearer invalid-token' }
    );
    expect(optional.status).toBe(200);
    const result = followingSchema.parse(await optional.json());
    expect(
      result.following.every((entry) => entry.viewerFollows === undefined)
    ).toBe(true);
  });
  it('does not acquire cleanup ownership from a real duplicate-key failure', async () => {
    const snapshot = await db.select().from(users).where(eq(users.id, npcId));
    const partial = await insertUser('partial');
    await insertActorFollow(partial, actor(4), new Date());
    const neverOwned: string[] = [];
    await expect(
      (async () => {
        const rows = await db
          .insert(users)
          .values({
            id: npcId,
            username: `p1691_collision_${partial}`,
            updatedAt: new Date(),
          })
          .returning({ id: users.id });
        neverOwned.push(...rows.map((row) => row.id));
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(neverOwned).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.id, npcId))).toEqual(
      snapshot
    );
  });
});
