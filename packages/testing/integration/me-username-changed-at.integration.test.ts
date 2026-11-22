/** PRD §§7.1/12 / MVP Phase 5: retain the existing profile cooldown record. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const databaseUrl = process.env.DATABASE_URL ?? '';
const database = new URL(databaseUrl);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseUrl ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(base);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});

type Receipt = { id: string; canonical: string };
const owned: Receipt[] = [];
const dependents: Receipt[] = [];
const tokens: string[] = [];
const changedAt = new Date(Date.now() - 2 * 60 * 60_000);
const nonce = randomUUID();
const schema = z.object({
  authenticated: z.boolean(),
  needsOnboarding: z.boolean(),
  user: z.object({
    id: z.string(),
    username: z.string().nullable(),
    usernameChangedAt: z.string().nullable().optional(),
  }),
});
function acquired(index: number): Receipt {
  const receipt = owned[index];
  if (!receipt) throw new Error('Missing acquired profile receipt');
  return receipt;
}
async function cleanup() {
  if (!owned.length) return;
  await control.begin(async (tx) => {
    for (const row of [...owned].sort((a, b) => a.id.localeCompare(b.id)))
      await tx.unsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [row.id]);
    for (const row of owned) {
      const deleted = await tx.unsafe<{ id: string }[]>(
        `DELETE FROM "User" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb
        AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id)
        AND NOT EXISTS(SELECT 1 FROM "AdminRole" WHERE "userId"=t.id OR "grantedBy"=t.id)
        RETURNING id`,
        [row.id, row.canonical]
      );
      if (deleted.length !== 1)
        throw new Error('Owned profile cleanup refused');
    }
  });
  owned.length = 0;
}
async function releaseDependents() {
  for (const row of dependents) {
    const removed =
      await control`DELETE FROM "GameOnboarding" t WHERE id=${row.id} AND to_jsonb(t)=${row.canonical}::text::jsonb RETURNING id`;
    if (removed.length !== 1)
      throw new Error('Owned onboarding cleanup refused');
  }
  dependents.length = 0;
}
async function rows() {
  const result: Receipt[] = [];
  for (const row of owned) {
    const [current] = await control<
      Receipt[]
    >`SELECT id,to_jsonb(t)::text AS canonical FROM "User" t WHERE id=${row.id}`;
    if (!current) throw new Error('Owned profile missing');
    result.push(current);
  }
  return result;
}
async function request(index: number, auth?: string) {
  const token = auth ?? tokens[index];
  if (token === undefined) throw new Error('Missing fixture token');
  return fetch(`${base}/api/users/me`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function me(index: number) {
  const response = await request(index);
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}
beforeAll(async () => {
  const [identity] = await control<
    { name: string; role: string; port: number; primary: boolean }[]
  >`SELECT current_database() AS name,current_user AS role,inet_server_port() AS port,NOT pg_is_in_recovery() AS primary`;
  if (
    !identity ||
    identity.name !== database.pathname.slice(1) ||
    identity.role !== database.username ||
    identity.port !== Number(port) ||
    !identity.primary
  )
    throw new Error('Disposable database identity mismatch');
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    for (let index = 0; index < 2; index++) {
      const id = await generateSnowflakeId();
      const result = await tx.unsafe<Receipt[]>(
        'INSERT INTO "User"(id,username,"stewardId","displayName",bio,"profileImageUrl","profileComplete","hasUsername","hasBio","hasProfileImage","usernameChangedAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,true,true,true,true,$7::text::timestamp,now()) RETURNING id,to_jsonb("User")::text AS canonical',
        [
          id,
          `p1768_${id}`,
          `${nonce}-${index}`,
          'Owned profile',
          'Fixture bio',
          'https://example.com/avatar.png',
          index === 0 ? changedAt.toISOString() : null,
        ]
      );
      if (result.length !== 1) throw new Error('Incomplete User RETURNING');
      pending.push(...result);
    }
  });
  owned.push(...pending);
  for (let index = 0; index < 2; index++)
    tokens.push(await createStewardTestToken(`${nonce}-${index}`));
});
afterAll(async () => {
  try {
    await releaseDependents();
    await cleanup();
  } finally {
    tokens.length = 0;
    await control.end({ timeout: 5 });
  }
}, 15000);

describe('GET /api/users/me usernameChangedAt', () => {
  it('returns the recorded last username change time', async () => {
    const result = await me(0);
    expect(result.user.id).toBe(acquired(0).id);
    expect(result.user.usernameChangedAt).toBe(changedAt.toISOString());
  });
  it('returns null for a user who never changed their username', async () => {
    const result = await me(1);
    expect(result.user.id).toBe(acquired(1).id);
    expect(result.user.usernameChangedAt).toBeNull();
  });
  it('keeps profile payload and account selection intact across authenticated requests', async () => {
    for (const index of [0, 1, 0]) {
      const result = await me(index);
      expect(result.authenticated).toBe(true);
      expect(result.needsOnboarding).toBe(false);
      expect(result.user.id).toBe(acquired(index).id);
      expect(result.user.username).toBe(`p1768_${acquired(index).id}`);
    }
  });
  it('refuses missing and invalid authentication without changing the owned profiles', async () => {
    const before = await rows();
    for (const auth of ['', 'invalid-fixture-token']) {
      const response = await request(0, auth);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(await rows()).toEqual(before);
  });
  it('never adopts failed setup and refuses foreign cascading children atomically', async () => {
    const first = owned[0];
    if (!first) throw new Error('Missing acquired owner');
    const before = await rows();
    const planned = await generateSnowflakeId();
    await expect(
      control.begin(async (tx) => {
        await tx.unsafe(
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [planned, `p1768_${planned}`]
        );
        await tx.unsafe(
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [first.id, `p1768_collision_${planned}`]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    expect(
      await control`SELECT id FROM "User" WHERE id=${planned}`
    ).toHaveLength(0);
    expect(await rows()).toEqual(before);
    const acquired = await control<
      Receipt[]
    >`INSERT INTO "GameOnboarding"(id,"userId") VALUES(${await generateSnowflakeId()},${first.id}) RETURNING id,to_jsonb("GameOnboarding")::text AS canonical`;
    dependents.push(...acquired);
    expect(acquired).toHaveLength(1);
    try {
      await expect(cleanup()).rejects.toThrow('Owned profile cleanup refused');
      expect(await rows()).toEqual(before);
    } finally {
      await releaseDependents();
    }
  });
});
