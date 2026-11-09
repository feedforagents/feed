/**
 * Real database: the agent-facing chat history tools (MCP
 * `get_chat_messages`, A2A `messaging.get_chat_messages`) page with
 * offset/limit over `ORDER BY createdAt DESC` alone. createdAt is a
 * millisecond timestamp and bursts of messages routinely share it; over
 * the ties alone, an offset walk repeats some messages and never returns
 * others (measured on base: one tie member returned twice, its sibling
 * not at all). Ordering by the total (createdAt, id) pair makes every
 * page boundary exact. Both handlers are exercised unmodified against a
 * real database. PRD §8.1 / §12: tools share the website's behavior.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  inArray,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

let executeGetChatMessages: typeof import('../../../packages/mcp/src/handlers/tool-handlers').executeGetChatMessages;
let FeedAgentExecutor: typeof import('../../../packages/a2a/src/executors/feed-executor').FeedAgentExecutor;

const viewer = await generateSnowflakeId();
const sender = await generateSnowflakeId();
const ownedUsers: string[] = [viewer, sender];
const ownedChats: string[] = [];
const ownedMessages: string[] = [];
const ownedParticipants: string[] = [];
const baseTime = Date.now() - 6 * 3600_000;

async function makeChat(): Promise<string> {
  const chatId = await generateSnowflakeId();
  ownedChats.push(chatId);
  const now = new Date();
  await db.insert(chats).values({
    id: chatId,
    name: `Chat tool order fixture ${chatId}`,
    isGroup: true,
    createdBy: viewer,
    updatedAt: now,
  });
  for (const userId of [viewer, sender]) {
    const pid = await generateSnowflakeId();
    ownedParticipants.push(pid);
    await db
      .insert(chatParticipants)
      .values({ id: pid, chatId, userId, isActive: true });
  }
  return chatId;
}

async function addMessage(
  chatId: string,
  createdAtMs: number,
  label: string
): Promise<string> {
  const id = await generateSnowflakeId();
  ownedMessages.push(id);
  await db.insert(messages).values({
    id,
    chatId,
    senderId: sender,
    content: `chat-tool-order-${label}-${id}`,
    createdAt: new Date(createdAtMs),
  });
  return id;
}

async function mcpPage(
  chatId: string,
  offset: number,
  limit: number
): Promise<string[]> {
  const result = await executeGetChatMessages(
    { userId: viewer } as never,
    { chatId, limit, offset } as never
  );
  return result.messages.map((m) => m.id);
}

const executor = () => new FeedAgentExecutor();
async function a2aPage(
  chatId: string,
  offset: number,
  limit: number
): Promise<string[]> {
  const instance = executor();
  const fn = (
    instance as unknown as {
      getChatMessages: (
        params: Record<string, unknown>,
        context: unknown
      ) => Promise<{ messages: Array<{ id: string }> }>;
    }
  ).getChatMessages.bind(instance);
  const result = await fn({ chatId, offset, limit }, { contextId: viewer });
  return result.messages.map((m) => m.id);
}

async function offsetWalk(
  pageFn: (chatId: string, offset: number, limit: number) => Promise<string[]>,
  chatId: string,
  total: number,
  limit: number
): Promise<string[]> {
  const walked: string[] = [];
  for (let offset = 0; offset < total + limit; offset += limit) {
    const page = await pageFn(chatId, offset, limit);
    if (page.length === 0) break;
    walked.push(...page);
  }
  return walked;
}

beforeAll(async () => {
  ({ executeGetChatMessages } = await import(
    '../../../packages/mcp/src/handlers/tool-handlers'
  ));
  ({ FeedAgentExecutor } = await import(
    '../../../packages/a2a/src/executors/feed-executor'
  ));
  const now = new Date();
  await db.insert(users).values(
    [viewer, sender].map((id) => ({
      id,
      username: `chat-tool-fixture-${id}`,
      displayName: `Chat tool fixture ${id}`,
      stewardId: `chat-tool-steward-${id}`,
      updatedAt: now,
    }))
  );
});

afterAll(async () => {
  if (ownedMessages.length)
    await db.delete(messages).where(inArray(messages.id, ownedMessages));
  if (ownedParticipants.length)
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, ownedParticipants));
  if (ownedChats.length)
    await db.delete(chats).where(inArray(chats.id, ownedChats));
  if (ownedUsers.length)
    await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('tool chat history total order (real database)', () => {
  it('offset walk over a same-millisecond tie group is exact on both tools', async () => {
    const chatId = await makeChat();
    const t = baseTime;
    const ids: string[] = [];
    ids.push(await addMessage(chatId, t, 'old1'));
    ids.push(await addMessage(chatId, t + 1000, 'old2'));
    for (let i = 0; i < 6; i++)
      ids.push(await addMessage(chatId, t + 2000, `tie${i}`));
    ids.push(await addMessage(chatId, t + 3000, 'new1'));
    ids.push(await addMessage(chatId, t + 4000, 'new2'));

    for (const pageFn of [mcpPage, a2aPage]) {
      const walked = await offsetWalk(pageFn, chatId, ids.length, 3);
      expect([...walked].sort()).toEqual([...ids].sort());
      expect(new Set(walked).size).toBe(ids.length);
    }
  });

  it('offset walk over distinct timestamps stays exact (guard)', async () => {
    const chatId = await makeChat();
    const t = baseTime + 3600_000;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(await addMessage(chatId, t + i * 1000, `d-${i}`));

    for (const pageFn of [mcpPage, a2aPage]) {
      const walked = await offsetWalk(pageFn, chatId, ids.length, 3);
      expect([...walked].sort()).toEqual([...ids].sort());
    }
  });
});
