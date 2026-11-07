/**
 * POST /api/chats/[id]/message against a real database: a group-chat
 * message must only notify participants who are still active in the chat.
 *
 * Every other chat surface treats an inactive ChatParticipant row as "no
 * access": GET /api/chats/[id], the message-reactions routes, and the
 * realtime-token route all require `isActive: true`, and the tiered-group
 * service deliberately deactivates the participant row when a member is
 * promoted or demoted out of a tier chat ("Deactivate chat participant
 * for the old tier's chat"). But the send route built its notification
 * recipient list from every ChatParticipant row regardless of isActive,
 * so a member who had been moved out of the chat kept receiving
 * "New Group Message" notifications — with a preview of the message —
 * for a chat they can no longer open.
 *
 * The request is authenticated with the non-production x-dev-user-id
 * header. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database, service, and notification dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  notifications,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let senderId: string;
let activeMemberId: string;
let departedMemberId: string;
let groupId: string;
let chatId: string;
const allUserIds: string[] = [];

let POST: typeof import('../route').POST;

async function sendGroupMessage() {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-user-id': senderId,
      },
      body: JSON.stringify({
        content:
          'Weekly alpha review: rotating into the new market after the latest signal update.',
      }),
    })
  );
  return POST(request, { params: Promise.resolve({ id: chatId }) });
}

async function notificationRecipients() {
  const rows = await db
    .select({ userId: notifications.userId, title: notifications.title })
    .from(notifications)
    .where(eq(notifications.chatId, chatId));
  return rows;
}

beforeAll(async () => {
  ({ POST } = await import('../route'));

  [senderId, activeMemberId, departedMemberId, groupId, chatId] =
    await Promise.all(Array.from({ length: 5 }, () => generateSnowflakeId()));
  allUserIds.push(senderId, activeMemberId, departedMemberId);

  const now = new Date();

  await db.insert(users).values([
    {
      id: senderId,
      username: `test-f6-sender-${senderId}`,
      displayName: 'F6 Sender',
      updatedAt: now,
    },
    {
      id: activeMemberId,
      username: `test-f6-active-${activeMemberId}`,
      displayName: 'F6 Active Member',
      updatedAt: now,
    },
    {
      id: departedMemberId,
      username: `test-f6-departed-${departedMemberId}`,
      displayName: 'F6 Departed Member',
      updatedAt: now,
    },
  ]);

  await db.insert(groups).values({
    id: groupId,
    name: 'F6 Alpha Group',
    type: 'user',
    ownerId: senderId,
    createdById: senderId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(chats).values({
    id: chatId,
    name: 'F6 Alpha Group',
    isGroup: true,
    groupId,
    createdAt: now,
    updatedAt: now,
  });

  const memberIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(groupMembers).values([
    {
      id: memberIds[0]!,
      groupId,
      userId: senderId,
      role: 'owner',
      isActive: true,
      joinedAt: now,
    },
    {
      id: memberIds[1]!,
      groupId,
      userId: activeMemberId,
      role: 'member',
      isActive: true,
      joinedAt: now,
    },
    {
      // The departed member's post-move state: the tiered-group service
      // deactivates both the membership and the chat participant row when
      // a member is promoted/demoted out of a tier chat.
      id: memberIds[2]!,
      groupId,
      userId: departedMemberId,
      role: 'member',
      isActive: false,
      joinedAt: now,
      kickedAt: now,
      kickReason: 'Promoted to Tier 1',
    },
  ]);

  const participantIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(chatParticipants).values([
    {
      id: participantIds[0]!,
      chatId,
      userId: senderId,
      isActive: true,
      joinedAt: now,
    },
    {
      id: participantIds[1]!,
      chatId,
      userId: activeMemberId,
      isActive: true,
      joinedAt: now,
    },
    {
      id: participantIds[2]!,
      chatId,
      userId: departedMemberId,
      isActive: false,
      joinedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.chatId, chatId));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatParticipants).where(eq(chatParticipants.chatId, chatId));
  await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(groups).where(eq(groups.id, groupId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('POST /api/chats/[id]/message group notifications', () => {
  it('notifies the active member but not the departed (inactive) participant', async () => {
    const response = await sendGroupMessage();
    expect(response.status).toBe(201);

    const recipients = await notificationRecipients();
    const recipientIds = recipients.map((r) => r.userId);
    expect(recipientIds).toContain(activeMemberId);
    expect(recipientIds).not.toContain(departedMemberId);
    expect(recipientIds).not.toContain(senderId);
  });
});
