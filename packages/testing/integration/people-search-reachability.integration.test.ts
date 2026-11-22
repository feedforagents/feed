/** PRD §12 / MVP Phase 5: bounded ranked people-search API pages; picker UI is unchanged. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
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
for (const origin of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (origin && new URL(origin).origin !== server.origin)
    throw new Error('Fixture HTTP origins must match');
const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
type Table = 'User' | 'UserBlock' | 'UserMute' | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
type Input = {
  id: string;
  username: string | null;
  displayName: string | null;
  stewardId: string;
  isTest: boolean;
  isBanned: boolean;
  isActor: boolean;
  isAgent: boolean;
};
const main: Receipt[] = [],
  controls: Receipt[] = [],
  references: Receipt[] = [];
const ids = new Map<string, string>();
const namesakeIds: string[] = [],
  familyIds: string[] = [],
  mixedIds: string[] = [];
let namesakeToken = '',
  familyToken = '',
  mixedToken = '',
  edgeToken = '',
  token = '',
  targetNamesakeId = '';
const literalQueries: { query: string; label: string }[] = [];
const PAGE = 20,
  NAMESAKES = 300,
  FAMILY = 60;
const resultSchema = z.object({
  users: z.array(
    z
      .object({
        id: z.string(),
        username: z.string().nullable(),
        displayName: z.string().nullable(),
        profileImageUrl: z.string().nullable(),
        bio: z.string().nullable(),
        isAgent: z.boolean().optional(),
      })
      .strict()
  ),
});
function id(label: string) {
  const value = ids.get(label);
  if (!value) throw new Error('Missing acquired fixture ' + label);
  return value;
}
async function fresh() {
  const value = await generateSnowflakeId();
  if (!isValidSnowflakeId(value))
    throw new Error('Invalid generated fixture ID');
  return value;
}
async function acquire(
  tx: postgres.TransactionSql,
  pending: Receipt[],
  table: Table,
  statement: string,
  values: string[]
) {
  const returned = await tx.unsafe<Physical[]>(
    statement + ` RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of returned) pending.push({ table, ...row });
  if (returned.length !== 1) throw new Error('Acquisition failed ' + table);
}
const foreignUserReferences =
  ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding"x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot"x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist"x WHERE x."userId"=t.id OR x."grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig"x WHERE x."updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserBlock"x WHERE x."blockerId"=t.id OR x."blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute"x WHERE x."muterId"=t.id OR x."mutedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Follow"x WHERE x."followerId"=t.id OR x."followingId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post"x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment"x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group"x WHERE x."ownerId"=t.id OR x."createdById"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember"x WHERE x."userId"=t.id OR x."addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite"x WHERE x."invitedUserId"=t.id OR x."invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat"x WHERE x."createdBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant"x WHERE x."userId"=t.id OR x."addedBy"=t.id OR x."invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification"x WHERE x."userId"=t.id OR x."actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey"x WHERE x."userId"=t.id)';
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const row of rows
      .filter((r) => r.table === 'User')
      .sort((a, b) => a.id.localeCompare(b.id)))
      await tx.unsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [row.id]);
    for (const table of [
      'UserBlock',
      'UserMute',
      'GameOnboarding',
      'User',
    ] as const)
      for (const row of rows.filter((r) => r.table === table).reverse()) {
        const removed = await tx.unsafe<Physical[]>(
          `DELETE FROM "${table}"t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${table === 'User' ? foreignUserReferences : ''} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error('Owned cleanup refused ' + table);
      }
  });
  rows.length = 0;
}
async function physical(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const row of rows) {
    const [current] = await control.unsafe<Physical[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}"t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Acquired row missing');
    result.push({ table: row.table, ...current });
  }
  return result;
}
async function request(
  q: string,
  offset?: number,
  includeAgents = false,
  auth: 'normal' | 'anonymous' | 'invalid' = 'normal'
) {
  const params = new URLSearchParams({
    q,
    includeAgents: String(includeAgents),
  });
  if (offset !== undefined) params.set('offset', String(offset));
  return fetch(base + '/api/users/search?' + params, {
    headers:
      auth === 'anonymous'
        ? {}
        : {
            authorization:
              'Bearer ' + (auth === 'invalid' ? 'invalid-owned-jwt' : token),
          },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function search(q: string, offset?: number, includeAgents = false) {
  const response = await request(q, offset, includeAgents);
  expect(response.status).toBe(200);
  const body = resultSchema.parse(await response.json());
  expect(body.users.length).toBeLessThanOrEqual(PAGE);
  expect(new Set(body.users.map((u) => u.id)).size).toBe(body.users.length);
  return body;
}
async function walkAll(q: string, total: number) {
  const result: string[] = [];
  for (let offset = 0; offset < total; offset += PAGE)
    result.push(...(await search(q, offset)).users.map((u) => u.id));
  return result;
}
beforeAll(async () => {
  const run = await fresh();
  namesakeToken = 'namesake' + run;
  familyToken = 'fam' + run;
  mixedToken = 'mx' + run;
  edgeToken = 'ed' + run;

  const planned = new Map<string, string>(),
    rows: Input[] = [];
  async function add(
    label: string,
    username: string | null,
    displayName: string | null,
    flags: Partial<
      Pick<Input, 'isTest' | 'isBanned' | 'isActor' | 'isAgent'>
    > = {}
  ) {
    const valid = await fresh(),
      value = label === 'prefixed' ? 'test-search1738-' + valid : valid;
    planned.set(label, value);
    rows.push({
      id: value,
      username,
      displayName,
      stewardId: randomUUID(),
      isTest: false,
      isBanned: false,
      isActor: false,
      isAgent: false,
      ...flags,
    });
    return value;
  }
  await add('viewer', 'viewer' + run, edgeToken);
  for (let i = 1; i <= NAMESAKES; i++)
    namesakeIds.push(
      await add(
        'name' + i,
        'zz' + run + 'u' + String(i).padStart(4, '0'),
        namesakeToken
      )
    );
  for (let i = 1; i <= FAMILY; i++)
    familyIds.push(
      await add(
        'family' + i,
        familyToken + String(i).padStart(4, '0'),
        'Member ' + run + ' ' + i
      )
    );
  mixedIds.push(await add('exact', mixedToken.toUpperCase(), 'Exact ' + run));
  for (let i = 0; i < 23; i++)
    mixedIds.push(
      await add(
        'prefix' + i,
        'ap' + run + String(i).padStart(2, '0'),
        mixedToken + ' start ' + i
      )
    );
  for (let i = 0; i < 22; i++)
    mixedIds.push(
      await add(
        'fallback' + i,
        i < 20 ? 'bf' + run + String(i).padStart(2, '0') : null,
        'before ' + mixedToken + ' after'
      )
    );
  for (const [index, special] of ['%', '_', '\\'].entries()) {
    const query = 'lx' + run + index + special;
    const label = 'literal' + index;
    literalQueries.push({ query, label });
    await add(label, 'literal' + run + index, query + ' tail');
    await add(
      'decoy' + index,
      'decoy' + run + index,
      'lx' + run + index + 'X tail'
    );
  }
  for (const label of [
    'real',
    'agent',
    'actor',
    'flagged',
    'prefixed',
    'banned',
    'blocked',
    'blocker',
    'muted',
  ])
    await add(label, edgeToken + label, edgeToken, {
      isAgent: label === 'agent',
      isActor: label === 'actor',
      isTest: label === 'flagged',
      isBanned: label === 'banned',
    });
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    const returned = await tx.unsafe<Physical[]>(
      'INSERT INTO "User"(id,username,"displayName","stewardId","updatedAt","isTest","isBanned","isActor","isAgent") SELECT id,username,"displayName","stewardId",now(),"isTest","isBanned","isActor","isAgent" FROM jsonb_to_recordset($1::text::jsonb) AS x(id text,username text,"displayName" text,"stewardId" text,"isTest" boolean,"isBanned" boolean,"isActor" boolean,"isAgent" boolean) RETURNING id,to_jsonb("User")::text AS canonical',
      [JSON.stringify(rows)]
    );
    for (const row of returned) pending.push({ table: 'User', ...row });
    if (returned.length !== rows.length)
      throw new Error('Batch acquisition incomplete');
    const p = (label: string) => {
      const value = planned.get(label);
      if (!value) throw new Error('Missing planned user');
      return value;
    };
    for (const [from, to] of [
      ['viewer', 'blocked'],
      ['blocker', 'viewer'],
    ] as const)
      await acquire(
        tx,
        pending,
        'UserBlock',
        'INSERT INTO "UserBlock"(id,"blockerId","blockedId")VALUES($1,$2,$3)',
        [await fresh(), p(from), p(to)]
      );
    await acquire(
      tx,
      pending,
      'UserMute',
      'INSERT INTO "UserMute"(id,"muterId","mutedId")VALUES($1,$2,$3)',
      [await fresh(), p('viewer'), p('muted')]
    );
  });
  main.push(...pending);
  for (const [label, value] of planned) ids.set(label, value);
  const target = namesakeIds[249];
  if (!target) throw new Error('Missing acquired250th namesake');
  targetNamesakeId = target;
  const viewer = rows.find((r) => r.id === id('viewer'));
  if (!viewer) throw new Error('Missing acquired viewer');
  token = await createStewardTestToken(viewer.stewardId);
}, 30000);
afterAll(async () => {
  try {
    await cleanup(references);
    await cleanup(controls);
    await cleanup(main);
  } finally {
    await control.end({ timeout: 5 });
  }
}, 30000);
describe('web people search reachability', () => {
  it('pages through all 300 namesakes exactly once', async () => {
    const found = await walkAll(namesakeToken, NAMESAKES);
    expect(found.length).toBe(NAMESAKES);
    expect(new Set(found).size).toBe(NAMESAKES);
    expect(new Set(found)).toEqual(new Set(namesakeIds));
  });
  it('reaches the namesake ranked 250th by a name-only query', async () => {
    const found = await walkAll(namesakeToken, NAMESAKES);
    expect(found).toContain(targetNamesakeId);
    expect(found.indexOf(targetNamesakeId)).toBe(249);
  });
  it('paging order is deterministic across two full walks', async () => {
    expect(await walkAll(namesakeToken, NAMESAKES)).toEqual(
      await walkAll(namesakeToken, NAMESAKES)
    );
  });
  it('pages through all 60 username-prefix matches exactly once', async () => {
    const found = await walkAll(familyToken, FAMILY);
    expect(found.length).toBe(FAMILY);
    expect(new Set(found)).toEqual(new Set(familyIds));
  });
  it('default call still returns the first window of 20', async () => {
    const found = await search(namesakeToken);
    expect(found.users.map((u) => u.id)).toEqual(namesakeIds.slice(0, PAGE));
  });
  it('exact username search still returns that account', async () => {
    expect(
      (
        await search('zz' + namesakeToken.slice('namesake'.length) + 'u0250')
      ).users.map((u) => u.id)
    ).toEqual([targetNamesakeId]);
  });
  it('keeps exact prefix and substring tiers across page boundaries with deterministic null-username ties', async () => {
    for (const q of [mixedToken, '  ' + mixedToken.toUpperCase() + '  '])
      expect(await walkAll(q, mixedIds.length)).toEqual(mixedIds);
    expect((await search(mixedToken, 100000)).users).toEqual([]);
    for (const literal of literalQueries)
      expect((await search(literal.query)).users.map((u) => u.id)).toEqual([
        id(literal.label),
      ]);
  });
  it('preserves eligibility moderation optional agents and normal authentication on every window', async () => {
    expect((await search(edgeToken)).users.map((u) => u.id)).toEqual([
      id('real'),
    ]);
    const withAgents = await search(edgeToken, 0, true);
    expect(new Set(withAgents.users.map((u) => u.id))).toEqual(
      new Set([id('real'), id('agent')])
    );
    expect(withAgents.users.find((u) => u.id === id('agent'))?.isAgent).toBe(
      true
    );
    const response = await request(namesakeToken, 20);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    for (const auth of ['anonymous', 'invalid'] as const)
      expect((await request(namesakeToken, 20, false, auth)).status).toBe(401);
    expect((await search('a')).users).toEqual([]);
    expect((await search(namesakeToken, -1)).users.map((u) => u.id)).toEqual(
      namesakeIds.slice(0, PAGE)
    );
  });
  it('does not acquire rolled-back setup or cascade a separately acquired foreign reference', async () => {
    const failed: Receipt[] = [];
    await expect(
      control.begin(async (tx) => {
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
          [await fresh(), 'partial1738_' + randomUUID()]
        );
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
          [id('viewer'), 'collision1738_' + randomUUID()]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    for (const row of failed)
      expect(
        await control.unsafe('SELECT id FROM "User" WHERE id=$1', [row.id])
      ).toHaveLength(0);
    const pending: Receipt[] = [],
      user = await fresh();
    await control.begin(async (tx) => {
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
        [user, 'control1738_' + user]
      );
      await acquire(
        tx,
        pending,
        'UserMute',
        'INSERT INTO "UserMute"(id,"muterId","mutedId")VALUES($1,$2,$3)',
        [await fresh(), user, id('viewer')]
      );
    });
    controls.push(...pending);
    const foreign: Receipt[] = [];
    await control.begin(async (tx) => {
      await acquire(
        tx,
        foreign,
        'GameOnboarding',
        'INSERT INTO "GameOnboarding"(id,"userId")VALUES($1,$2)',
        [await fresh(), user]
      );
    });
    references.push(...foreign);
    const before = await physical([...controls, ...references]);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned cleanup refused User'
    );
    expect(await physical([...controls, ...references])).toEqual(before);
    await cleanup(references);
    await cleanup(controls);
  });
});
