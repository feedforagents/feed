/**
 * MCP send_message is limited per account with the same budget as
 * POST /api/chats/[id]/message (RATE_LIMIT_CONFIGS.SEND_MESSAGE). Messages
 * sent through MCP and through the website count against one limit, so an
 * agent can neither send without a limit nor add a second budget.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  eq,
  inArray,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
} from '../../api/src/rate-limiting/user-rate-limiter';
import { executeSendMessage } from '../../mcp/src/handlers/tool-handlers';

const LIMIT = RATE_LIMIT_CONFIGS.SEND_MESSAGE.maxRequests;
const userIds: string[] = [];
const chatIds: string[] = [];

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `rate_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

/** A direct chat between a fresh sender and a fresh recipient. */
async function createDirectChat() {
  const senderId = await createUser();
  const recipientId = await createUser();
  const chatId = await generateSnowflakeId();
  await db.insert(chats).values({
    id: chatId,
    isGroup: false,
    updatedAt: new Date(),
  });
  chatIds.push(chatId);
  for (const userId of [senderId, recipientId]) {
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId,
      userId,
    });
  }
  return { senderId, chatId };
}

async function storedMessageCount(chatId: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId));
  return rows.length;
}

describe('MCP send_message rate limit', () => {
  afterAll(async () => {
    await db.delete(messages).where(inArray(messages.chatId, chatIds));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, chatIds));
    await db.delete(chats).where(inArray(chats.id, chatIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('refuses the message after the per-account limit is used up', async () => {
    const { senderId, chatId } = await createDirectChat();
    const agent = { agentId: 'agent', userId: senderId };

    for (let sent = 0; sent < LIMIT; sent++) {
      const result = await executeSendMessage(agent, {
        chatId,
        content: `message ${sent + 1}`,
      });
      expect(result.success).toBe(true);
    }

    await expect(
      executeSendMessage(agent, { chatId, content: 'one too many' })
    ).rejects.toThrow('Rate limit exceeded for send_message');
    expect(await storedMessageCount(chatId)).toBe(LIMIT);
  });

  it('counts website messages against the same limit', async () => {
    const { senderId, chatId } = await createDirectChat();

    // The web message route spends this budget once per message.
    for (let sent = 0; sent < LIMIT; sent++) {
      const web = await checkRateLimitAsync(
        senderId,
        RATE_LIMIT_CONFIGS.SEND_MESSAGE
      );
      expect(web.allowed).toBe(true);
    }

    await expect(
      executeSendMessage(
        { agentId: 'agent', userId: senderId },
        { chatId, content: 'through another client' }
      )
    ).rejects.toThrow('Rate limit exceeded for send_message');
    expect(await storedMessageCount(chatId)).toBe(0);
  });

  it('counts MCP messages against the website limit', async () => {
    const { senderId, chatId } = await createDirectChat();
    const agent = { agentId: 'agent', userId: senderId };

    for (let sent = 0; sent < LIMIT; sent++) {
      await executeSendMessage(agent, {
        chatId,
        content: `message ${sent + 1}`,
      });
    }

    const web = await checkRateLimitAsync(
      senderId,
      RATE_LIMIT_CONFIGS.SEND_MESSAGE
    );
    expect(web.allowed).toBe(false);
  });
});
