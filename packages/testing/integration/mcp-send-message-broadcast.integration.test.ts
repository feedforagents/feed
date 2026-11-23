/**
 * PRD sections 8.1 and 12, MVP Phase 3: a message sent through MCP send_message
 * reaches open chat windows over SSE, as POST /api/chats/[id]/message does.
 * Exercise PostgreSQL in a leased database and record the real broadcaster's
 * input (CI runs without Redis).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP send_message live delivery';
const dmCase = 'publishes a direct message to the chat channel';
const groupCase = 'publishes a group message to the chat channel';
const rejectedCase = 'publishes nothing when the send is refused';
const failureCase = 'returns the committed message when the broadcast fails';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP chat live delivery in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-send-message-broadcast',
      file: 'packages/testing/integration/mcp-send-message-broadcast.integration.test.ts',
      cases: [dmCase, groupCase, rejectedCase, failureCase].map(
        (name) => `${suite} > ${name}`
      ),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const actualApi = await import('@feed/api');
  const {
    and,
    chatParticipants,
    chats,
    closeDatabase,
    db,
    eq,
    messages,
    notifications,
    userBlocks,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');

  type Published = {
    chatId: string;
    message: Parameters<typeof actualApi.broadcastChatMessage>[1];
  };
  const published: Published[] = [];
  let failNextBroadcast = false;
  const { broadcastChatMessage: realBroadcastChatMessage } = actualApi;

  mock.module('@feed/api', () => ({
    ...actualApi,
    broadcastChatMessage: async (
      chatId: Parameters<typeof realBroadcastChatMessage>[0],
      message: Parameters<typeof realBroadcastChatMessage>[1]
    ) => {
      if (failNextBroadcast) {
        failNextBroadcast = false;
        throw new Error('realtime unavailable');
      }
      published.push({ chatId, message });
      await realBroadcastChatMessage(chatId, message);
    },
  }));

  const { executeSendMessage } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );
  afterAll(async () => {
    await closeDatabase();
  });

  async function createUser(displayName: string): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `msg_bc_${id.slice(-10)}`,
      displayName,
      isActor: false,
      updatedAt: new Date(),
    });
    return id;
  }

  async function createChat(options: {
    isGroup: boolean;
    name?: string;
    memberIds: string[];
  }): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(chats).values({
      id,
      name: options.name ?? null,
      isGroup: options.isGroup,
      updatedAt: new Date(),
    });
    for (const userId of options.memberIds) {
      await db.insert(chatParticipants).values({
        id: await generateSnowflakeId(),
        chatId: id,
        userId,
        isActive: true,
      });
    }
    return id;
  }

  async function storedMessages(chatId: string) {
    return db
      .select({
        id: messages.id,
        content: messages.content,
        senderId: messages.senderId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.chatId, chatId));
  }

  const publishedFor = (chatId: string) =>
    published.filter((event) => event.chatId === chatId);

  describe(suite, () => {
    const agentFor = (userId: string) => ({ agentId: 'agent', userId });

    test(dmCase, async () => {
      const senderId = await createUser('Sender');
      const recipientId = await createUser('Recipient');
      const chatId = await createChat({
        isGroup: false,
        memberIds: [senderId, recipientId],
      });

      const result = await executeSendMessage(agentFor(senderId), {
        chatId,
        content: 'are you watching this market?',
      });

      expect(result.success).toBe(true);
      const [stored] = await storedMessages(chatId);
      expect(stored?.id).toBe(result.messageId);
      expect(publishedFor(chatId)).toEqual([
        {
          chatId,
          message: {
            id: result.messageId,
            content: 'are you watching this market?',
            chatId,
            senderId,
            type: 'user',
            createdAt: stored!.createdAt.toISOString(),
            isDMChat: true,
          },
        },
      ]);
    });

    test(groupCase, async () => {
      const senderId = await createUser('Sender');
      const memberId = await createUser('Member');
      const secondMemberId = await createUser('Second Member');
      const chatId = await createChat({
        isGroup: true,
        name: 'Alpha Desk',
        memberIds: [senderId, memberId, secondMemberId],
      });

      const result = await executeSendMessage(agentFor(senderId), {
        chatId,
        content: 'new hint posted',
      });

      expect(result.success).toBe(true);
      const events = publishedFor(chatId);
      expect(events).toHaveLength(1);
      expect(events[0]?.message).toMatchObject({
        id: result.messageId,
        content: 'new hint posted',
        chatId,
        senderId,
        type: 'user',
        isDMChat: false,
      });
    });

    test(rejectedCase, async () => {
      const senderId = await createUser('Sender');
      const blockerId = await createUser('Blocker');
      await db.insert(userBlocks).values({
        id: await generateSnowflakeId(),
        blockerId,
        blockedId: senderId,
      });
      const chatId = await createChat({
        isGroup: false,
        memberIds: [senderId, blockerId],
      });

      await expect(
        executeSendMessage(agentFor(senderId), { chatId, content: 'hello?' })
      ).rejects.toThrow('Cannot send messages to this user');

      expect(await storedMessages(chatId)).toHaveLength(0);
      expect(publishedFor(chatId)).toHaveLength(0);
    });

    test(failureCase, async () => {
      const senderId = await createUser('Sender');
      const recipientId = await createUser('Recipient');
      const chatId = await createChat({
        isGroup: false,
        memberIds: [senderId, recipientId],
      });

      failNextBroadcast = true;
      const result = await executeSendMessage(agentFor(senderId), {
        chatId,
        content: 'still delivered',
      });

      expect(failNextBroadcast).toBe(false);
      expect(result.success).toBe(true);
      expect(
        (await storedMessages(chatId)).map((row) => [row.id, row.content])
      ).toEqual([[result.messageId, 'still delivered']]);
      // The stored notification still follows a failed live push.
      const recipientNotifications = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, recipientId),
            eq(notifications.chatId, chatId)
          )
        );
      expect(recipientNotifications).toHaveLength(1);
    });
  });
}
