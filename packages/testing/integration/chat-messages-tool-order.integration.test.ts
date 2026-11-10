/** PRD §§8.2/12, MVP Phase 3: retained MCP chat history ordering.
 * Exercises the public JSON-RPC route in process with stored-key auth.
 * HTTP transport and two actual agent-client runs are separate acceptance. */
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
  userApiKeys,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  generateApiKey,
  hashApiKey,
  invalidateCachedKeysForUser,
} from '../../api/src/utils/api-keys';

mock.module('server-only', () => ({}));
const resultSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.object({
    isError: z.boolean(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  }),
});
const messageSchema = z.object({
  messages: z.array(z.object({ id: z.string() })),
});
type Ownership = {
  users: string[];
  chats: string[];
  participants: string[];
  messages: string[];
  keys: string[];
};
const ownership = (): Ownership => ({
  users: [],
  chats: [],
  participants: [],
  messages: [],
  keys: [],
});
const owned = ownership();
let POST: typeof import('../../../apps/web/src/app/api/mcp/route').POST;
let viewer: string;
let sender: string;
let viewerKey: string;
let outsiderKey: string;
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
  for (const id of scope.users) invalidateCachedKeysForUser(id);
  if (scope.keys.length) {
    await db.delete(userApiKeys).where(inArray(userApiKeys.id, scope.keys));
    expect(
      await db
        .select({ id: userApiKeys.id })
        .from(userApiKeys)
        .where(inArray(userApiKeys.id, scope.keys))
    ).toEqual([]);
  }
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
async function storeKey(userId: string) {
  const key = generateApiKey();
  const [row] = await db
    .insert(userApiKeys)
    .values({
      id: await generateSnowflakeId(),
      userId,
      keyHash: hashApiKey(key),
      name: 'Owned MCP ordering fixture',
    })
    .returning({ id: userApiKeys.id });
  if (!row) throw new Error('API key insert returned no row');
  owned.keys.push(row.id);
  return key;
}
async function request(
  chatId: string,
  offset = 0,
  limit = 3,
  key: string | null = viewerKey,
  extra: Record<string, string> = {}
) {
  return POST(
    new NextRequest('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'X-Feed-Api-Key': key } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'owned-order',
        method: 'tools/call',
        params: {
          name: 'get_chat_messages',
          arguments: { chatId, offset, limit, ...extra },
        },
      }),
    })
  );
}
async function result(
  chatId: string,
  offset = 0,
  limit = 3,
  key = viewerKey,
  extra: Record<string, string> = {}
) {
  const response = await request(chatId, offset, limit, key, extra);
  expect(response.status).toBe(200);
  return resultSchema.parse(await response.json()).result;
}
async function page(chatId: string, offset = 0, limit = 3) {
  const body = await result(chatId, offset, limit);
  expect(body.isError).toBe(false);
  const content = body.content[0];
  if (!content) throw new Error('Missing MCP content');
  return messageSchema
    .parse(JSON.parse(content.text))
    .messages.map((row) => row.id);
}
async function walk(chatId: string, expected: string[], limit: number) {
  const raw: string[] = [];
  for (let offset = 0; offset <= expected.length + limit; offset += limit) {
    const rows = await page(chatId, offset, limit);
    expect(rows).toEqual(expected.slice(offset, offset + limit));
    raw.push(...rows);
    if (!rows.length) {
      expect(raw).toEqual(expected);
      return;
    }
  }
  throw new Error('No empty tail page');
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
  ({ POST } = await import('../../../apps/web/src/app/api/mcp/route'));
  viewer = await addUser();
  sender = await addUser();
  viewerKey = await storeKey(viewer);
  outsiderKey = await storeKey(await addUser());
});
afterAll(async () => {
  try {
    await cleanup(owned);
  } finally {
    await closeDatabase();
  }
});

describe('MCP chat history, stored-key public route and real DB', () => {
  it('returns exact descending tuple order on every raw tie page', async () => {
    const chat = await makeChat();
    const ids: string[] = [];
    ids.push(await addMessage(chat, new Date(baseTime)));
    for (let i = 0; i < 6; i++)
      ids.push(await addMessage(chat, new Date(baseTime + 1000)));
    ids.push(await addMessage(chat, new Date(baseTime + 2000)));
    const foreign = await makeChat();
    await addMessage(foreign, new Date(baseTime + 3000));
    const expected = [...ids].reverse();
    for (const limit of [1, 3]) await walk(chat, expected, limit);
  });
  it('preserves distinct timestamp ordering and an empty history', async () => {
    const chat = await makeChat();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(await addMessage(chat, new Date(baseTime + 1000 * i)));
    await walk(chat, [...ids].reverse(), 3);
    expect(await page(await makeChat())).toEqual([]);
  });
  it('checks missing/invalid keys, inactive membership, and key-bound identity', async () => {
    const chat = await makeChat();
    await addMessage(chat, new Date(baseTime));
    for (const key of [null, generateApiKey()])
      expect((await request(chat, 0, 3, key)).status).toBe(401);
    const denied = await result(chat, 0, 3, outsiderKey, { userId: viewer });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain(
      'Unauthorized: You do not have access to this chat'
    );
    const member = owned.participants.at(-2);
    if (!member) throw new Error('Missing member');
    await db
      .update(chatParticipants)
      .set({ isActive: false })
      .where(eq(chatParticipants.id, member));
    const inactive = await result(chat);
    expect(inactive.isError).toBe(true);
    expect(inactive.content[0]?.text).toContain(
      'Unauthorized: You do not have access to this chat'
    );
  });
  it('preserves existing rows after collisions and partial fixture setup', async () => {
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
