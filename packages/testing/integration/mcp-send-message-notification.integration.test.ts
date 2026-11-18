/**
 * MCP send_message delivers a message the same way POST /api/chats/[id]/message
 * does: the other active participants of the chat are notified. A message
 * written by an agent must not be silent for the people it was sent to.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  inArray,
  messages,
  notifications,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import * as notificationService from '../../api/src/services/notification-service';
import { executeSendMessage } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const chatIds: string[] = [];

async function createUser(displayName: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `msg_${id.slice(-10)}`,
    displayName,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
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
  chatIds.push(id);
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

describe('MCP send_message notifications', () => {
  let senderId: string;
  const sender = () => ({ agentId: 'agent', userId: senderId });

  beforeAll(async () => {
    senderId = await createUser('Sender');
  });

  afterAll(async () => {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(messages).where(inArray(messages.chatId, chatIds));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, chatIds));
    await db.delete(chats).where(inArray(chats.id, chatIds));
    await db.delete(userBlocks).where(inArray(userBlocks.blockerId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('notifies the other participant of a direct message', async () => {
    const recipientId = await createUser('Recipient');
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
  });

  it('notifies every other active member of a group chat', async () => {
    const memberId = await createUser('Member');
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
  });

  it('does not notify a group member who blocked the sender', async () => {
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

  it('returns the committed message when the notification fails', async () => {
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
