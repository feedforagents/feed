/** PRD §12 / MVP phase 5: chronological chat sync at stored DB precision. */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  chatParticipants,
  chats,
  closeDatabase,
  db,
  eq,
  inArray,
  messages,
  type SQL,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { z } from 'zod';

mock.module('server-only', () => ({}));
const pageSchema = z.object({
  messages: z.array(z.object({ id: z.string(), createdAt: z.string() })),
  pagination: z.object({ hasMore: z.boolean() }),
});
type Ownership = {
  users: string[];
  chats: string[];
  participants: string[];
  messages: string[];
};
const ownership = (): Ownership => ({
  users: [],
  chats: [],
  participants: [],
  messages: [],
});
const owned = ownership();
let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;
let viewer: string;
let sender: string;
let token: string;
const baseTime = Date.now() - 6 * 3600_000;

async function addUser(scope = owned, id?: string) {
  const value = id ?? (await generateSnowflakeId());
  const [row] = await db
    .insert(users)
    .values({
      id: value,
      username: `sync-${value}`,
      stewardId: `sync-${value}`,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('User insert returned no row');
  scope.users.push(row.id);
  return row.id;
}
async function addParticipant(
  chatId: string,
  userId: string,
  scope = owned,
  id?: string
) {
  const [row] = await db
    .insert(chatParticipants)
    .values({
      id: id ?? (await generateSnowflakeId()),
      chatId,
      userId,
      isActive: true,
    })
    .returning({ id: chatParticipants.id });
  if (!row) throw new Error('Participant insert returned no row');
  scope.participants.push(row.id);
  return row.id;
}
async function makeChat(scope = owned, participantId?: string) {
  const [row] = await db
    .insert(chats)
    .values({
      id: await generateSnowflakeId(),
      name: 'Sync precision fixture',
      isGroup: true,
      createdBy: viewer,
      updatedAt: new Date(),
    })
    .returning({ id: chats.id });
  if (!row) throw new Error('Chat insert returned no row');
  scope.chats.push(row.id);
  await addParticipant(row.id, viewer, scope, participantId);
  await addParticipant(row.id, sender, scope);
  return row.id;
}
async function addMessage(
  chatId: string,
  createdAt: Date | SQL | undefined,
  scope = owned,
  id?: string
) {
  const [row] = await db
    .insert(messages)
    .values({
      id: id ?? (await generateSnowflakeId()),
      chatId,
      senderId: sender,
      content: 'Sync fixture',
      ...(createdAt === undefined ? {} : { createdAt }),
    })
    .returning({ id: messages.id });
  if (!row) throw new Error('Message insert returned no row');
  scope.messages.push(row.id);
  return row.id;
}
async function cleanup(scope: Ownership) {
  if (scope.messages.length)
    await db.delete(messages).where(inArray(messages.id, scope.messages));
  if (scope.participants.length)
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, scope.participants));
  if (scope.chats.length)
    await db.delete(chats).where(inArray(chats.id, scope.chats));
  if (scope.users.length)
    await db.delete(users).where(inArray(users.id, scope.users));
  if (scope.messages.length)
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(inArray(messages.id, scope.messages))
    ).toEqual([]);
  if (scope.participants.length)
    expect(
      await db
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(inArray(chatParticipants.id, scope.participants))
    ).toEqual([]);
  if (scope.chats.length)
    expect(
      await db
        .select({ id: chats.id })
        .from(chats)
        .where(inArray(chats.id, scope.chats))
    ).toEqual([]);
  if (scope.users.length)
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, scope.users))
    ).toEqual([]);
}
async function request(
  chatId: string,
  query: Record<string, string>,
  credential: string | null = token
) {
  return GET(
    new NextRequest(
      `http://localhost/api/chats/${chatId}?${new URLSearchParams(query)}`,
      { headers: credential ? { authorization: `Bearer ${credential}` } : {} }
    ),
    { params: Promise.resolve({ id: chatId }) }
  );
}
async function walk(
  chatId: string,
  anchor: string,
  time: number,
  limit: number,
  withId = true
) {
  const collected: string[] = [];
  let afterId = anchor;
  for (let page = 0; page < 20; page++) {
    const query = {
      after: new Date(time).toISOString(),
      limit: String(limit),
      ...(withId ? { afterId } : {}),
    };
    const response = await request(chatId, query);
    expect(response.status).toBe(200);
    const body = pageSchema.parse(await response.json());
    for (const row of body.messages) {
      expect(row.id).not.toBe(anchor);
      expect(collected).not.toContain(row.id);
      collected.push(row.id);
    }
    if (!body.pagination.hasMore) return collected;
    const last = body.messages.at(-1);
    if (!last) throw new Error('hasMore without a message');
    time = new Date(last.createdAt).getTime();
    afterId = last.id;
  }
  throw new Error('Sync did not terminate');
}
function postgresCode(error: Error): string | undefined {
  if ('code' in error && typeof error.code === 'string') return error.code;
  if (error.cause instanceof Error) return postgresCode(error.cause);
  return undefined;
}
async function duplicate(action: () => Promise<string>) {
  let code: string | undefined;
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    code = postgresCode(error);
  }
  expect(code).toBe('23505');
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));
  viewer = await addUser();
  sender = await addUser();
  token = await new SignJWT({ userId: `sync-${viewer}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(
      new TextEncoder().encode(
        process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
      )
    );
});
afterAll(async () => {
  try {
    await cleanup(owned);
  } finally {
    await closeDatabase();
  }
});

describe('chat incremental sync (native PostgreSQL, verified JWT)', () => {
  it('walks raw pages through a burst and the watermark millisecond exactly once', async () => {
    const chat = await makeChat();
    const anchor = await addMessage(chat, new Date(baseTime));
    const expected: string[] = [];
    expected.push(await addMessage(chat, new Date(baseTime)));
    for (let i = 0; i < 7; i++)
      expected.push(await addMessage(chat, new Date(baseTime + 1000)));
    expected.push(await addMessage(chat, new Date(baseTime + 2000)));
    expect(await walk(chat, anchor, baseTime, 3)).toEqual(expected);
  });
  it('retains PostgreSQL microseconds across pages of one and two', async () => {
    const chat = await makeChat();
    await addMessage(chat, sql`'2026-01-01 01:00:00.123100'::timestamp`);
    const anchor = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.123456'::timestamp`
    );
    const later = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.123789'::timestamp`
    );
    const tail = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.124001'::timestamp`
    );
    for (const limit of [1, 2])
      expect(
        await walk(chat, anchor, Date.parse('2026-01-01T01:00:00.123Z'), limit)
      ).toEqual([later, tail]);
  });
  it('preserves the merged history cursor at full stored precision', async () => {
    const chat = await makeChat();
    const older = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.123100'::timestamp`
    );
    const anchor = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.123456'::timestamp`
    );
    const later = await addMessage(
      chat,
      sql`'2026-01-01 01:00:00.123789'::timestamp`
    );
    const response = await request(chat, { cursor: later, limit: '2' });
    expect(response.status).toBe(200);
    expect(
      pageSchema.parse(await response.json()).messages.map((row) => row.id)
    ).toEqual([older, anchor]);
  });
  it('walks database default NOW timestamps without client-side deduplication', async () => {
    const chat = await makeChat();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => generateSnowflakeId())
    );
    const rows = await db
      .insert(messages)
      .values(
        ids.map((id) => ({
          id,
          chatId: chat,
          senderId: sender,
          content: 'default NOW',
        }))
      )
      .returning({ id: messages.id, createdAt: messages.createdAt });
    owned.messages.push(...rows.map((row) => row.id));
    const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const anchor = sorted[0];
    if (!anchor) throw new Error('No NOW anchor');
    for (const limit of [1, 2])
      expect(
        await walk(chat, anchor.id, anchor.createdAt.getTime(), limit)
      ).toEqual(sorted.slice(1).map((row) => row.id));
  });
  it('preserves the legacy timestamp-only walk for distinct timestamps', async () => {
    const chat = await makeChat();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(await addMessage(chat, new Date(baseTime + i * 1000)));
    const anchor = ids[2];
    if (!anchor) throw new Error('Missing anchor');
    expect(await walk(chat, anchor, baseTime + 2000, 3, false)).toEqual(
      ids.slice(3)
    );
  });
  it('rejects foreign and unknown anchors with the actual cursor error', async () => {
    const chat = await makeChat();
    const other = await makeChat();
    const foreign = await addMessage(other, new Date(baseTime));
    for (const id of [foreign, await generateSnowflakeId()]) {
      const response = await request(chat, {
        after: new Date(baseTime).toISOString(),
        afterId: id,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Invalid pagination cursor',
      });
    }
  });
  it('rejects an ID without a timestamp as validation failure', async () => {
    const chat = await makeChat();
    const response = await request(chat, {
      afterId: await generateSnowflakeId(),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Validation failed' });
  });
  it('keeps authentication and active membership checks', async () => {
    const chat = await makeChat();
    for (const credential of [null, 'invalid'])
      expect((await request(chat, {}, credential)).status).toBe(401);
    await db
      .update(chatParticipants)
      .set({ isActive: false })
      .where(eq(chatParticipants.id, owned.participants.at(-2) ?? 'missing'));
    expect((await request(chat, {})).status).toBe(403);
  });
  it('acquires ownership only after success and preserves collision sentinels on partial setup', async () => {
    const sentinel = ownership();
    const partial = ownership();
    try {
      const user = await addUser(sentinel);
      const chat = await makeChat(sentinel);
      const participant = sentinel.participants[0];
      if (!participant) throw new Error('No sentinel participant');
      const message = await addMessage(chat, new Date(baseTime), sentinel);
      await duplicate(() => addUser(partial, user));
      await addUser(partial);
      await duplicate(() => makeChat(partial, participant));
      await duplicate(() =>
        addMessage(chat, new Date(baseTime), partial, message)
      );
      expect(partial.users).not.toContain(user);
      expect(partial.participants).not.toContain(participant);
      expect(partial.messages).not.toContain(message);
      await cleanup(partial);
      expect(
        await db.select({ id: users.id }).from(users).where(eq(users.id, user))
      ).toEqual([{ id: user }]);
      expect(
        await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chat))
      ).toEqual([{ id: chat }]);
      expect(
        await db
          .select({ id: chatParticipants.id })
          .from(chatParticipants)
          .where(eq(chatParticipants.id, participant))
      ).toEqual([{ id: participant }]);
      expect(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.id, message))
      ).toEqual([{ id: message }]);
    } finally {
      await cleanup(partial);
      await cleanup(sentinel);
    }
  });
});
