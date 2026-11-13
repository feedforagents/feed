/** PRD §12 / MVP Phase 5.7: existing public discovery, not a new registry. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { dbWrite, gameOnboarding, sql, users, withTransaction } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

type Receipt = { table: 'User' | 'GameOnboarding'; id: string; row: string };
const acquired: Receipt[] = [];
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const schema = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      username: z.string().nullable(),
      isActor: z.boolean(),
      isBanned: z.boolean(),
      isTest: z.boolean().optional(),
    })
  ),
  actors: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  totals: z.object({ users: z.number().int().nonnegative() }),
});
let searchTerm = '';
let crowdedTerm = '';
let ip = '';
let normalId = '';
let testFlaggedId = '';
let testPrefixedId = '';
let bannedId = '';
let actorId = '';
let crowdedNormalId = '';
const crowdedExcludedIds: string[] = [];

function guardDisposableTarget() {
  const value = process.env.DATABASE_URL || '';
  if (!URL.canParse(value) || !URL.canParse(base))
    throw new Error('Explicit disposable autocomplete targets required');
  const database = new URL(value);
  const local =
    database.hostname === '127.0.0.1' &&
    database.port === '55685' &&
    database.username === 'symbiex' &&
    /^\/feed_pr1706\d+$/.test(database.pathname);
  const ci =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    ['127.0.0.1', 'localhost'].includes(database.hostname) &&
    database.port === '5432' &&
    database.username === 'postgres' &&
    database.pathname === '/test_db';
  if (
    database.protocol !== 'postgresql:' ||
    database.search ||
    database.hash ||
    !(local || ci) ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== value) ||
    process.env.DATABASE_READ_REPLICA_URL ||
    process.env.POSTGRES_URL
  )
    throw new Error(
      'Autocomplete fixtures require a disposable local or documented CI database'
    );
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
    throw new Error('Autocomplete HTTP target must be loopback');
  for (const target of [process.env.TEST_BASE_URL, process.env.TEST_API_URL]) {
    if (
      target &&
      (!URL.canParse(target) || new URL(target).origin !== endpoint.origin)
    )
      throw new Error('Autocomplete HTTP targets must agree');
  }
}
function remember(
  table: Receipt['table'],
  rows: Array<{ id: string; row: string }>,
  into = acquired
) {
  for (const row of rows) into.push({ table, ...row });
  return rows;
}
async function acquireUsers(
  rows: Array<typeof users.$inferInsert>,
  into = acquired
) {
  const result = remember(
    'User',
    await dbWrite.insert(users).values(rows).returning({
      id: users.id,
      row: sql<string>`to_jsonb("User")::text`,
    }),
    into
  );
  expect(result).toHaveLength(rows.length);
  return result;
}
async function readReceipt(row: Receipt) {
  return Array.from(
    await dbWrite.execute<{ row: string }>(sql`
    SELECT to_jsonb(t)::text AS row FROM ${sql.identifier(row.table)} t WHERE id=${row.id}`)
  );
}
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await withTransaction(async (tx) => {
    // Lock parents before child deletion: physical FK insertions cannot race it.
    for (const row of rows
      .filter((r) => r.table === 'User')
      .sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const locked = await tx.execute<{ row: string }>(sql`
        SELECT to_jsonb(t)::text AS row FROM "User" t WHERE id=${row.id} FOR UPDATE`);
      if (locked.length !== 1 || locked[0]?.row !== row.row)
        throw new Error('Retain changed autocomplete User');
    }
    for (const table of ['GameOnboarding', 'User'] as const) {
      for (const row of rows.filter((r) => r.table === table)) {
        const noForeignChildren =
          table === 'User'
            ? sql`
          NOT EXISTS(SELECT 1 FROM "AdminRole" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
          NOT EXISTS(SELECT 1 FROM "GameOnboarding" c WHERE c."userId"=t.id) AND
          NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" c WHERE c."userId"=t.id) AND
          NOT EXISTS(SELECT 1 FROM "Whitelist" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
          NOT EXISTS(SELECT 1 FROM "WhitelistConfig" c WHERE c."updatedBy"=t.id)`
            : sql`true`;
        const removed = await tx.execute<{ id: string }>(sql`
          DELETE FROM ${sql.identifier(table)} t WHERE t.id=${row.id}
          AND to_jsonb(t)=${row.row}::text::jsonb AND ${noForeignChildren} RETURNING t.id`);
        if (removed.length !== 1 || removed[0]?.id !== row.id)
          throw new Error(`Retain changed or referenced autocomplete ${table}`);
      }
    }
  });
  for (const row of rows) expect(await readReceipt(row)).toEqual([]);
  rows.length = 0;
}
async function fetchRegistry(
  search: string,
  autocomplete = false,
  type = 'users'
) {
  const params = new URLSearchParams({ search, type });
  if (autocomplete) params.set('autocomplete', 'true');
  const response = await fetch(`${base}/api/registry/all?${params}`, {
    headers: { 'x-forwarded-for': ip },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  expect(response.status).toBe(200);
  return schema.parse(await response.json());
}
async function rejectUserCollision(
  operation: () => Promise<Array<{ id: string; row: string }>>
) {
  try {
    await operation();
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === 'User_pkey'
    )
      return;
    throw error;
  }
  throw new Error('Expected the real User primary-key collision');
}

beforeAll(async () => {
  guardDisposableTarget();
  const run = await generateSnowflakeId();
  searchTerm = `g31${run}`;
  crowdedTerm = `g32${run}`;
  const groups = BigInt(run).toString(16).padStart(16, '0').match(/.{4}/g);
  if (!groups) throw new Error('Autocomplete fixture IP allocation failed');
  ip = `2001:db8:1706:0:${groups.join(':')}`;
  const now = new Date();
  normalId = await generateSnowflakeId();
  testFlaggedId = await generateSnowflakeId();
  testPrefixedId = `test-g31-${await generateSnowflakeId()}`;
  bannedId = await generateSnowflakeId();
  actorId = await generateSnowflakeId();
  crowdedNormalId = await generateSnowflakeId();
  const rows: Array<typeof users.$inferInsert> = [
    { id: normalId, username: `${searchTerm}real`, updatedAt: now },
    {
      id: testFlaggedId,
      username: `${searchTerm}flag`,
      isTest: true,
      updatedAt: now,
    },
    { id: testPrefixedId, username: `${searchTerm}pref`, updatedAt: now },
    {
      id: bannedId,
      username: `${searchTerm}ban`,
      isBanned: true,
      updatedAt: now,
    },
    {
      id: actorId,
      username: `${searchTerm}actor`,
      isActor: true,
      updatedAt: now,
    },
    {
      id: crowdedNormalId,
      username: `${crowdedTerm}real`,
      createdAt: new Date(now.getTime() - 60000),
      updatedAt: now,
    },
  ];
  for (let index = 0; index < 104; index++) {
    const id = `${index % 4 === 1 ? 'test-' : ''}${await generateSnowflakeId()}`;
    crowdedExcludedIds.push(id);
    rows.push({
      id,
      username: `${crowdedTerm}_${index}`,
      createdAt: now,
      updatedAt: now,
      isTest: index % 4 === 0,
      isBanned: index % 4 === 2,
      isActor: index % 4 === 3,
    });
  }
  await acquireUsers(rows);
}, 30000);
afterAll(async () => {
  await cleanup(acquired);
}, 30000);

describe('GET /api/registry/all — explore autocomplete membership data', () => {
  it('returns every fixture user for the admin registry panel (no route-level filtering)', async () => {
    const body = await fetchRegistry(searchTerm);
    expect(new Set(body.users.map((u) => u.id))).toEqual(
      new Set([normalId, testFlaggedId, testPrefixedId, bannedId, actorId])
    );
  });
  it('exposes the isTest flag so the autocomplete can drop test accounts', async () => {
    const byId = new Map(
      (await fetchRegistry(searchTerm)).users.map((u) => [u.id, u])
    );
    expect(byId.get(testFlaggedId)?.isTest).toBe(true);
    expect(byId.get(normalId)?.isTest).toBe(false);
    expect(byId.get(bannedId)?.isTest).toBe(false);
  });
  it('exposes the isBanned flag used by the autocomplete filter', async () => {
    const byId = new Map(
      (await fetchRegistry(searchTerm)).users.map((u) => [u.id, u])
    );
    expect(byId.get(bannedId)?.isBanned).toBe(true);
    expect(byId.get(normalId)?.isBanned).toBe(false);
  });
  it('filters all four excluded user kinds only in autocomplete mode', async () => {
    const body = await fetchRegistry(searchTerm, true);
    expect(body.users.map((u) => u.id)).toEqual([normalId]);
    expect(body.totals.users).toBe(1);
  });
  it('keeps the older eligible match beyond one hundred newer excluded matches', async () => {
    const registry = await fetchRegistry(crowdedTerm);
    expect(registry.users).toHaveLength(100);
    expect(registry.users.every((u) => crowdedExcludedIds.includes(u.id))).toBe(
      true
    );
    expect(registry.users.map((u) => u.id)).not.toContain(crowdedNormalId);
    const discovery = await fetchRegistry(crowdedTerm, true);
    expect(discovery.users.map((u) => u.id)).toEqual([crowdedNormalId]);
    expect(discovery.totals.users).toBe(1);
  });
  it('preserves static actor results and the existing users search actor contract', async () => {
    const actors = await fetchRegistry('', false, 'actors');
    const discovery = await fetchRegistry('', true, 'actors');
    expect(actors.actors.length).toBeGreaterThan(0);
    expect(discovery.actors).toEqual(actors.actors);
    const actor = actors.actors[0];
    if (!actor) throw new Error('Missing actual static actor control');
    const usersSearch = await fetchRegistry(actor.name, true);
    expect(usersSearch.actors.map((a) => a.id)).toContain(actor.id);
  });
  it('registers only successful RETURNING rows and retains the real collision owner', async () => {
    const partial: Receipt[] = [];
    const rejected: Receipt[] = [];
    const existing = acquired.find((row) => row.id === normalId);
    if (!existing) throw new Error('Missing acquired collision control');
    const laterId = await generateSnowflakeId();
    try {
      await acquireUsers(
        [{ id: await generateSnowflakeId(), updatedAt: new Date() }],
        partial
      );
      await rejectUserCollision(() =>
        acquireUsers(
          [
            { id: laterId, updatedAt: new Date() },
            { id: normalId, updatedAt: new Date() },
          ],
          rejected
        )
      );
      expect(rejected).toEqual([]);
      expect(
        await readReceipt({ table: 'User', id: laterId, row: '' })
      ).toEqual([]);
      expect(await readReceipt(existing)).toEqual([{ row: existing.row }]);
    } finally {
      await cleanup(partial);
    }
    expect(await readReceipt(existing)).toEqual([{ row: existing.row }]);
  });
  it('refuses foreign FK activity and mismatched physical receipts before cleaning only acquired rows', async () => {
    const parents: Receipt[] = [];
    const controls: Receipt[] = [];
    try {
      const inserted = await acquireUsers(
        [{ id: await generateSnowflakeId(), updatedAt: new Date() }],
        parents
      );
      const parent = inserted[0];
      if (!parent) throw new Error('Missing acquired foreign-reference parent');
      const returned = remember(
        'GameOnboarding',
        await dbWrite
          .insert(gameOnboarding)
          .values({
            id: await generateSnowflakeId(),
            userId: parent.id,
          })
          .returning({
            id: gameOnboarding.id,
            row: sql<string>`to_jsonb("GameOnboarding")::text`,
          }),
        controls
      );
      expect(returned).toHaveLength(1);
      const child = controls[0];
      const parentReceipt = parents[0];
      if (!child || !parentReceipt)
        throw new Error('Missing acquired FK controls');
      await expect(cleanup(parents)).rejects.toThrow(
        'Retain changed or referenced autocomplete User'
      );
      expect(await readReceipt(parentReceipt)).toEqual([
        { row: parentReceipt.row },
      ]);
      expect(await readReceipt(child)).toEqual([{ row: child.row }]);
      await cleanup(controls);
      const falseReceipt = [{ ...parentReceipt, row: '{}' }];
      await expect(cleanup(falseReceipt)).rejects.toThrow(
        'Retain changed autocomplete User'
      );
      expect(await readReceipt(parentReceipt)).toEqual([
        { row: parentReceipt.row },
      ]);
    } finally {
      await cleanup(controls);
      await cleanup(parents);
    }
  });
});
