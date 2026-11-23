/** PRD §§9.5/12 / MVP Phase5: group rosters and counts share visible active User membership. */
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
type Table = 'User' | 'Group' | 'GroupMember' | 'GroupInvite';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const main: Receipt[] = [],
  controls: Receipt[] = [],
  references: Receipt[] = [];
const fixtures = [main, controls],
  ids = new Map<string, string>(),
  tokens = new Map<string, string>();
const run = randomUUID(),
  baseTime = Date.now() - 3600_000;
const at = (n: number) => new Date(baseTime + n * 1000).toISOString();
const userLabels = [
  'viewer',
  'normalA',
  'normalB',
  'flagged',
  'prefixed',
  'banned',
  'npc',
  'agent',
  'inactive',
  'inviteOwner',
  'inviteTest',
  'inviteBanned',
  'nonmember',
] as const;
const memberSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  memberType: z.enum(['npc', 'agent', 'user']),
  role: z.string(),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  joinedAt: z.string(),
});
const rosterSchema = z.object({
  groupId: z.string(),
  members: z.array(memberSchema),
});
const detailSchema = z.object({
  group: z.object({
    id: z.string(),
    members: z.array(memberSchema),
    userRole: z.string(),
    isAdmin: z.boolean(),
    isOwner: z.boolean(),
  }),
});
const listSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      memberCount: z.number().int().nonnegative(),
      role: z.string(),
      isAdmin: z.boolean(),
      isOwner: z.boolean(),
    })
  ),
});
const inviteSchema = z.object({
  invites: z.array(
    z.object({
      inviteId: z.string(),
      groupId: z.string(),
      memberCount: z.number().int().nonnegative(),
    })
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
  rows: Receipt[],
  table: Table,
  statement: string,
  values: (string | boolean)[]
) {
  const result = await tx.unsafe<Physical[]>(
    statement + ` RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of result) rows.push({ table, ...row });
  if (result.length !== 1)
    throw new Error('Fixture acquisition failed ' + table);
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
const guards: Record<Table, string> = {
  GroupMember: '',
  GroupInvite: '',
  Group:
    ' AND NOT EXISTS(SELECT 1 FROM "GroupMember"x WHERE x."groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite"x WHERE x."groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat"x WHERE x."groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group"x WHERE x."parentGroupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification"x WHERE x."groupId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding"x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot"x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist"x WHERE x."userId"=t.id OR x."grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig"x WHERE x."updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group"x WHERE x."ownerId"=t.id OR x."createdById"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember"x WHERE x."userId"=t.id OR x."addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite"x WHERE x."invitedUserId"=t.id OR x."invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat"x WHERE x."createdBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant"x WHERE x."userId"=t.id OR x."addedBy"=t.id OR x."invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification"x WHERE x."userId"=t.id OR x."actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey"x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserBlock"x WHERE x."blockerId"=t.id OR x."blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute"x WHERE x."muterId"=t.id OR x."mutedId"=t.id)',
};
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Group'] as const)
      for (const row of rows
        .filter((r) => r.table === table)
        .sort((a, b) => a.id.localeCompare(b.id)))
        await tx.unsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [
          row.id,
        ]);
    for (const table of [
      'GroupInvite',
      'GroupMember',
      'Group',
      'User',
    ] as const)
      for (const row of rows.filter((r) => r.table === table).reverse()) {
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}"t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${guards[table]} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error('Owned cleanup refused ' + table);
      }
  });
  rows.length = 0;
}
async function request(path: string, label = 'viewer', invalid = false) {
  const token = tokens.get(label);
  if (label !== 'anonymous' && !token)
    throw new Error('Missing normal Steward token');
  return fetch(base + path, {
    headers:
      label === 'anonymous'
        ? {}
        : {
            authorization: 'Bearer ' + (invalid ? 'invalid-owned-jwt' : token),
          },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function roster(label = 'viewer', group = id('group')) {
  const response = await request('/api/groups/' + group + '/members', label);
  expect(response.status).toBe(200);
  return rosterSchema.parse(await response.json());
}
async function detail(label = 'viewer', group = id('group')) {
  const response = await request('/api/groups/' + group, label);
  expect(response.status).toBe(200);
  return detailSchema.parse(await response.json()).group;
}
async function list(label = 'viewer') {
  const response = await request('/api/groups', label);
  expect(response.status).toBe(200);
  return listSchema.parse(await response.json()).groups;
}
async function invites() {
  const response = await request('/api/groups/invites');
  expect(response.status).toBe(200);
  return inviteSchema.parse(await response.json()).invites;
}
const visible = () => ['viewer', 'normalA', 'normalB', 'npc', 'agent'].map(id);
beforeAll(async () => {
  const planned = new Map<string, string>(),
    stewards = new Map<string, string>();
  for (const label of [...userLabels, 'group', 'inviteGroup', 'zeroGroup'])
    planned.set(label, await fresh());
  // This one intentionally prefixed target tests the existing test-ID tier; it is never an authenticated caller.
  const prefixedSeed = planned.get('prefixed');
  if (!prefixedSeed) throw new Error('Missing prefixed seed');
  planned.set('prefixed', 'test-gm1732-' + prefixedSeed);
  const p = (label: string) => {
    const value = planned.get(label);
    if (!value) throw new Error('Missing planned ID');
    return value;
  };
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    for (const label of userLabels) {
      const steward = randomUUID();
      stewards.set(label, steward);
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","isTest","isBanned","isActor","isAgent","updatedAt")VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())',
        [
          p(label),
          'gm1732_' + p(label).replace('test-gm1732-', ''),
          steward,
          'Group ' + label,
          label === 'flagged' || label === 'inviteTest',
          label === 'banned' || label === 'inviteBanned',
          label === 'npc',
          label === 'agent',
        ]
      );
    }
    for (const [label, owner, n] of [
      ['group', 'viewer', 0],
      ['inviteGroup', 'inviteOwner', 1],
      ['zeroGroup', 'flagged', 2],
    ] as const)
      await acquire(
        tx,
        pending,
        'Group',
        'INSERT INTO "Group"(id,name,type,"ownerId","createdById","createdAt","updatedAt")VALUES($1,$2,\'user\',$3,$3,$4::timestamp,$4::timestamp)',
        [p(label), 'Owned group ' + label + ' ' + run, p(owner), at(n)]
      );
    let n = 0;
    for (const label of [
      'viewer',
      'normalA',
      'normalB',
      'flagged',
      'prefixed',
      'banned',
      'npc',
      'agent',
      'inactive',
    ])
      await acquire(
        tx,
        pending,
        'GroupMember',
        'INSERT INTO "GroupMember"(id,"groupId","userId",role,"isActive","joinedAt","addedBy")VALUES($1,$2,$3,$4,$5,$6::timestamp,$7)',
        [
          await fresh(),
          p('group'),
          p(label),
          label === 'viewer' ? 'owner' : 'member',
          label !== 'inactive',
          at(n++),
          p('viewer'),
        ]
      );
    for (const [group, label, owner] of [
      ['inviteGroup', 'inviteOwner', 'inviteOwner'],
      ['inviteGroup', 'inviteTest', 'inviteOwner'],
      ['inviteGroup', 'inviteBanned', 'inviteOwner'],
      ['zeroGroup', 'flagged', 'flagged'],
      ['zeroGroup', 'banned', 'flagged'],
    ] as const)
      await acquire(
        tx,
        pending,
        'GroupMember',
        'INSERT INTO "GroupMember"(id,"groupId","userId",role,"joinedAt","addedBy")VALUES($1,$2,$3,$4,$5::timestamp,$6)',
        [
          await fresh(),
          p(group),
          p(label),
          label === owner ? 'owner' : 'member',
          at(n++),
          p(owner),
        ]
      );
    for (const [group, owner, n] of [
      ['inviteGroup', 'inviteOwner', 0],
      ['zeroGroup', 'flagged', 1],
    ] as const)
      await acquire(
        tx,
        pending,
        'GroupInvite',
        'INSERT INTO "GroupInvite"(id,"groupId","invitedUserId","invitedBy",status,"invitedAt")VALUES($1,$2,$3,$4,\'pending\',$5::timestamp)',
        [await fresh(), p(group), p('viewer'), p(owner), at(n)]
      );
  });
  main.push(...pending);
  for (const [label, value] of planned) ids.set(label, value);
  for (const [label, steward] of stewards)
    tokens.set(label, await createStewardTestToken(steward));
}, 20000);
afterAll(async () => {
  const failures: Error[] = [];
  try {
    await cleanup(references);
  } catch (error) {
    if (error instanceof Error) failures.push(error);
    else throw error;
  }
  for (const rows of fixtures)
    try {
      await cleanup(rows);
    } catch (error) {
      if (error instanceof Error) failures.push(error);
      else throw error;
    }
  await control.end({ timeout: 5 });
  if (failures.length)
    throw new AggregateError(failures, 'Owned group fixture cleanup refused');
}, 20000);
describe('group member roster hidden accounts', () => {
  it('members route lists only visible members, keeping npc/agent entries', async () => {
    const before = await physical(main),
      body = await roster();
    expect(body.members.map((m) => m.id)).toEqual(visible());
    expect(body.members.find((m) => m.id === id('npc'))?.memberType).toBe(
      'npc'
    );
    expect(body.members.find((m) => m.id === id('agent'))?.memberType).toBe(
      'agent'
    );
    expect(body.members.find((m) => m.id === id('normalA'))?.memberType).toBe(
      'user'
    );
    expect(body.members.find((m) => m.id === id('viewer'))).toMatchObject({
      role: 'owner',
      isAdmin: true,
      isOwner: true,
    });
    expect(body.members.map((m) => m.id)).not.toContain(id('inactive'));
    expect(await physical(main)).toEqual(before);
  });
  it('group detail members (management header count) match the roster', async () => {
    const body = await detail();
    expect(body.members.map((m) => m.id).sort()).toEqual(visible().sort());
    expect(body.members).toHaveLength(5);
    expect(body).toMatchObject({
      userRole: 'owner',
      isAdmin: true,
      isOwner: true,
    });
  });
  it('group list memberCount counts only visible members', async () => {
    const groups = await list();
    expect(groups.find((g) => g.id === id('group'))).toMatchObject({
      memberCount: 5,
      role: 'owner',
      isOwner: true,
      isAdmin: true,
    });
  });
  it('invite card memberCount counts only visible members', async () => {
    const rows = await invites();
    expect(rows.find((g) => g.groupId === id('inviteGroup'))).toMatchObject({
      memberCount: 1,
    });
  });
  it('keeps active hidden requester authority and returns zero when all members are hidden', async () => {
    const body = await roster('flagged', id('zeroGroup'));
    expect(body.members).toHaveLength(0);
    const group = await detail('flagged', id('zeroGroup'));
    expect(group.members).toHaveLength(0);
    expect(group).toMatchObject({
      userRole: 'owner',
      isAdmin: true,
      isOwner: true,
    });
    expect(
      (await list('flagged')).find((g) => g.id === id('zeroGroup'))
    ).toMatchObject({ memberCount: 0, isOwner: true, isAdmin: true });
    expect(
      (await invites()).find((g) => g.groupId === id('zeroGroup'))
    ).toMatchObject({ memberCount: 0 });
  });
  it('retains normal auth and rejects inactive and nonmember roster access', async () => {
    for (const path of [
      '/api/groups',
      '/api/groups/invites',
      '/api/groups/' + id('group'),
      '/api/groups/' + id('group') + '/members',
    ]) {
      expect((await request(path, 'anonymous')).status).toBe(401);
      expect((await request(path, 'viewer', true)).status).toBe(401);
    }
    for (const label of ['inactive', 'nonmember']) {
      expect((await request('/api/groups/' + id('group'), label)).status).toBe(
        403
      );
      expect(
        (await request('/api/groups/' + id('group') + '/members', label)).status
      ).toBe(403);
    }
    expect(await list('nonmember')).toHaveLength(0);
    const missing = await fresh();
    expect((await request('/api/groups/' + missing)).status).toBe(404);
    expect((await request('/api/groups/' + missing + '/members')).status).toBe(
      404
    );
  });
  it('does not acquire partial setup and refuses an independently owned invite with atomic rollback', async () => {
    const failed: Receipt[] = [];
    await expect(
      control.begin(async (tx) => {
        const user = await fresh();
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
          [user, 'partial1732_' + user]
        );
        await acquire(
          tx,
          failed,
          'Group',
          'INSERT INTO "Group"(id,name,type,"ownerId","createdById","updatedAt")VALUES($1,$2,\'user\',$3,$3,now())',
          [id('group'), 'Collision ' + run, user]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'Group_pkey' });
    for (const row of failed)
      expect(
        await control.unsafe('SELECT id FROM "User" WHERE id=$1', [row.id])
      ).toHaveLength(0);
    const pending: Receipt[] = [],
      user = await fresh(),
      group = await fresh();
    await control.begin(async (tx) => {
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
        [user, 'control1732_' + user]
      );
      await acquire(
        tx,
        pending,
        'Group',
        'INSERT INTO "Group"(id,name,type,"ownerId","createdById","updatedAt")VALUES($1,$2,\'user\',$3,$3,now())',
        [group, 'Owned control ' + run, user]
      );
      await acquire(
        tx,
        pending,
        'GroupMember',
        'INSERT INTO "GroupMember"(id,"groupId","userId",role)VALUES($1,$2,$3,\'owner\')',
        [await fresh(), group, user]
      );
    });
    controls.push(...pending);
    const foreign: Receipt[] = [];
    await control.begin(async (tx) => {
      await acquire(
        tx,
        foreign,
        'GroupInvite',
        'INSERT INTO "GroupInvite"(id,"groupId","invitedUserId","invitedBy")VALUES($1,$2,$3,$4)',
        [await fresh(), group, id('viewer'), user]
      );
    });
    references.push(...foreign);
    const before = await physical([...controls, ...references]);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned cleanup refused Group'
    );
    expect(await physical([...controls, ...references])).toEqual(before);
    await cleanup(references);
    await cleanup(controls);
  });
});
