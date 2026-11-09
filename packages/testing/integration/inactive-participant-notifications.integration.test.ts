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
 * Requests use the existing CI-only synthetic Steward bearer. No new key
 * or production authentication is exercised. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database, service, and notification dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  notifications,
  userBlocks,
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

let POST: typeof import('../../../apps/web/src/app/api/chats/[id]/message/route').POST;

async function sendGroupMessage(contentSuffix = '') {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}/message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer steward:test:${senderId}`,
      },
      body: JSON.stringify({
        content:
          'Weekly alpha review: rotating into the new market after the latest signal update.' +
          contentSuffix,
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
  ({ POST } = await import(
    '../../../apps/web/src/app/api/chats/[id]/message/route'
  ));

  [senderId, activeMemberId, departedMemberId, groupId, chatId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
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

describe('Actual departure and DM authorization', () => {
  it('does not notify a member after the real leave endpoint', async () => {
    await db
      .update(groupMembers)
      .set({ isActive: true })
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, departedMemberId)
        )
      );
    await db
      .update(chatParticipants)
      .set({ isActive: true })
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, departedMemberId)
        )
      );
    const { DELETE } = await import(
      '../../../apps/web/src/app/api/chats/[id]/participants/me/route'
    );
    const request = new NextRequest(
      new Request(`http://localhost/api/chats/${chatId}/participants/me`, {
        method: 'DELETE',
        headers: { authorization: `Bearer steward:test:${departedMemberId}` },
      })
    );
    expect(
      (await DELETE(request, { params: Promise.resolve({ id: chatId }) }))
        .status
    ).toBe(200);
    await db.delete(notifications).where(eq(notifications.chatId, chatId));
    expect(
      (await sendGroupMessage(' The next review focuses on liquidity depth.'))
        .status
    ).toBe(201);
    expect((await notificationRecipients()).map((r) => r.userId)).not.toContain(
      departedMemberId
    );
  });

  for (const scenario of [
    {
      name: 'active peers can exchange messages',
      senderActive: true,
      peerActive: true,
      blocked: false,
      expected: 201,
    },
    {
      name: 'inactive unblocked peer gets no notification',
      senderActive: true,
      peerActive: false,
      blocked: false,
      expected: 201,
    },
    {
      name: 'inactive sender cannot post',
      senderActive: false,
      peerActive: true,
      blocked: false,
      expected: 403,
    },
    {
      name: 'active blocked peer remains protected',
      senderActive: true,
      peerActive: true,
      blocked: true,
      expected: 400,
    },
    {
      name: 'inactive blocked peer remains protected',
      senderActive: true,
      peerActive: false,
      blocked: true,
      expected: 400,
    },
  ]) {
    it(scenario.name, async () => {
      const [dmId, p1, p2, blockId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);
      const now = new Date();
      await db
        .insert(chats)
        .values({ id: dmId, isGroup: false, createdAt: now, updatedAt: now });
      await db.insert(chatParticipants).values([
        {
          id: p1,
          chatId: dmId,
          userId: senderId,
          isActive: scenario.senderActive,
          joinedAt: now,
        },
        {
          id: p2,
          chatId: dmId,
          userId: activeMemberId,
          isActive: true,
          joinedAt: now,
        },
      ]);
      if (!scenario.peerActive) {
        const { executeLeaveChat } = await import(
          '../../mcp/src/handlers/tool-handlers'
        );
        expect(
          await executeLeaveChat(
            { userId: activeMemberId } as Parameters<
              typeof executeLeaveChat
            >[0],
            { chatId: dmId }
          )
        ).toEqual({ success: true });
        const [peer] = await db
          .select({ active: chatParticipants.isActive })
          .from(chatParticipants)
          .where(eq(chatParticipants.id, p2));
        expect(peer?.active).toBe(false);
      }
      if (scenario.blocked)
        await db.insert(userBlocks).values({
          id: blockId,
          blockerId: activeMemberId,
          blockedId: senderId,
        });
      try {
        const request = new NextRequest(
          new Request(`http://localhost/api/chats/${dmId}/message`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer steward:test:${senderId}`,
            },
            body: JSON.stringify({
              content: `Review ${dmId}: sharing the latest market liquidity and pricing observations.`,
            }),
          })
        );
        const response = await POST(request, {
          params: Promise.resolve({ id: dmId }),
        });
        const body = await response.json();
        const saved = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.chatId, dmId));
        expect(body).toBeDefined();
        expect(response.status).toBe(scenario.expected);
        expect(saved.length).toBe(scenario.expected === 201 ? 1 : 0);
        const received = await db
          .select({ userId: notifications.userId })
          .from(notifications)
          .where(eq(notifications.chatId, dmId));
        expect(received.map((row) => row.userId)).toEqual(
          scenario.expected === 201 && scenario.peerActive
            ? [activeMemberId]
            : []
        );
      } finally {
        await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
        await db.delete(notifications).where(eq(notifications.chatId, dmId));
        await db.delete(messages).where(eq(messages.chatId, dmId));
        await db
          .delete(chatParticipants)
          .where(eq(chatParticipants.chatId, dmId));
        await db.delete(chats).where(eq(chats.id, dmId));
      }
    });
  }
});
