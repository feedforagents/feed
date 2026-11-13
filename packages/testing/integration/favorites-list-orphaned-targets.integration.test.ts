/**
 * PRD §12 / MVP Phase 5: an existing favorites-profile list must count and
 * page the surviving profiles. Real HTTP/auth and PostgreSQL are used; no
 * module mocks or environment mutations. Fixtures acquire complete physical
 * tuples and refuse cleanup if foreign references or unexplained drift exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const target = new URL(databaseUrl);
if (
  !['postgres:', 'postgresql:'].includes(target.protocol) ||
  !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname) ||
  !/^\/(test_db|feed_pr\d+)$/.test(target.pathname) ||
  target.search ||
  target.hash ||
  (process.env.DIRECT_DATABASE_URL &&
    process.env.DIRECT_DATABASE_URL !== databaseUrl) ||
  process.env.DATABASE_READ_REPLICA_URL
)
  throw new Error('A disposable loopback primary database is required');
const control = postgres(databaseUrl, { max: 2 });
const base = new URL(
  process.env.TEST_API_URL ||
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3100'
);
if (
  base.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== '/'
) {
  throw new Error('An owned loopback integration server is required');
}

const responseSchema = z.object({
  profiles: z.array(z.object({ id: z.string(), isFavorited: z.literal(true) })),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  limit: z.number().int(),
  pagination: z.object({
    total: z.number().int(),
    totalPages: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  }),
});
type Row = { id: string; canonical: string };
type OwnedRow = Row & { table: 'User' | 'Favorite' };
type DatabaseIdentity = {
  database: string;
  oid: string;
  role: string;
  session: string;
  started: string;
  address: string;
  port: number;
  replica: boolean;
};
type Fixture = {
  rows: OwnedRow[];
  viewerId: string;
  outsiderId: string;
  authorAId: string;
  authorBId: string;
  favoriteIds: string[];
  expectedIds: string[];
};
const fixtures: Fixture[] = [];
let identity: DatabaseIdentity;
let main: Fixture;

const userForeignKeys = `
  AND NOT EXISTS (SELECT 1 FROM public."GameOnboarding" WHERE "userId"=t.id)
  AND NOT EXISTS (SELECT 1 FROM public."UserPnLSnapshot" WHERE "userId"=t.id)
  AND NOT EXISTS (SELECT 1 FROM public."Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id)
  AND NOT EXISTS (SELECT 1 FROM public."WhitelistConfig" WHERE "updatedBy"=t.id)
  AND NOT EXISTS (SELECT 1 FROM public."Post" WHERE "authorId"=t.id)`;

async function currentIdentity(tx: postgres.TransactionSql | typeof control) {
  const [row] = await tx.unsafe<DatabaseIdentity[]>(`
    SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      current_user AS role, session_user AS session, pg_postmaster_start_time()::text AS started,
      host(inet_server_addr()) AS address, inet_server_port() AS port, pg_is_in_recovery() AS replica
  `);
  if (!row) throw new Error('Database identity missing');
  return row;
}
async function verifyIdentity(tx: postgres.TransactionSql) {
  expect(await currentIdentity(tx)).toEqual(identity);
}

async function createFixture(
  liveTargets = 2,
  tied = false,
  collision?: { favoriteId: string; attemptedUsers: string[] }
): Promise<Fixture> {
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const ghostId = randomUUID();
  const targetIds = Array.from({ length: liveTargets }, () => randomUUID());
  const rows: OwnedRow[] = [];
  const favoriteIds: string[] = [];
  const links: { id: string; target: string; time: number }[] = [];
  const now = Date.now() - 60_000;
  await control.begin(async (tx) => {
    await verifyIdentity(tx);
    for (const id of [viewerId, outsiderId, ...targetIds, ghostId]) {
      collision?.attemptedUsers.push(id);
      const [row] = await tx.unsafe<Row[]>(
        'INSERT INTO public."User" (id,username,"stewardId","updatedAt") VALUES ($1,$2,$3,$4) RETURNING id,to_jsonb("User")::text AS canonical',
        [
          id,
          `fav1704_${randomUUID()}`,
          `fav1704-${id}`,
          new Date(now).toISOString(),
        ]
      );
      if (!row) throw new Error('User INSERT did not return ownership');
      rows.push({ ...row, table: 'User' });
    }
    for (const [index, targetId] of [...targetIds, ghostId].entries()) {
      const id = index === 0 && collision ? collision.favoriteId : randomUUID();
      const time =
        targetId === ghostId ? now + 30_000 : tied ? now : now - index * 1000;
      const [row] = await tx.unsafe<Row[]>(
        'INSERT INTO public."Favorite" (id,"userId","targetUserId","createdAt") VALUES ($1,$2,$3,$4) RETURNING id,to_jsonb("Favorite")::text AS canonical',
        [id, viewerId, targetId, new Date(time).toISOString()]
      );
      if (!row) throw new Error('Favorite INSERT did not return ownership');
      rows.push({ ...row, table: 'Favorite' });
      favoriteIds.push(id);
      if (targetId !== ghostId) links.push({ id, target: targetId, time });
    }
    // Reproduce the account-deletion orphan using only the acquired User.
    // Refuse destructive foreign FKs or any Favorite outside this acquisition.
    const ghost = rows.find(
      (row) => row.table === 'User' && row.id === ghostId
    );
    if (!ghost) throw new Error('Ghost User ownership missing');
    const removed = await tx.unsafe<Row[]>(
      `DELETE FROM public."User" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb ${userForeignKeys}
       AND NOT EXISTS (SELECT 1 FROM public."Favorite" WHERE ("userId"=t.id OR "targetUserId"=t.id) AND NOT(id=ANY($3::text[])))
       RETURNING id,to_jsonb(t)::text AS canonical`,
      [ghost.id, ghost.canonical, favoriteIds]
    );
    expect(Array.from(removed)).toEqual([
      { id: ghost.id, canonical: ghost.canonical },
    ]);
    rows.splice(rows.indexOf(ghost), 1);
    const [orphan] = await tx.unsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM public."Favorite" WHERE "targetUserId"=$1',
      [ghostId]
    );
    expect(orphan?.count).toBe(1);
  });
  links.sort(
    (a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
  const fixture = {
    rows,
    viewerId,
    outsiderId,
    authorAId: targetIds[0]!,
    authorBId: targetIds[1]!,
    favoriteIds,
    expectedIds: links.map((link) => link.target),
  };
  fixtures.push(fixture);
  return fixture;
}

async function cleanup(fixture: Fixture) {
  if (!fixture.rows.length) return;
  await control.begin(async (tx) => {
    await verifyIdentity(tx);
    for (const table of ['Favorite', 'User'] as const) {
      for (const row of fixture.rows.filter((row) => row.table === table)) {
        const references =
          table === 'User'
            ? `${userForeignKeys}
          AND NOT EXISTS (SELECT 1 FROM public."Favorite" WHERE "userId"=t.id OR "targetUserId"=t.id)`
            : '';
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM public."${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb ${references} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error(`Owned favorites cleanup refused ${table}`);
      }
    }
  });
  fixture.rows = [];
}
async function snapshot(fixture: Fixture) {
  const rows: OwnedRow[] = [];
  for (const row of fixture.rows) {
    const [current] = await control.unsafe<Row[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM public."${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Owned row missing');
    rows.push({ ...current, table: row.table });
  }
  return rows;
}
async function request(
  query = '',
  userId: string | null = main.viewerId,
  malformed = false
) {
  const token = malformed
    ? 'invalid-favorites-test-token'
    : userId
      ? await createStewardTestToken(`fav1704-${userId}`)
      : null;
  return fetch(new URL(`/api/profiles/favorites${query}`, base), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}
async function fetchFavorites(query = '', userId = main.viewerId) {
  const response = await request(query, userId);
  expect(response.status).toBe(200);
  return {
    status: response.status,
    body: responseSchema.parse(await response.json()),
  };
}

beforeAll(async () => {
  identity = await currentIdentity(control);
  expect(identity.database).toBe(decodeURIComponent(target.pathname.slice(1)));
  expect(identity.role).toBe(decodeURIComponent(target.username));
  expect(identity.session).toBe(identity.role);
  expect(identity.replica).toBe(false);
  main = await createFixture();
});
afterAll(async () => {
  const failures: Error[] = [];
  try {
    for (const fixture of fixtures) {
      try {
        await cleanup(fixture);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  } finally {
    await control.end({ timeout: 5 });
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned favorites fixtures retained after cleanup refusal'
    );
});

describe('GET /api/profiles/favorites with an orphaned favorite', () => {
  it('counts only favorites whose profile still exists', async () => {
    const { status, body } = await fetchFavorites();
    expect(status).toBe(200);
    expect(body.profiles.map((profile) => profile.id).sort()).toEqual(
      [main.authorAId, main.authorBId].sort()
    );
    expect(body.total).toBe(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.totalPages).toBe(1);
  });
  it('pages through exactly the surviving profiles, with no empty page', async () => {
    const seen: string[] = [];
    for (const page of [1, 2]) {
      const { status, body } = await fetchFavorites(`?limit=1&page=${page}`);
      expect(status).toBe(200);
      expect(body.total).toBe(2);
      expect(body.pagination.totalPages).toBe(2);
      expect(body.profiles).toHaveLength(1);
      seen.push(body.profiles[0]!.id);
    }
    expect(seen).toEqual([main.authorAId, main.authorBId]);
  });
  it('walks tied favorites repeatedly in stable order without duplicates', async () => {
    const fixture = await createFixture(17, true);
    for (const limit of [5, 7, 5]) {
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(17 / limit); page++) {
        const { body } = await fetchFavorites(
          `?limit=${limit}&page=${page}`,
          fixture.viewerId
        );
        expect(body.total).toBe(17);
        expect(body.profiles.length).toBe(
          Math.min(limit, 17 - (page - 1) * limit)
        );
        seen.push(...body.profiles.map((profile) => profile.id));
      }
      expect(seen).toEqual(fixture.expectedIds);
      expect(new Set(seen).size).toBe(17);
    }
  });
  it('keeps live totals on the empty page after the last surviving profile', async () => {
    const { body } = await fetchFavorites('?limit=1&page=3');
    expect(body.profiles).toEqual([]);
    expect(body.total).toBe(2);
    expect(body.pagination.totalPages).toBe(2);
  });
  it('requires authentication and keeps different viewers independent', async () => {
    expect((await request('', null)).status).toBe(401);
    expect((await request('', null, true)).status).toBe(401);
    const { body } = await fetchFavorites('', main.outsiderId);
    expect(body.profiles).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.pagination.totalPages).toBe(0);
    expect((await request('?limit=101')).status).toBe(400);
    expect((await fetchFavorites()).body.total).toBe(2);
  });
  it('rolls back partial acquisition and preserves foreign references and changed tuples', async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture);
    const attemptedUsers: string[] = [];
    await expect(
      createFixture(2, false, {
        favoriteId: fixture.favoriteIds[0]!,
        attemptedUsers,
      })
    ).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'Favorite_pkey',
    });
    expect(attemptedUsers).toHaveLength(5);
    const remaining = await control.unsafe<{ id: string }[]>(
      'SELECT id FROM public."User" WHERE id=ANY($1::text[])',
      [attemptedUsers]
    );
    expect(Array.from(remaining)).toEqual([]);
    expect(await snapshot(fixture)).toEqual(before);

    const foreignId = randomUUID();
    const [foreign] = await control.unsafe<Row[]>(
      'INSERT INTO public."Favorite" (id,"userId","targetUserId") VALUES ($1,$2,$3) RETURNING id,to_jsonb("Favorite")::text AS canonical',
      [foreignId, fixture.outsiderId, fixture.authorAId]
    );
    if (!foreign) throw new Error('Foreign Favorite receipt missing');
    try {
      await expect(cleanup(fixture)).rejects.toThrow(
        'Owned favorites cleanup refused User'
      );
      expect(await snapshot(fixture)).toEqual(before);
      const [retained] = await control.unsafe<Row[]>(
        'SELECT id,to_jsonb(t)::text AS canonical FROM public."Favorite" t WHERE id=$1',
        [foreign.id]
      );
      expect(retained).toEqual(foreign);
    } finally {
      const removed = await control.unsafe<{ id: string }[]>(
        'DELETE FROM public."Favorite" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING id',
        [foreign.id, foreign.canonical]
      );
      expect(removed).toHaveLength(1);
    }
    const owned = fixture.rows.find(
      (row) => row.table === 'User' && row.id === fixture.viewerId
    );
    if (!owned) throw new Error('Owned drift control missing');
    const [changed] = await control.unsafe<Row[]>(
      'UPDATE public."User" t SET bio=$2 WHERE id=$1 AND to_jsonb(t)=$3::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical',
      [owned.id, 'owned drift refusal control', owned.canonical]
    );
    if (!changed) throw new Error('Drift control acquisition failed');
    try {
      await expect(cleanup(fixture)).rejects.toThrow(
        'Owned favorites cleanup refused User'
      );
      const [retained] = await control.unsafe<Row[]>(
        'SELECT id,to_jsonb(t)::text AS canonical FROM public."User" t WHERE id=$1',
        [owned.id]
      );
      expect(retained).toEqual(changed);
    } finally {
      const [restored] = await control.unsafe<Row[]>(
        'UPDATE public."User" t SET bio=($2::text::jsonb->>\'bio\') WHERE id=$1 AND to_jsonb(t)=$3::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical',
        [owned.id, owned.canonical, changed.canonical]
      );
      expect(restored).toEqual({ id: owned.id, canonical: owned.canonical });
      await cleanup(fixture);
    }
  });
});
