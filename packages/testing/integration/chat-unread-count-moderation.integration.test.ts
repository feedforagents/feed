/** PRD §12 / MVP Phase 5: the existing chat badge counts only visible actors. */
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
type Table =
  | 'User'
  | 'Group'
  | 'Chat'
  | 'GroupMember'
  | 'ChatParticipant'
  | 'DMAcceptance'
  | 'Notification'
  | 'UserBlock'
  | 'UserMute';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const fixtures: Receipt[][] = [],
  main: Receipt[] = [];
const ids = new Map<string, string>(),
  tokens = new Map<string, string>();
const run = randomUUID();
const badgeSchema = z.object({
  pendingDMs: z.number().int().nonnegative(),
  pendingDMRequests: z.number().int().nonnegative(),
  unreadMessages: z.number().int().nonnegative(),
  hasNewMessages: z.boolean(),
});
function id(label: string) {
  const value = ids.get(label);
  if (!value) throw new Error('Missing acquired fixture ' + label);
  return value;
}
async function fresh() {
  const value = await generateSnowflakeId();
  if (!isValidSnowflakeId(value))
    throw new Error('Invalid generated User/fixture ID');
  return value;
}
async function insert(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  table: Table,
  statement: string,
  values: string[]
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
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Owned row missing');
    result.push({ table: row.table, ...current });
  }
  return result;
}
const guards: Record<Table, string> = {
  Notification: '',
  DMAcceptance: '',
  ChatParticipant: '',
  GroupMember: '',
  UserBlock: '',
  UserMute: '',
  Chat: ' AND NOT EXISTS(SELECT 1 FROM "Notification" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "MessageReaction" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "DMAcceptance" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "activeChatId"=t.id)',
  Group:
    ' AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "parentGroupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" WHERE "groupId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" WHERE "userId"=t.id OR "actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "DMAcceptance" WHERE "userId"=t.id OR "otherUserId"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "userId"=t.id OR "invitedBy"=t.id OR "addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "userId"=t.id OR "addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "createdBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "ownerId"=t.id OR "createdById"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite" WHERE "invitedUserId"=t.id OR "invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "senderId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserBlock" WHERE "blockerId"=t.id OR "blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute" WHERE "muterId"=t.id OR "mutedId"=t.id)',
};
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Group', 'Chat'] as const)
      for (const row of rows
        .filter((row) => row.table === table)
        .sort((a, b) => a.id.localeCompare(b.id)))
        await tx.unsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [
          row.id,
        ]);
    for (const table of [
      'Notification',
      'DMAcceptance',
      'ChatParticipant',
      'GroupMember',
      'UserBlock',
      'UserMute',
      'Chat',
      'Group',
      'User',
    ] as const)
      for (const row of rows.filter((row) => row.table === table).reverse()) {
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${guards[table]} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error('Owned cleanup refused ' + table);
      }
  });
  rows.length = 0;
}
async function request(
  path = '/api/chats/unread-count',
  label = 'viewer',
  invalid = false
) {
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
async function badge(label = 'viewer', query = '') {
  const response = await request('/api/chats/unread-count' + query, label);
  expect(response.status).toBe(200);
  return badgeSchema.parse(await response.json());
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
    throw new Error('Disposable identity mismatch');
  const planned = new Map<string, string>();
  for (const label of [
    'viewer',
    'visible',
    'muted',
    'blocked',
    'blocker',
    'plain',
    'empty',
    'group',
    'chat',
    'pendingChat',
  ])
    planned.set(label, await fresh());
  const p = (label: string) => {
    const value = planned.get(label);
    if (!value) throw new Error('Missing planned fixture');
    return value;
  };
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    for (const label of [
      'viewer',
      'visible',
      'muted',
      'blocked',
      'blocker',
      'plain',
      'empty',
    ])
      await insert(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","updatedAt") VALUES($1,$2,$3,$4,now())',
        [p(label), 'p1782_' + p(label), run + '-' + label, 'Unread ' + label]
      );
    await insert(
      tx,
      pending,
      'Group',
      'INSERT INTO "Group"(id,name,type,"ownerId","createdById","updatedAt") VALUES($1,$2,\'user\',$3,$3,now())',
      [p('group'), 'Owned unread group', p('visible')]
    );
    await insert(
      tx,
      pending,
      'Chat',
      'INSERT INTO "Chat"(id,name,"isGroup","groupId","updatedAt") VALUES($1,$2,true,$3,now())',
      [p('chat'), 'Owned unread chat', p('group')]
    );
    await insert(
      tx,
      pending,
      'Chat',
      'INSERT INTO "Chat"(id,"updatedAt") VALUES($1,now())',
      [p('pendingChat')]
    );
    for (const label of [
      'viewer',
      'visible',
      'muted',
      'blocked',
      'blocker',
      'plain',
    ]) {
      await insert(
        tx,
        pending,
        'GroupMember',
        'INSERT INTO "GroupMember"(id,"groupId","userId",role) VALUES($1,$2,$3,$4)',
        [
          await fresh(),
          p('group'),
          p(label),
          label === 'visible' ? 'owner' : 'member',
        ]
      );
      await insert(
        tx,
        pending,
        'ChatParticipant',
        'INSERT INTO "ChatParticipant"(id,"chatId","userId") VALUES($1,$2,$3)',
        [await fresh(), p('chat'), p(label)]
      );
    }
    for (const label of ['viewer', 'visible'])
      await insert(
        tx,
        pending,
        'ChatParticipant',
        'INSERT INTO "ChatParticipant"(id,"chatId","userId") VALUES($1,$2,$3)',
        [await fresh(), p('pendingChat'), p(label)]
      );
    await insert(
      tx,
      pending,
      'DMAcceptance',
      'INSERT INTO "DMAcceptance"(id,"chatId","userId","otherUserId",status) VALUES($1,$2,$3,$4,\'pending\')',
      [await fresh(), p('pendingChat'), p('viewer'), p('visible')]
    );
    for (const [from, to] of [
      ['viewer', 'blocked'],
      ['blocker', 'viewer'],
    ] as const)
      await insert(
        tx,
        pending,
        'UserBlock',
        'INSERT INTO "UserBlock"(id,"blockerId","blockedId") VALUES($1,$2,$3)',
        [await fresh(), p(from), p(to)]
      );
    await insert(
      tx,
      pending,
      'UserMute',
      'INSERT INTO "UserMute"(id,"muterId","mutedId") VALUES($1,$2,$3)',
      [await fresh(), p('viewer'), p('muted')]
    );
    const notify = async (
      recipient: string,
      actor: string | null,
      read: boolean,
      withChat = true
    ) =>
      insert(
        tx,
        pending,
        'Notification',
        `INSERT INTO "Notification"(id,"userId",type,"actorId","chatId",title,message,read) VALUES($1,$2,'system',${actor ? '$3' : 'NULL'},${withChat ? (actor ? '$4' : '$3') : 'NULL'},'Owned unread','Owned unread',${read})`,
        [
          await fresh(),
          p(recipient),
          ...(actor ? [p(actor)] : []),
          ...(withChat ? [p('chat')] : []),
        ]
      );
    for (const actor of [
      'visible',
      'visible',
      'muted',
      'muted',
      'muted',
      'blocked',
      'blocker',
    ])
      await notify('viewer', actor, false);
    await notify('viewer', null, false);
    await notify('viewer', 'visible', true);
    await notify('viewer', 'visible', false, false);
    await notify('plain', 'visible', false);
    await notify('plain', 'muted', false);
  });
  main.push(...pending);
  fixtures.push(main);
  for (const [label, value] of planned) ids.set(label, value);
  for (const label of ['viewer', 'plain', 'empty'])
    tokens.set(label, await createStewardTestToken(run + '-' + label));
});
afterAll(async () => {
  const failures: Error[] = [];
  try {
    for (const rows of [...fixtures].reverse()) {
      try {
        await cleanup(rows);
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
    throw new AggregateError(failures, 'Owned unread fixtures retained');
}, 20000);

describe('GET /api/chats/unread-count moderation', () => {
  it('counts only the unread chat notifications the viewer can see', async () => {
    const body = await badge();
    expect(body.unreadMessages).toBe(3);
    expect(body.pendingDMRequests).toBe(1);
    expect(body.pendingDMs).toBe(4);
    expect(body.hasNewMessages).toBe(true);
  });
  it('keeps the raw count for a viewer with no moderation relations', async () => {
    const body = await badge('plain');
    expect(body.unreadMessages).toBe(2);
    expect(body.pendingDMRequests).toBe(0);
    expect(body.pendingDMs).toBe(2);
  });
  it('keeps null-actor system rows while excluding read and non-chat controls without writes', async () => {
    const before = await physical(main);
    expect(await badge()).toEqual({
      pendingDMs: 4,
      pendingDMRequests: 1,
      unreadMessages: 3,
      hasNewMessages: true,
    });
    expect(await physical(main)).toEqual(before);
  });
  it('binds both counts to the normal authenticated viewer rather than supplied user IDs', async () => {
    expect(
      (await badge('plain', '?userId=' + id('viewer'))).unreadMessages
    ).toBe(2);
    expect(await badge('empty', '?userId=' + id('viewer'))).toEqual({
      pendingDMs: 0,
      pendingDMRequests: 0,
      unreadMessages: 0,
      hasNewMessages: false,
    });
  });
  it('rejects missing and invalid normal authentication', async () => {
    for (const [label, invalid] of [
      ['anonymous', false],
      ['viewer', true],
    ] as const) {
      const response = await request('/api/chats/unread-count', label, invalid);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  });
  it('agrees with the visible unread chat subset of the existing notification list', async () => {
    const response = await request('/api/notifications?limit=100');
    expect(response.status).toBe(200);
    const result = z
      .object({
        notifications: z.array(
          z.object({
            id: z.string(),
            read: z.boolean(),
            chatId: z.string().nullable(),
          })
        ),
        unreadCount: z.number(),
      })
      .parse(await response.json());
    expect(result.unreadCount).toBe(4);
    expect(
      result.notifications.filter((row) => !row.read && row.chatId !== null)
    ).toHaveLength(3);
    expect((await badge()).unreadMessages).toBe(
      result.notifications.filter((row) => !row.read && row.chatId !== null)
        .length
    );
  });
  it('does not acquire failed setup or delete foreign notifications and refuses unexplained User drift atomically', async () => {
    const before = await physical(main),
      failed: Receipt[] = [],
      newUser = await fresh();
    await expect(
      control.begin(async (tx) => {
        await insert(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [newUser, 'p1782_' + newUser]
        );
        await insert(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [id('viewer'), 'p1782_collision_' + newUser]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    expect(
      await control`SELECT id FROM "User" WHERE id=${newUser}`
    ).toHaveLength(0);
    expect(await physical(main)).toEqual(before);
    const pending: Receipt[] = [],
      own: Receipt[] = [];
    const user = await fresh();
    await control.begin(async (tx) => {
      await insert(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
        [user, 'p1782_' + user]
      );
      await insert(
        tx,
        pending,
        'Notification',
        "INSERT INTO \"Notification\"(id,\"userId\",type,title,message) VALUES($1,$2,'system','Owned','Owned')",
        [await fresh(), user]
      );
    });
    own.push(...pending);
    fixtures.push(own);
    const extra: Receipt[] = [],
      foreign: Receipt[] = [];
    await control.begin(async (tx) => {
      await insert(
        tx,
        extra,
        'Notification',
        "INSERT INTO \"Notification\"(id,\"userId\",type,title,message) VALUES($1,$2,'system','Foreign owned control','Foreign')",
        [await fresh(), user]
      );
    });
    foreign.push(...extra);
    fixtures.push(foreign);
    const original = await physical(own),
      foreignBefore = await physical(foreign);
    try {
      await expect(cleanup(own)).rejects.toThrow('Owned cleanup refused User');
      expect(await physical(own)).toEqual(original);
      expect(await physical(foreign)).toEqual(foreignBefore);
    } finally {
      await cleanup(foreign);
    }
    const receipt = own.find((row) => row.table === 'User');
    if (!receipt) throw new Error('Missing owned User');
    const changed = await control<
      Physical[]
    >`UPDATE "User" t SET bio='p1782 unrelated drift' WHERE id=${user} AND to_jsonb(t)=${receipt.canonical}::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical`;
    expect(changed).toHaveLength(1);
    try {
      await expect(cleanup(own)).rejects.toThrow('Owned cleanup refused User');
      expect(await physical(own.filter((row) => row.table !== 'User'))).toEqual(
        original.filter((row) => row.table !== 'User')
      );
    } finally {
      const drift = changed[0];
      if (!drift) throw new Error('Missing drift receipt');
      expect(
        await control`UPDATE "User" t SET bio=(${receipt.canonical}::text::jsonb->>'bio') WHERE id=${user} AND to_jsonb(t)=${drift.canonical}::text::jsonb RETURNING id`
      ).toHaveLength(1);
    }
    await cleanup(own);
    expect(await physical(main)).toEqual(before);
  });
});
