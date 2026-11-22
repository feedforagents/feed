/** PRD §§8.2/12, MVP Phase 5: real authenticated, group-only history moderation. */
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
  | 'Message'
  | 'UserBlock'
  | 'UserMute'
  | 'MessageReaction';
type Receipt = { table: Table; id: string; canonical: string };
type Physical = { id: string; canonical: string };
const fixtures: Receipt[][] = [];
const main: Receipt[] = [];
const tokens = new Map<string, string>();
const ids = new Map<string, string>();
const nonce = randomUUID();
const pageSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      senderId: z.string(),
      content: z.string(),
      replyToMessage: z
        .object({ id: z.string(), content: z.string() })
        .nullable(),
    })
  ),
  pagination: z.object({
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    limit: z.number(),
  }),
});
function id(label: string) {
  const value = ids.get(label);
  if (!value) throw new Error(`Missing acquired fixture ${label}`);
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
  values: string[]
) {
  const inserted = await tx.unsafe<Physical[]>(
    `${statement} RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of inserted) rows.push({ table, ...row });
  if (inserted.length !== 1)
    throw new Error(`Fixture acquisition failed ${table}`);
}
async function request(
  chat: string,
  query: Record<string, string> = {},
  label = 'viewer',
  anonymous = false
) {
  const token = tokens.get(label);
  if (!anonymous && !token)
    throw new Error('Missing normal Steward fixture token');
  return fetch(`${base}/api/chats/${chat}?${new URLSearchParams(query)}`, {
    headers: anonymous ? {} : { authorization: `Bearer ${token}` },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function page(chat: string, query: Record<string, string> = {}) {
  const response = await request(chat, query);
  expect(response.status).toBe(200);
  return pageSchema.parse(await response.json());
}
async function physical(rows: Receipt[]) {
  const current: Receipt[] = [];
  for (const row of rows) {
    const result = await control.unsafe<Physical[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (result.length !== 1 || !result[0])
      throw new Error('Owned fixture row missing');
    current.push({ table: row.table, ...result[0] });
  }
  return current;
}
const guards: Record<Table, string> = {
  MessageReaction: '',
  UserBlock: '',
  UserMute: '',
  ChatParticipant: '',
  GroupMember: '',
  Message:
    ' AND NOT EXISTS(SELECT 1 FROM "MessageReaction" WHERE "messageId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "replyToMessageId"=t.id)',
  Chat: ' AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "MessageReaction" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "DMAcceptance" WHERE "chatId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "activeChatId"=t.id)',
  Group:
    ' AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite" WHERE "groupId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "parentGroupId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" WHERE "userId"=t.id OR "grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" WHERE "updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" WHERE "userId"=t.id OR "invitedBy"=t.id OR "addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember" WHERE "userId"=t.id OR "addedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Chat" WHERE "createdBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "Group" WHERE "ownerId"=t.id OR "createdById"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupInvite" WHERE "invitedUserId"=t.id OR "invitedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Message" WHERE "senderId"=t.id) AND NOT EXISTS(SELECT 1 FROM "MessageReaction" WHERE "userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserBlock" WHERE "blockerId"=t.id OR "blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute" WHERE "muterId"=t.id OR "mutedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "DMAcceptance" WHERE "userId"=t.id OR "otherUserId"=t.id)',
};
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    // Lock parents first; the following statements see committed FK writers.
    for (const table of ['User', 'Group', 'Chat', 'Message'] as const)
      for (const row of rows
        .filter((row) => row.table === table)
        .sort((a, b) => a.id.localeCompare(b.id)))
        await tx.unsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [
          row.id,
        ]);
    // Replies are inserted after their parents, so reverse acquisition order.
    for (const table of [
      'MessageReaction',
      'Message',
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
          throw new Error(`Owned cleanup refused ${table}`);
      }
  });
  rows.length = 0;
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
  const planned = new Map<string, string>();
  for (const label of [
    'viewer',
    'blocked',
    'muted',
    'blockedBy',
    'normal',
    'inactive',
    'outsider',
    'group',
    'main',
    'dm',
    'ties',
    'quotes',
    'normal1',
    'blocked1',
    'muted1',
    'blockedBy1',
    'viewer1',
    'system1',
    'normal2',
    'dm1',
    'tie0',
    'tieHidden0',
    'tie1',
    'tie2',
    'tie3',
    'tieHidden1',
    'tie4',
    'quoteBlocked',
    'quoteMuted',
    'quoteBlockedBy',
    'quoteVisible',
    'replyBlocked',
    'replyMuted',
    'replyBlockedBy',
    'replyVisible',
    'replyForeign',
  ])
    planned.set(label, await fresh());
  const p = (label: string) => {
    const value = planned.get(label);
    if (!value) throw new Error('Missing planned ID');
    return value;
  };
  await control.begin(async (tx) => {
    for (const label of [
      'viewer',
      'blocked',
      'muted',
      'blockedBy',
      'normal',
      'inactive',
      'outsider',
    ])
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","updatedAt") VALUES($1,$2,$3,$4,now())',
        [
          p(label),
          `p1710_${p(label)}`,
          `${nonce}-${label}`,
          `Moderation ${label}`,
        ]
      );
    await acquire(
      tx,
      pending,
      'Group',
      'INSERT INTO "Group"(id,name,type,"ownerId","createdById","updatedAt") VALUES($1,$2,\'user\',$3,$3,now())',
      [p('group'), 'Owned viewer moderation', p('viewer')]
    );
    for (const label of ['main', 'ties', 'quotes', 'dm'])
      await acquire(
        tx,
        pending,
        'Chat',
        `INSERT INTO "Chat"(id,name,"isGroup","groupId","updatedAt") VALUES($1,$2,${label !== 'dm'},${label === 'dm' ? 'NULL' : '$3'},now())`,
        label === 'dm'
          ? [p(label), 'Owned moderation DM']
          : [p(label), 'Owned moderation group', p('group')]
      );
    for (const label of [
      'viewer',
      'blocked',
      'muted',
      'blockedBy',
      'normal',
      'inactive',
    ]) {
      await acquire(
        tx,
        pending,
        'GroupMember',
        `INSERT INTO "GroupMember"(id,"groupId","userId",role,"isActive") VALUES($1,$2,$3,$4,${label !== 'inactive'})`,
        [
          await fresh(),
          p('group'),
          p(label),
          label === 'viewer' ? 'owner' : 'member',
        ]
      );
      for (const chat of ['main', 'ties', 'quotes'])
        await acquire(
          tx,
          pending,
          'ChatParticipant',
          `INSERT INTO "ChatParticipant"(id,"chatId","userId","isActive") VALUES($1,$2,$3,${label !== 'inactive'})`,
          [await fresh(), p(chat), p(label)]
        );
    }
    for (const label of ['viewer', 'blocked'])
      await acquire(
        tx,
        pending,
        'ChatParticipant',
        'INSERT INTO "ChatParticipant"(id,"chatId","userId") VALUES($1,$2,$3)',
        [await fresh(), p('dm'), p(label)]
      );
    for (const [from, to] of [
      ['viewer', 'blocked'],
      ['blockedBy', 'viewer'],
    ] as const)
      await acquire(
        tx,
        pending,
        'UserBlock',
        'INSERT INTO "UserBlock"(id,"blockerId","blockedId") VALUES($1,$2,$3)',
        [await fresh(), p(from), p(to)]
      );
    await acquire(
      tx,
      pending,
      'UserMute',
      'INSERT INTO "UserMute"(id,"muterId","mutedId") VALUES($1,$2,$3)',
      [await fresh(), p('viewer'), p('muted')]
    );
    const message = async (
      label: string,
      chat: string,
      sender: string,
      stamp: string,
      reply?: string
    ) =>
      acquire(
        tx,
        pending,
        'Message',
        `INSERT INTO "Message"(id,"chatId","senderId",content,type,"createdAt","replyToMessageId") VALUES($1,$2,$3,$4,${sender === 'system' ? "'system'" : "'user'"},$5::text::timestamp,${reply ? '$6' : 'NULL'})`,
        [
          p(label),
          p(chat),
          sender === 'system' ? 'system' : p(sender),
          `Owned ${label}`,
          stamp,
          ...(reply ? [p(reply)] : []),
        ]
      );
    for (const [index, [label, sender]] of (
      [
        ['normal1', 'normal'],
        ['blocked1', 'blocked'],
        ['muted1', 'muted'],
        ['blockedBy1', 'blockedBy'],
        ['viewer1', 'viewer'],
        ['system1', 'system'],
        ['normal2', 'normal'],
      ] as const
    ).entries())
      await message(
        label,
        'main',
        sender,
        `2026-01-01 00:0${index + 1}:00.000000`,
        label === 'normal2' ? 'blocked1' : undefined
      );
    await message('dm1', 'dm', 'blocked', '2026-01-01 00:08:00.000000');
    for (const [label, sender, micros] of [
      ['tie0', 'normal', '122999'],
      ['tieHidden0', 'blocked', '123100'],
      ['tie1', 'normal', '123456'],
      ['tie2', 'viewer', '123456'],
      ['tie3', 'system', '123789'],
      ['tieHidden1', 'muted', '123999'],
      ['tie4', 'normal', '124001'],
    ] as const)
      await message(label, 'ties', sender, `2026-01-01 00:00:00.${micros}`);
    for (const [label, sender] of [
      ['quoteBlocked', 'blocked'],
      ['quoteMuted', 'muted'],
      ['quoteBlockedBy', 'blockedBy'],
      ['quoteVisible', 'normal'],
    ] as const)
      await message(label, 'quotes', sender, '2026-01-02 00:00:00.000001');
    for (const [label, reply] of [
      ['replyBlocked', 'quoteBlocked'],
      ['replyMuted', 'quoteMuted'],
      ['replyBlockedBy', 'quoteBlockedBy'],
      ['replyVisible', 'quoteVisible'],
      ['replyForeign', 'dm1'],
    ] as const)
      await message(
        label,
        'quotes',
        'normal',
        '2026-01-02 00:00:00.000002',
        reply
      );
  });
  // Publish ownership only after the complete setup transaction commits.
  main.push(...pending);
  fixtures.push(main);
  for (const [label, value] of planned) ids.set(label, value);
  for (const label of ['viewer', 'normal', 'inactive', 'outsider'])
    tokens.set(label, await createStewardTestToken(`${nonce}-${label}`));
});
afterAll(async () => {
  const failures: Error[] = [];
  try {
    for (const fixture of [...fixtures].reverse()) {
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
    throw new AggregateError(failures, 'Owned moderation fixtures retained');
}, 20000);

describe('GET /api/chats/[id] group chat viewer moderation', () => {
  it('hides blocked, muted, and blocked-by authors from the group message list', async () => {
    const result = await page(id('main'));
    expect(result.messages.map((row) => row.id)).toEqual(
      ['normal1', 'viewer1', 'system1', 'normal2'].map(id)
    );
    for (const hidden of ['blocked', 'muted', 'blockedBy'])
      expect(result.messages.some((row) => row.senderId === id(hidden))).toBe(
        false
      );
  });
  it('does not leak a hidden message back through a reply quote', async () => {
    const result = await page(id('main'));
    const reply = result.messages.find((row) => row.id === id('normal2'));
    expect(reply).toBeDefined();
    expect(reply?.replyToMessage).toBeNull();
  });
  it('pages through only the visible messages', async () => {
    const first = await page(id('main'), { limit: '2' });
    expect(first.messages.map((row) => row.id)).toEqual(
      ['system1', 'normal2'].map(id)
    );
    expect(first.pagination.hasMore).toBe(true);
    expect(first.pagination.nextCursor).toBe(id('system1'));
    const second = await page(id('main'), {
      cursor: id('system1'),
      limit: '2',
    });
    expect(second.messages.map((row) => row.id)).toEqual(
      ['normal1', 'viewer1'].map(id)
    );
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
  });
  it('leaves DM history untouched (separate surface)', async () => {
    expect((await page(id('dm'))).messages.map((row) => row.id)).toEqual([
      id('dm1'),
    ]);
    expect(
      (
        await page(id('dm'), { after: '2026-01-01T00:00:00.000Z' })
      ).messages.map((row) => row.id)
    ).toEqual([id('dm1')]);
  });
  it('filters after sync before its limit at stored microsecond precision', async () => {
    const query = { after: '2026-01-01T00:00:00.123Z', limit: '2' };
    const limited = await page(id('ties'), query);
    expect(limited.messages.map((row) => row.id)).toEqual(
      ['tie1', 'tie2'].map(id).sort()
    );
    expect(limited.pagination.hasMore).toBe(true);
    const full = await page(id('ties'), { ...query, limit: '100' });
    expect(full.messages.map((row) => row.id)).toEqual([
      ...['tie1', 'tie2'].map(id).sort(),
      id('tie3'),
      id('tie4'),
    ]);
    expect(full.pagination.hasMore).toBe(false);
  });
  it('walks filtered same-timestamp and neighboring microsecond rows exactly once', async () => {
    const stored = await control<
      { id: string; stamp: string }[]
    >`SELECT id,to_char("createdAt",'YYYY-MM-DD HH24:MI:SS.US') AS stamp FROM "Message" WHERE "chatId"=${id('ties')} ORDER BY "createdAt",id`;
    expect(stored.filter((row) => row.stamp.endsWith('.123456'))).toHaveLength(
      2
    );
    const expected = [
      id('tie0'),
      ...['tie1', 'tie2'].map(id).sort(),
      id('tie3'),
      id('tie4'),
    ].reverse();
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let offset = 0; offset < expected.length; offset += limit) {
        const result = await page(id('ties'), {
          limit: String(limit),
          ...(cursor ? { cursor } : {}),
        });
        const part = expected.slice(offset, offset + limit);
        expect(result.messages.map((row) => row.id)).toEqual(
          [...part].reverse()
        );
        seen.push(...result.messages.map((row) => row.id));
        expect(result.pagination.hasMore).toBe(
          offset + part.length < expected.length
        );
        expect(result.pagination.nextCursor).toBe(
          offset + part.length < expected.length ? (part.at(-1) ?? null) : null
        );
        cursor = result.pagination.nextCursor ?? undefined;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(expected));
    }
  });
  it('hides all three moderated quote types but retains local visible enrichment and same-chat scope', async () => {
    const result = await page(id('quotes'));
    for (const label of [
      'replyBlocked',
      'replyMuted',
      'replyBlockedBy',
      'replyForeign',
    ]) {
      const reply = result.messages.find((row) => row.id === id(label));
      expect(reply).toBeDefined();
      expect(reply?.replyToMessage).toBeNull();
    }
    expect(
      result.messages.find((row) => row.id === id('replyVisible'))
        ?.replyToMessage
    ).toMatchObject({ id: id('quoteVisible'), content: 'Owned quoteVisible' });
  });
  it('requires normal authentication and active chat membership', async () => {
    const anonymous = await request(id('main'), {}, 'viewer', true);
    expect(anonymous.status).toBe(401);
    await anonymous.arrayBuffer();
    for (const label of ['inactive', 'outsider']) {
      const denied = await request(
        id('main'),
        { cursor: id('normal1') },
        label
      );
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();
    }
    const member = await request(id('main'), {}, 'normal');
    expect(member.status).toBe(200);
    await member.arrayBuffer();
  });
  it('rejects foreign cursors and malformed history queries without leaking other chats', async () => {
    const invalidQueries: Array<Record<string, string>> = [
      { cursor: id('dm1') },
      { cursor: await fresh() },
      { cursor: id('normal1'), after: '2026-01-01T00:00:00.123Z' },
      { after: 'invalid' },
      { limit: '0' },
    ];
    for (const query of invalidQueries) {
      const response = await request(id('main'), query);
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
  });
  it('owns only committed setup and refuses foreign reactions or unexplained physical drift atomically', async () => {
    const failed: Receipt[] = [];
    const newUser = await fresh();
    const before = await physical(main);
    await expect(
      control.begin(async (tx) => {
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [newUser, `p1710_${newUser}`]
        );
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
          [id('viewer'), `p1710_collision_${newUser}`]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    // Failed RETURNING receipts are transaction-local and never enter cleanup.
    expect(
      await control`SELECT id FROM "User" WHERE id=${newUser}`
    ).toHaveLength(0);
    expect(await physical(main)).toEqual(before);
    const own: Receipt[] = [];
    const pending: Receipt[] = [];
    const user = await fresh(),
      chat = await fresh(),
      message = await fresh();
    await control.begin(async (tx) => {
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
        [user, `p1710_${user}`]
      );
      await acquire(
        tx,
        pending,
        'Chat',
        'INSERT INTO "Chat"(id,"updatedAt") VALUES($1,now())',
        [chat]
      );
      await acquire(
        tx,
        pending,
        'Message',
        'INSERT INTO "Message"(id,"chatId","senderId",content) VALUES($1,$2,$3,$4)',
        [message, chat, user, 'Owned cleanup control']
      );
    });
    own.push(...pending);
    fixtures.push(own);
    const foreign: Receipt[] = [],
      pendingForeign: Receipt[] = [];
    await control.begin(async (tx) => {
      await acquire(
        tx,
        pendingForeign,
        'MessageReaction',
        'INSERT INTO "MessageReaction"(id,"chatId","messageId","userId",emoji) VALUES($1,$2,$3,$4,$5)',
        [await fresh(), chat, message, id('viewer'), '👀']
      );
    });
    foreign.push(...pendingForeign);
    fixtures.push(foreign);
    const original = await physical(own),
      foreignBefore = await physical(foreign);
    try {
      await expect(cleanup(own)).rejects.toThrow(
        'Owned cleanup refused Message'
      );
      expect(await physical(own)).toEqual(original);
      expect(await physical(foreign)).toEqual(foreignBefore);
    } finally {
      await cleanup(foreign);
    }
    const userReceipt = own.find((row) => row.table === 'User');
    if (!userReceipt) throw new Error('Missing owned User receipt');
    const changed = await control<
      Physical[]
    >`UPDATE "User" t SET bio='p1710 unrelated drift' WHERE id=${user} AND to_jsonb(t)=${userReceipt.canonical}::text::jsonb RETURNING id,to_jsonb(t)::text AS canonical`;
    expect(changed).toHaveLength(1);
    try {
      await expect(cleanup(own)).rejects.toThrow('Owned cleanup refused User');
      expect(await physical(own.filter((row) => row.table !== 'User'))).toEqual(
        original.filter((row) => row.table !== 'User')
      );
    } finally {
      const changedRow = changed[0];
      if (!changedRow) throw new Error('Missing drift receipt');
      const restored =
        await control`UPDATE "User" t SET bio=(${userReceipt.canonical}::text::jsonb->>'bio') WHERE id=${user} AND to_jsonb(t)=${changedRow.canonical}::text::jsonb RETURNING id`;
      expect(restored).toHaveLength(1);
    }
    await cleanup(own);
    expect(await physical(main)).toEqual(before);
  });
});
