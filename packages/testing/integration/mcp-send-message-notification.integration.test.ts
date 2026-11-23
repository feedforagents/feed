/**
 * PRD §8.1 and D-28, MVP Phase 3: notify other active chat participants
 * through the shared in-app notification service. Exercise PostgreSQL in
 * a leased database and replace only the outbound email boundary.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP send_message notifications';
const dmCase = 'notifies the other participant of a direct message in-app';
const groupCase = 'notifies every other active group member in-app';
const blockCase = 'does not notify a group member who blocked the sender';
const failureCase = 'returns the committed message when notification fails';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  it('checks MCP chat notifications in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-send-message-notifications',
      file: 'packages/testing/integration/mcp-send-message-notification.integration.test.ts',
      cases: [dmCase, groupCase, blockCase, failureCase].map(
        (name) => `${suite} > ${name}`
      ),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
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
  const notificationService = await import(
    '../../api/src/services/notification-service'
  );
  const emailService = await import(
    '../../api/src/services/notification-email-service'
  );
  const sendEmail = spyOn(
    emailService,
    'sendNotificationEmail'
  ).mockResolvedValue({
    sent: false,
  });
  const { executeSendMessage } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );
  afterEach(() => {
    sendEmail.mockClear();
  });
  afterAll(async () => {
    sendEmail.mockRestore();
    await closeDatabase();
  });

  async function createUser(
    displayName: string,
    emailEligible = false
  ): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `msg_${id.slice(-10)}`,
      displayName,
      isActor: false,
      ...(emailEligible
        ? {
            email: `${id}@feed-fixture.invalid`,
            emailVerified: true,
            emailNotificationsEnabled: true,
            emailNotificationsRealtime: true,
          }
        : {}),
      updatedAt: new Date(),
    });
    return id;
  }

  async function createChat(options: {
    isGroup: boolean;
    name?: string;
    members: Array<{ userId: string; isActive?: boolean }>;
  }): Promise<string> {
    const id = await generateSnowflakeId();
    await db.insert(chats).values({
      id,
      name: options.name ?? null,
      isGroup: options.isGroup,
      updatedAt: new Date(),
    });
    for (const member of options.members) {
      await db.insert(chatParticipants).values({
        id: await generateSnowflakeId(),
        chatId: id,
        userId: member.userId,
        isActive: member.isActive ?? true,
      });
    }
    return id;
  }

  async function notificationsFor(userId: string, chatId: string) {
    return db
      .select({
        type: notifications.type,
        actorId: notifications.actorId,
        title: notifications.title,
        message: notifications.message,
      })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), eq(notifications.chatId, chatId))
      );
  }

  describe(suite, () => {
    let senderId: string;
    const sender = () => ({ agentId: 'agent', userId: senderId });

    beforeAll(async () => {
      senderId = await createUser('Sender');
    });

    it(dmCase, async () => {
      const recipientId = await createUser('Recipient', true);
      const chatId = await createChat({
        isGroup: false,
        members: [{ userId: senderId }, { userId: recipientId }],
      });

      const result = await executeSendMessage(sender(), {
        chatId,
        content: 'are you watching this market?',
      });

      expect(result.success).toBe(true);
      expect(await notificationsFor(recipientId, chatId)).toEqual([
        {
          type: 'system',
          actorId: senderId,
          title: 'New Message',
          message: 'Sender: are you watching this market?',
        },
      ]);
      expect(await notificationsFor(senderId, chatId)).toHaveLength(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it(groupCase, async () => {
      const memberId = await createUser('Member', true);
      const secondMemberId = await createUser('Second Member');
      const departedId = await createUser('Departed');
      const chatId = await createChat({
        isGroup: true,
        name: 'Alpha Desk',
        members: [
          { userId: senderId },
          { userId: memberId },
          { userId: secondMemberId },
          { userId: departedId, isActive: false },
        ],
      });

      const result = await executeSendMessage(sender(), {
        chatId,
        content: 'new hint posted',
      });

      expect(result.success).toBe(true);
      const expected = [
        {
          type: 'system',
          actorId: senderId,
          title: 'New Group Message',
          message: 'Sender in "Alpha Desk": new hint posted',
        },
      ];
      expect(await notificationsFor(memberId, chatId)).toEqual(expected);
      expect(await notificationsFor(secondMemberId, chatId)).toEqual(expected);
      // A member who left the chat gets no preview of later messages.
      expect(await notificationsFor(departedId, chatId)).toHaveLength(0);
      expect(await notificationsFor(senderId, chatId)).toHaveLength(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it(blockCase, async () => {
      const memberId = await createUser('Member');
      const blockerId = await createUser('Blocker');
      await db.insert(userBlocks).values({
        id: await generateSnowflakeId(),
        blockerId,
        blockedId: senderId,
      });
      const chatId = await createChat({
        isGroup: true,
        name: 'Mixed Room',
        members: [
          { userId: senderId },
          { userId: memberId },
          { userId: blockerId },
        ],
      });

      await executeSendMessage(sender(), { chatId, content: 'hello room' });

      expect(await notificationsFor(memberId, chatId)).toHaveLength(1);
      expect(await notificationsFor(blockerId, chatId)).toHaveLength(0);
    });

    it(failureCase, async () => {
      const recipientId = await createUser('Recipient');
      const chatId = await createChat({
        isGroup: false,
        members: [{ userId: senderId }, { userId: recipientId }],
      });
      const notify = spyOn(notificationService, 'notifyDMMessage');
      notify.mockRejectedValueOnce(new Error('notification unavailable'));
      try {
        const result = await executeSendMessage(sender(), {
          chatId,
          content: 'still delivered',
        });

        expect(result.success).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        const stored = await db
          .select({ id: messages.id, content: messages.content })
          .from(messages)
          .where(eq(messages.chatId, chatId));
        expect(stored).toEqual([
          { id: result.messageId, content: 'still delivered' },
        ]);
      } finally {
        notify.mockRestore();
      }
    });
  });
}
