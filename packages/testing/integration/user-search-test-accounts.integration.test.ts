/** PRD §12, MVP5: authenticated people search, membership and viewer privacy. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, eq, inArray, userBlocks, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

// Clients are lazy. Refuse unintended destinations before the first query.
if (process.env.DATABASE_READ_REPLICA_URL?.trim())
  throw new Error('Search fixture refuses a replica');
function databaseTarget(value: string | undefined) {
  if (!value) throw new Error('Explicit disposable database required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !(
      (port === '55685' &&
        /^feed_pr\d+$/.test(name) &&
        url.username === 'symbiex') ||
      (port === '5432' && name === 'test_db' && process.env.CI === 'true')
    )
  )
    throw new Error('Disposable loopback database required');
  return `${port}/${name}/${url.username}`;
}
const primary = databaseTarget(process.env.DATABASE_URL);
if (
  process.env.DIRECT_DATABASE_URL &&
  databaseTarget(process.env.DIRECT_DATABASE_URL) !== primary
)
  throw new Error('Search fixture direct target differs');
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
  throw new Error('Disposable loopback HTTP server required');

const owned = {
  users: new Set<string>(),
  blocks: new Set<string>(),
  mutes: new Set<string>(),
};
const ids = new Map<string, string>(),
  names = new Map<string, string>(),
  tokens = new Map<string, string>();
const schema = z.object({
  users: z.array(
    z
      .object({
        id: z.string(),
        username: z.string().nullable(),
        isAgent: z.boolean().optional(),
      })
      .passthrough()
  ),
});
const stageControls = new Map<
  string,
  { query: string; ids: string[]; all: string[] }
>();
let run = '',
  query = '',
  crowded = '',
  exactId = '',
  ip = '';
function get(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error(`Missing search fixture ${label}`);
  return value;
}
const id = (label: string) => get(ids, label);
async function acquire(
  rows: Array<typeof users.$inferInsert>,
  registry = owned.users
) {
  for (const row of await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id })) {
    registry.add(row.id);
    owned.users.add(row.id);
  }
}
async function request(
  q: string,
  viewer = 'viewer',
  includeAgents = false,
  cookie = false,
  extra: Record<string, string> = {}
) {
  const token = get(tokens, viewer);
  return fetch(
    `${base}/api/users/search?${new URLSearchParams({ q, includeAgents: String(includeAgents) })}`,
    {
      headers: {
        'x-forwarded-for': ip,
        ...(cookie
          ? { cookie: `steward-token=${token}` }
          : { authorization: `Bearer ${token}` }),
        ...extra,
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }
  );
}
async function page(
  q = query,
  viewer = 'viewer',
  includeAgents = false,
  cookie = false
) {
  const response = await request(q, viewer, includeAgents, cookie);
  expect(response.status).toBe(200);
  const body = schema.parse(await response.json());
  expect(body.users.length).toBeLessThanOrEqual(20);
  expect(new Set(body.users.map((row) => row.id)).size).toBe(body.users.length);
  return { body, response, ids: body.users.map((row) => row.id) };
}
async function cleanup() {
  const failures: Error[] = [];
  const actions = [
    async () => {
      if (owned.blocks.size)
        await db
          .delete(userBlocks)
          .where(inArray(userBlocks.id, [...owned.blocks]));
    },
    async () => {
      if (owned.mutes.size)
        await db
          .delete(userMutes)
          .where(inArray(userMutes.id, [...owned.mutes]));
    },
    async () => {
      if (owned.users.size)
        await db.delete(users).where(inArray(users.id, [...owned.users]));
    },
    async () => {
      if (owned.blocks.size)
        expect(
          await db
            .select({ id: userBlocks.id })
            .from(userBlocks)
            .where(inArray(userBlocks.id, [...owned.blocks]))
        ).toHaveLength(0);
    },
    async () => {
      if (owned.mutes.size)
        expect(
          await db
            .select({ id: userMutes.id })
            .from(userMutes)
            .where(inArray(userMutes.id, [...owned.mutes]))
        ).toHaveLength(0);
    },
    async () => {
      if (owned.users.size)
        expect(
          await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.id, [...owned.users]))
        ).toHaveLength(0);
    },
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error
          : new Error('Owned fixture cleanup failed')
      );
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned search fixture cleanup incomplete'
    );
}

beforeAll(async () => {
  run = await generateSnowflakeId();
  query = `qs${run}`;
  crowded = `abcdef${run}`;
  const groups = BigInt(run).toString(16).padStart(16, '0').match(/.{4}/g);
  if (!groups) throw new Error('Fixture IP allocation failed');
  ip = `2001:db8:1695:0:${groups.join(':')}`;
  const rows: Array<typeof users.$inferInsert> = [];
  for (const label of [
    'viewer',
    'other',
    'real',
    'second',
    'flag',
    'prefix',
    'banned',
    'actor',
    'agent',
    'hidden-agent',
    'blocked',
    'blocker',
    'muted',
  ]) {
    const userId = `${label === 'prefix' ? 'test-' : ''}${await generateSnowflakeId()}`;
    const username = `${query}_${label}`;
    ids.set(label, userId);
    names.set(label, username);
    rows.push({
      id: userId,
      username,
      displayName: ['real', 'second', 'flag', 'prefix'].includes(label)
        ? `zz${query}tail`
        : username,
      stewardId: `p1695-${userId}`,
      updatedAt: new Date(),
      isTest: ['flag', 'hidden-agent'].includes(label),
      isBanned: label === 'banned',
      isActor: label === 'actor',
      isAgent: ['agent', 'hidden-agent'].includes(label),
    });
  }
  for (let n = 0; n < 64; n++) {
    const letters = [...'abcdef']
      .map((c, bit) => (n & (1 << bit) ? c.toUpperCase() : c))
      .join('');
    rows.push({
      id: `${n % 2 ? 'test-' : ''}${await generateSnowflakeId()}`,
      username: `${letters}${run}`,
      updatedAt: new Date(),
    });
  }
  for (let n = 0; n < 20; n++)
    rows.push({
      id: await generateSnowflakeId(),
      username: `000_${run}_${String(n).padStart(2, '0')}`,
      displayName: `${crowded} prefix ${n}`,
      updatedAt: new Date(),
    });
  for (const stage of ['prefix', 'substring']) {
    const stageQuery = `${stage === 'prefix' ? 'pfx' : 'sub'}${run}`;
    const visible: string[] = [],
      all: string[] = [];
    for (let n = 0; n < 26; n++) {
      const hidden = n < 24;
      const userId = `${hidden && n % 2 ? 'test-' : ''}${await generateSnowflakeId()}`;
      all.push(userId);
      if (!hidden) visible.push(userId);
      const username =
        stage === 'prefix'
          ? `${stageQuery}_${hidden ? 'a' : 'z'}_${n}`
          : `${hidden ? 'a' : 'z'}_${run}_sub_${n}`;
      rows.push({
        id: userId,
        username,
        displayName:
          stage === 'prefix' ? username : `before ${stageQuery} after`,
        isTest: hidden && n % 2 === 0,
        updatedAt: new Date(),
      });
    }
    stageControls.set(stage, { query: stageQuery, ids: visible, all });
  }
  try {
    await acquire(rows);
    const ordered = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        inArray(
          users.id,
          rows.slice(13, 77).map((row) => row.id)
        )
      )
      .orderBy(users.username);
    const eligible = ordered
      .filter((row) => !row.id.startsWith('test-'))
      .at(-1);
    if (!eligible) throw new Error('Missing visible exact control');
    exactId = eligible.id;
    // Establish both premises using this database's actual collation. A prefix
    // rescue must be crowded out too; no locale/order assumption is the oracle.
    expect(
      ordered.findIndex((row) => row.id === exactId)
    ).toBeGreaterThanOrEqual(20);
    const prefixOrder = await db
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(users.id, [...rows.slice(77, 97).map((row) => row.id), exactId])
      )
      .orderBy(users.username);
    expect(prefixOrder.at(-1)?.id).toBe(exactId);
    const hidden = ordered
      .filter((row) => row.id !== exactId && !row.id.startsWith('test-'))
      .map((row) => row.id);
    await db
      .update(users)
      .set({ isTest: true })
      .where(inArray(users.id, hidden));
    for (const control of stageControls.values()) {
      const orderedStage = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, control.all))
        .orderBy(users.username);
      expect(
        orderedStage.slice(0, 20).every((row) => !control.ids.includes(row.id))
      ).toBe(true);
    }
    for (const row of await db
      .insert(userBlocks)
      .values([
        {
          id: await generateSnowflakeId(),
          blockerId: id('viewer'),
          blockedId: id('blocked'),
        },
        {
          id: await generateSnowflakeId(),
          blockerId: id('blocker'),
          blockedId: id('viewer'),
        },
      ])
      .returning({ id: userBlocks.id }))
      owned.blocks.add(row.id);
    for (const row of await db
      .insert(userMutes)
      .values({
        id: await generateSnowflakeId(),
        muterId: id('viewer'),
        mutedId: id('muted'),
      })
      .returning({ id: userMutes.id }))
      owned.mutes.add(row.id);
    for (const label of ['viewer', 'other'])
      tokens.set(label, await createStewardTestToken(`p1695-${id(label)}`));
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Search fixture setup and cleanup failed'
      );
    }
    throw error;
  }
}, 30000);
afterAll(cleanup, 30000);

describe('authenticated people search membership', () => {
  it('keeps only real people and existing moderation controls', async () => {
    const result = await page();
    expect(new Set(result.ids)).toEqual(
      new Set([id('other'), id('real'), id('second')])
    );
  });
  it('filters hidden exact usernames, including the id-prefix tier', async () => {
    for (const label of ['flag', 'prefix'])
      expect((await page(get(names, label))).ids).toHaveLength(0);
  });
  it('filters display-name substring matches before limiting', async () => {
    const result = await page(`${query}tail`);
    expect(new Set(result.ids)).toEqual(new Set([id('real'), id('second')]));
  });
  it('includes eligible agents only when explicitly requested', async () => {
    const result = await page(query, 'viewer', true);
    expect(new Set(result.ids)).toEqual(
      new Set([id('other'), id('real'), id('second'), id('agent')])
    );
    expect(
      result.body.users.find((row) => row.id === id('agent'))?.isAgent
    ).toBe(true);
  });
  it('keeps an eligible folded exact result ahead of twenty prefix competitors', async () => {
    for (const value of [
      crowded,
      crowded.toUpperCase(),
      `  ${crowded.toUpperCase()}  `,
    ]) {
      const result = await page(value);
      expect(result.ids).toHaveLength(20);
      expect(result.ids[0]).toBe(exactId);
      expect(result.ids.every((value) => owned.users.has(value))).toBe(true);
    }
  });
  for (const stage of ['prefix', 'substring']) {
    it(`filters more than twenty hidden ${stage} matches before the result cap`, async () => {
      const control = stageControls.get(stage);
      if (!control) throw new Error('Missing crowded stage control');
      for (const value of [
        control.query,
        control.query.toUpperCase(),
        `  ${control.query}  `,
      ]) {
        expect(new Set((await page(value)).ids)).toEqual(new Set(control.ids));
      }
    });
  }
  it('binds the same query to each viewer without sharing moderation results', async () => {
    const a = await page();
    const b = await page(query, 'other', false, true);
    expect(b.ids).toContain(id('viewer'));
    for (const label of ['blocked', 'blocker', 'muted']) {
      expect(a.ids).not.toContain(id(label));
      expect(b.ids).toContain(id(label));
    }
    expect(b.ids).not.toContain(id('other'));
    expect((await page()).ids).toEqual(a.ids);
  });
  it('returns no people for authenticated short queries', async () => {
    for (const value of ['', ' ', 'a'])
      expect((await page(value)).ids).toHaveLength(0);
  });
  it('marks both authenticated success paths private', async () => {
    for (const value of ['', query])
      expect((await page(value)).response.headers.get('cache-control')).toBe(
        'private, no-store'
      );
  });
  it('returns no rows for an unmatched literal SQL-looking query', async () => {
    expect((await page(`${run}' OR 1=1 --`)).ids).toHaveLength(0);
  });
  it('requires real authentication and ignores dev identity headers', async () => {
    const refusedHeaders: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer invalid' },
      { 'x-dev-user-id': id('viewer') },
    ];
    for (const headers of refusedHeaders) {
      const response = await fetch(`${base}/api/users/search?q=${query}`, {
        headers: { 'x-forwarded-for': ip, ...headers },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      expect(response.status).toBe(401);
    }
  });
  it('tracks partial setup only after RETURNING and preserves a collision owner', async () => {
    const acquired = new Set<string>(),
      rejected = new Set<string>();
    const partial = await generateSnowflakeId(),
      attempted = await generateSnowflakeId();
    try {
      await acquire(
        [{ id: partial, username: `partial_${run}`, updatedAt: new Date() }],
        acquired
      );
      await expect(
        acquire(
          [
            {
              id: attempted,
              username: `attempt_${run}`,
              updatedAt: new Date(),
            },
            {
              id: id('real'),
              username: `collision_${run}`,
              updatedAt: new Date(),
            },
          ],
          rejected
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(rejected.size).toBe(0);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, attempted))
      ).toHaveLength(0);
    } finally {
      if (acquired.size)
        await db.delete(users).where(inArray(users.id, [...acquired]));
    }
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, partial))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, id('real')))
    ).toHaveLength(1);
  });
});
