/**
 * PRD §8.1 and D-28, MVP Phase 3: agent tools use the same services as REST,
 * including notifications. POST /api/chats/[id]/message and MCP send_message
 * notify the other active chat participants in-app; A2A
 * messaging.send_message must do the same.
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
  or,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import * as notificationService from '../../api/src/services/notification-service';

const userIds: string[] = [];
const chatIds: string[] = [];

async function createUser(displayName: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `a2a_msg_${id.slice(-10)}`,
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

describe('A2A messaging.send_message notifications', () => {
  let senderId: string;

  beforeAll(async () => {
    senderId = await createUser('Sender');
  });

  afterAll(async () => {
    await db
      .delete(notifications)
      .where(inArray(notifications.chatId, chatIds));
    await db.delete(messages).where(inArray(messages.chatId, chatIds));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, chatIds));
    await db.delete(chats).where(inArray(chats.id, chatIds));
    await db
      .delete(userBlocks)
      .where(
        or(
          inArray(userBlocks.blockerId, userIds),
          inArray(userBlocks.blockedId, userIds)
        )
      );
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('notifies the other participant of a direct message in-app', async () => {
    const recipientId = await createUser('Recipient');
    const chatId = await createChat({
      isGroup: false,
      members: [{ userId: senderId }, { userId: recipientId }],
    });

    await FeedAgentExecutor.executeDirectly(
      'messaging.send_message',
      { chatId, content: 'are you watching this market?' },
      senderId
    );

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

  it('notifies every other active group member in-app', async () => {
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

    await FeedAgentExecutor.executeDirectly(
      'messaging.send_message',
      { chatId, content: 'new hint posted' },
      senderId
    );

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

    await FeedAgentExecutor.executeDirectly(
      'messaging.send_message',
      { chatId, content: 'hello room' },
      senderId
    );

    expect(await notificationsFor(memberId, chatId)).toHaveLength(1);
    expect(await notificationsFor(blockerId, chatId)).toHaveLength(0);
  });

  it('returns the committed message when notification fails', async () => {
    const recipientId = await createUser('Recipient');
    const chatId = await createChat({
      isGroup: false,
      members: [{ userId: senderId }, { userId: recipientId }],
    });
    const notify = spyOn(notificationService, 'notifyDMMessage');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const result = await FeedAgentExecutor.executeDirectly(
        'messaging.send_message',
        { chatId, content: 'still delivered' },
        senderId
      );

      expect(result).toMatchObject({ success: true });
      expect(notify).toHaveBeenCalledTimes(1);
      const stored = await db
        .select({ content: messages.content })
        .from(messages)
        .where(eq(messages.chatId, chatId));
      expect(stored).toEqual([{ content: 'still delivered' }]);
    } finally {
      notify.mockRestore();
    }
  });
});
