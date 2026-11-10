/** PRD §§8.2/12, MVP Phase 5: retained DM/group history at exact stored precision. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  closeDatabase,
  dbWrite as db,
  eq,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { requireServer, waitForServerAvailability } from './helpers';
import { createStewardTestToken } from './helpers/steward-auth';

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const databaseUrl = process.env.DATABASE_URL ?? '';
const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 2,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
const owned = {
  users: new Set<string>(),
  chats: new Set<string>(),
  participants: new Set<string>(),
  messages: new Set<string>(),
};
const userIds = new Map<string, string>();
const tokens = new Map<string, string>();
const pageSchema = z.object({
  chat: z.object({ id: z.string(), isGroup: z.boolean() }),
  messages: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      createdAt: z.string(),
      replyToMessageId: z.string().nullable(),
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
function user(label: string) {
  const id = userIds.get(label);
  if (!id) throw new Error('Missing owned user');
  return id;
}
function auth(label = 'viewer') {
  const token = tokens.get(label);
  if (!token) throw new Error('Missing owned token');
  return { authorization: `Bearer ${token}` };
}
async function request(
  id: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = auth()
) {
  const params = new URLSearchParams(query);
  return fetch(`${base}/api/chats/${id}?${params}`, {
    headers,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}
async function page(
  id: string,
  query: Record<string, string> = {},
  label = 'viewer'
) {
  const response = await request(id, query, auth(label));
  expect(response.status).toBe(200);
  return pageSchema.parse(await response.json());
}
async function acquireUsers(
  values: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  for (const row of rows) ownership.add(row.id);
}
async function acquireChat(
  id: string,
  isGroup = true,
  ownership = owned.chats
) {
  const rows = await db
    .insert(chats)
    .values({
      id,
      name: 'Owned chat cursor regression',
      isGroup,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: chats.id });
  for (const row of rows) ownership.add(row.id);
}
async function fixture(isGroup = true) {
  const id = await generateSnowflakeId();
  await acquireChat(id, isGroup);
  const values: Array<typeof chatParticipants.$inferInsert> = [];
  for (const [label, active] of [
    ['viewer', true],
    ['peer', true],
    ['inactive', false],
  ] as const)
    values.push({
      id: await generateSnowflakeId(),
      chatId: id,
      userId: user(label),
      isActive: active,
    });
  const rows = await db
    .insert(chatParticipants)
    .values(values)
    .returning({ id: chatParticipants.id });
  for (const row of rows) owned.participants.add(row.id);
  return id;
}
async function exactMessages(chatId: string, stamps: string[]) {
  const acquired: string[] = [];
  for (const [index, stamp] of stamps.entries()) {
    const id = await generateSnowflakeId();
    const rows = await control.unsafe<{ id: string; stamp: string }[]>(
      'INSERT INTO "Message"(id,"chatId","senderId",content,"createdAt") VALUES($1,$2,$3,$4,$5::text::timestamp without time zone) RETURNING id,to_char("createdAt",\'YYYY-MM-DD HH24:MI:SS.US\') AS stamp',
      [id, chatId, user('peer'), `Owned chat cursor message ${index}`, stamp]
    );
    for (const row of rows) {
      owned.messages.add(row.id);
      acquired.push(row.id);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stamp).toBe(stamp);
  }
  return acquired;
}
async function defaultMessages(chatId: string, count: number) {
  const values: Array<typeof messages.$inferInsert> = [];
  for (let index = 0; index < count; index++)
    values.push({
      id: await generateSnowflakeId(),
      chatId,
      senderId: user('peer'),
      content: `Owned default-now message ${index}`,
    });
  const rows = await db
    .insert(messages)
    .values(values)
    .returning({ id: messages.id });
  for (const row of rows) owned.messages.add(row.id);
  return rows.map((row) => row.id);
}
async function ordered(chatId: string, direction: 'ASC' | 'DESC' = 'DESC') {
  return [
    ...(await control.unsafe<{ id: string; stamp: string }[]>(
      `SELECT id,"createdAt"::text AS stamp FROM "Message" WHERE "chatId"=$1 ORDER BY "createdAt" ${direction},id ${direction}`,
      [chatId]
    )),
  ];
}
async function walk(
  chatId: string,
  limit: number,
  expected: string[],
  initialCursor?: string
) {
  const seen: string[] = [];
  let cursor = initialCursor;
  for (let number = 0; number <= expected.length + 1; number++) {
    const result = await page(chatId, {
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
    const part = expected.slice(seen.length, seen.length + limit);
    expect(result.messages.map((row) => row.id)).toEqual([...part].reverse());
    expect(result.pagination.limit).toBe(limit);
    const hasMore = seen.length + part.length < expected.length;
    expect(result.pagination.hasMore).toBe(hasMore);
    seen.push(...result.messages.map((row) => row.id));
    if (!hasMore) {
      expect(result.pagination.nextCursor).toBeNull();
      break;
    }
    const lastId = part[part.length - 1];
    if (lastId === undefined) throw new Error('Missing expected page cursor');
    expect(result.pagination.nextCursor).toBe(lastId);
    cursor = result.pagination.nextCursor ?? undefined;
  }
  expect(seen.length).toBe(expected.length);
  expect(new Set(seen).size).toBe(expected.length);
  expect(new Set(seen)).toEqual(new Set(expected));
  return seen;
}
beforeAll(async () => {
  const url = new URL(databaseUrl);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  expect(url.pathname).toMatch(/^\/(test_db|feed_pr\d+)$/);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(base).hostname);
  requireServer(await waitForServerAvailability(base, 10), base);
  const values: Array<typeof users.$inferInsert> = [];
  for (const label of ['viewer', 'peer', 'inactive', 'outsider']) {
    const id = await generateSnowflakeId();
    userIds.set(label, id);
    values.push({
      id,
      username: `p1690_${id}`,
      stewardId: `p1690-${id}`,
      displayName: `Cursor ${label}`,
      updatedAt: new Date(),
    });
  }
  await acquireUsers(values);
  for (const [label, id] of userIds)
    tokens.set(label, await createStewardTestToken(`p1690-${id}`));
});
async function remove(
  table: 'Message' | 'ChatParticipant' | 'Chat' | 'User',
  ids: Set<string>
) {
  if (!ids.size) return;
  const before = await control.unsafe<{ id: string }[]>(
    `SELECT id FROM "${table}" WHERE id=ANY($1::text[])`,
    [[...ids]]
  );
  const removed = await control.unsafe<{ id: string }[]>(
    `DELETE FROM "${table}" WHERE id=ANY($1::text[]) RETURNING id`,
    [[...ids]]
  );
  expect(new Set(removed.map((row) => row.id))).toEqual(
    new Set(before.map((row) => row.id))
  );
  expect(removed).toHaveLength(ids.size);
  expect(
    await control.unsafe(`SELECT id FROM "${table}" WHERE id=ANY($1::text[])`, [
      [...ids],
    ])
  ).toHaveLength(0);
}
afterAll(async () => {
  try {
    await remove('Message', owned.messages);
    await remove('ChatParticipant', owned.participants);
    await remove('Chat', owned.chats);
    await remove('User', owned.users);
  } finally {
    await Promise.all([control.end({ timeout: 2 }), closeDatabase()]);
  }
});

describe('native authenticated chat-history cursor', () => {
  it('keeps normal authentication and active-member authorization', async () => {
    const id = await fixture();
    await exactMessages(id, ['2026-01-01 00:00:00.123456']);
    const deniedHeaders: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer invalid-owned-token' },
    ];
    for (const headers of deniedHeaders) {
      const response = await request(id, {}, headers);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    for (const label of ['inactive', 'outsider']) {
      const response = await request(
        id,
        { cursor: 'unknown-owned-cursor' },
        auth(label)
      );
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect((await page(id, {}, 'peer')).messages).toHaveLength(1);
  });
  it('walks millisecond ties once at page sizes one and three', async () => {
    const id = await fixture();
    await exactMessages(id, [
      '2026-01-01 00:00:00.120000',
      '2026-01-01 00:00:00.121000',
      '2026-01-01 00:00:00.122000',
      '2026-01-01 00:00:00.122000',
      '2026-01-01 00:00:00.122000',
      '2026-01-01 00:00:00.123000',
      '2026-01-01 00:00:00.124000',
    ]);
    const expected = (await ordered(id)).map((row) => row.id);
    await walk(id, 1, expected);
    await walk(id, 3, expected);
  });
  it('walks full microsecond ties and neighboring sub-millisecond positions in a DM', async () => {
    const id = await fixture(false);
    await exactMessages(id, [
      '2026-01-01 00:00:00.122999',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123789',
      '2026-01-01 00:00:00.124001',
      '2026-01-01 00:00:00.124001',
      '2026-01-01 00:00:00.125001',
    ]);
    const stored = await ordered(id);
    expect(stored.some((row) => row.stamp.endsWith('.123456'))).toBe(true);
    for (const limit of [1, 2, 4])
      await walk(
        id,
        limit,
        stored.map((row) => row.id)
      );
  });
  it('walks real database-default NOW rows without assuming millisecond storage', async () => {
    const id = await fixture();
    const inserted = await defaultMessages(id, 5);
    const stored = await ordered(id);
    expect(new Set(stored.map((row) => row.stamp)).size).toBe(1);
    expect(new Set(stored.map((row) => row.id))).toEqual(new Set(inserted));
    const [type] = await control<
      { type: number }[]
    >`SELECT atttypid::int AS type FROM pg_attribute WHERE attrelid='"Message"'::regclass AND attname='createdAt'`;
    expect(type?.type).toBe(1114);
    console.log(
      'CHAT_CURSOR_DATABASE_DEFAULT',
      JSON.stringify({
        timestamp: stored[0]?.stamp,
        count: stored.length,
        typeOid: type?.type,
      })
    );
    for (const limit of [1, 3])
      await walk(
        id,
        limit,
        stored.map((row) => row.id)
      );
  });
  it('rejects unknown and other-chat cursors and malformed query combinations', async () => {
    const id = await fixture();
    const other = await fixture(false);
    const [foreign] = await exactMessages(other, [
      '2026-01-01 00:00:00.123456',
    ]);
    const invalidQueries: Array<Record<string, string>> = [
      { cursor: await generateSnowflakeId() },
      { cursor: foreign! },
      { cursor: '' },
      { limit: '0' },
      { limit: '101' },
      { after: 'invalid' },
      { cursor: foreign!, after: '2026-01-01T00:00:00.123Z' },
    ];
    for (const query of invalidQueries) {
      const response = await request(id, query);
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
  });
  it('keeps a new arrival outside an already anchored older walk', async () => {
    const id = await fixture();
    await exactMessages(id, [
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123789',
      '2026-01-01 00:00:00.124001',
      '2026-01-01 00:00:00.125001',
    ]);
    const original = (await ordered(id)).map((row) => row.id);
    const first = await page(id, { limit: '2' });
    expect(first.messages.map((row) => row.id)).toEqual(
      original.slice(0, 2).reverse()
    );
    const [arrived] = await defaultMessages(id, 1);
    const rest = await walk(
      id,
      2,
      original.slice(2),
      first.pagination.nextCursor!
    );
    expect(new Set([...first.messages.map((row) => row.id), ...rest])).toEqual(
      new Set(original)
    );
    expect(rest).not.toContain(arrived);
    expect((await page(id, { limit: '2' })).messages.at(-1)?.id).toBe(arrived);
  });
  it('preserves timestamp-only after filtering and ascending response order', async () => {
    const id = await fixture();
    const inserted = await exactMessages(id, [
      '2026-01-01 00:00:00.122999',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.123456',
      '2026-01-01 00:00:00.124001',
    ]);
    const expected = (await ordered(id, 'ASC'))
      .filter((row) => row.id !== inserted[0])
      .map((row) => row.id);
    const result = await page(id, {
      after: '2026-01-01T00:00:00.123Z',
      limit: '100',
    });
    expect(result.messages.map((row) => row.id)).toEqual(expected);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    const limited = await page(id, {
      after: '2026-01-01T00:00:00.123Z',
      limit: '2',
    });
    expect(limited.messages.map((row) => row.id)).toEqual(expected.slice(0, 2));
    expect(limited.pagination.hasMore).toBe(true);
  });
  it('retains reply enrichment while excluding other-chat reply contents', async () => {
    const id = await fixture();
    const other = await fixture();
    const [local] = await exactMessages(id, ['2026-01-01 00:00:00.123456']);
    const [foreign] = await exactMessages(other, [
      '2026-01-01 00:00:00.123456',
    ]);
    const ids: string[] = [];
    for (const replyToMessageId of [local!, foreign!]) {
      const added = await db
        .insert(messages)
        .values({
          id: await generateSnowflakeId(),
          chatId: id,
          senderId: user('peer'),
          content: 'Owned reply regression',
          replyToMessageId,
        })
        .returning({ id: messages.id });
      for (const row of added) {
        owned.messages.add(row.id);
        ids.push(row.id);
      }
    }
    const result = await page(id, { limit: '100' });
    expect(
      result.messages.find((row) => row.id === ids[0])?.replyToMessage?.id
    ).toBe(local);
    expect(
      result.messages.find((row) => row.id === ids[1])?.replyToMessage
    ).toBeNull();
  });
  it('does not acquire deletion ownership after duplicate setup fails', async () => {
    const id = await fixture();
    const [existingMessage] = await exactMessages(id, [
      '2026-01-01 00:00:00.123456',
    ]);
    const before = await ordered(id);
    const failedUsers = new Set<string>();
    const failedChats = new Set<string>();
    const failedMessages = new Set<string>();
    const fresh = await generateSnowflakeId();
    await expect(
      acquireUsers(
        [
          { id: fresh, updatedAt: new Date() },
          { id: user('viewer'), updatedAt: new Date() },
        ],
        failedUsers
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(acquireChat(id, true, failedChats)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    const collision = async () => {
      const rows = await db
        .insert(messages)
        .values([
          {
            id: existingMessage!,
            chatId: id,
            senderId: user('peer'),
            content: 'Must not replace',
          },
          {
            id: fresh,
            chatId: id,
            senderId: user('peer'),
            content: 'Must not acquire',
          },
        ])
        .returning({ id: messages.id });
      for (const row of rows) failedMessages.add(row.id);
    };
    await expect(collision()).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    expect(failedUsers.size + failedChats.size + failedMessages.size).toBe(0);
    await remove('User', failedUsers);
    await remove('Chat', failedChats);
    await remove('Message', failedMessages);
    expect(await ordered(id)).toEqual(before);
    expect(
      await db.select().from(users).where(eq(users.id, fresh))
    ).toHaveLength(0);
    expect(
      await db.select().from(messages).where(eq(messages.id, fresh))
    ).toHaveLength(0);
    expect((await page(id)).messages[0]?.id).toBe(existingMessage);
  });
  it('terminates empty and exhausted history without resetting the cursor', async () => {
    const id = await fixture(false);
    const empty = await page(id, { limit: '1' });
    expect(empty.messages).toEqual([]);
    expect(empty.pagination).toEqual({
      hasMore: false,
      nextCursor: null,
      limit: 1,
    });
    const [last] = await exactMessages(id, ['2026-01-01 00:00:00.123456']);
    if (!last) throw new Error('Missing owned history message');
    const single = await page(id, { limit: '1' });
    expect(single.messages.map((row) => row.id)).toEqual([last]);
    expect(single.pagination.hasMore).toBe(false);
    const ended = await page(id, { limit: '1', cursor: last! });
    expect(ended.messages).toEqual([]);
    expect(ended.pagination.hasMore).toBe(false);
    expect(ended.pagination.nextCursor).toBeNull();
  });
});
