/**
 * Account deletion must remove the user's chat participant rows.
 *
 * The chat detail route (GET /api/chats/[id]) builds its participants list
 * from every ChatParticipant row of the chat and resolves names from the
 * User table. ChatParticipant has no foreign key to User, and the deletion
 * route cleaned group memberships (GroupMember) but not chat participants,
 * so a deleted account stayed in every group chat's member list as an
 * 'Unknown' entry that nobody could remove.
 *
 * Cases:
 * - A group chat member deletes their account: the remaining members'
 *   chat detail no longer lists the deleted user, the participant rows
 *   are gone from the database, and the other members' rows are intact.
 * - The same deletion in a DM: the surviving member can still open the
 *   chat and read the history (messages are retained, as with group
 *   posts); only the membership row is removed.
 * - A user with no chat rows at all deletes their account normally.
 *
 * Fixture ownership: every inserted row is tracked by its RETURNING id
 * and teardown deletes exactly those rows, then reads back zero.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

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
import { NextRequest } from 'next/server';

let chatGET: (
  r: NextRequest,
  c: { params: Promise<{ id: string }> }
) => Promise<Response>;
let deleteAccountPOST: (r: NextRequest) => Promise<Response>;

function req(url: string, userId: string, method = 'GET', body?: unknown) {
  return new NextRequest(
    new Request(url, {
      method,
      headers: {
        'x-dev-user-id': userId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const owned = {
  userIds: [] as string[],
  chatIds: [] as string[],
  participantIds: [] as string[],
  messageIds: [] as string[],
};

let ghostId: string;
let recipId: string;
let ctrlId: string;
let plainId: string;
let groupChatId: string;
let dmChatId: string;
let dmMessageId: string;

async function participantIdsOf(
  chatId: string,
  viewerId: string
): Promise<string[]> {
  const res = await chatGET(
    req(`http://localhost/api/chats/${chatId}`, viewerId),
    {
      params: Promise.resolve({ id: chatId }),
    }
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data?: { participants?: Array<{ id: string }> };
    participants?: Array<{ id: string }>;
  };
  const list = body.data?.participants ?? body.participants ?? [];
  return list.map((p) => p.id);
}

beforeAll(async () => {
  ({ GET: chatGET } = await import(
    '../../../apps/web/src/app/api/chats/[id]/route'
  ));
  ({ POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  ));

  ghostId = await generateSnowflakeId();
  recipId = await generateSnowflakeId();
  ctrlId = await generateSnowflakeId();
  plainId = await generateSnowflakeId();
  groupChatId = await generateSnowflakeId();
  dmChatId = await generateSnowflakeId();
  dmMessageId = await generateSnowflakeId();

  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: ghostId,
        privyId: ghostId,
        username: `f183-ghost-${ghostId}`,
        displayName: 'F183 Ghost',
        updatedAt: now,
      },
      {
        id: recipId,
        privyId: recipId,
        username: `f183-recip-${recipId}`,
        displayName: 'F183 Recip',
        updatedAt: now,
      },
      {
        id: ctrlId,
        privyId: ctrlId,
        username: `f183-ctrl-${ctrlId}`,
        displayName: 'F183 Ctrl',
        updatedAt: now,
      },
      {
        id: plainId,
        privyId: plainId,
        username: `f183-plain-${plainId}`,
        displayName: 'F183 Plain',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  owned.userIds.push(...insertedUsers.map((u) => u.id));

  const insertedChats = await db
    .insert(chats)
    .values([
      {
        id: groupChatId,
        name: 'F183 group chat',
        isGroup: true,
        createdBy: recipId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: dmChatId,
        name: null,
        isGroup: false,
        createdBy: ghostId,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning({ id: chats.id });
  owned.chatIds.push(...insertedChats.map((c) => c.id));

  const participantRows = await Promise.all(
    [
      { chatId: groupChatId, userId: ghostId },
      { chatId: groupChatId, userId: recipId },
      { chatId: groupChatId, userId: ctrlId },
      { chatId: dmChatId, userId: ghostId },
      { chatId: dmChatId, userId: recipId },
    ].map(async (row) => ({
      id: await generateSnowflakeId(),
      ...row,
      isActive: true,
    }))
  );
  const insertedParticipants = await db
    .insert(chatParticipants)
    .values(participantRows)
    .returning({ id: chatParticipants.id });
  owned.participantIds.push(...insertedParticipants.map((p) => p.id));

  // The ghost sends a message in the DM only. In the group chat the ghost
  // is a silent member, so after deletion no sender-history entry can
  // re-add them to the group chat's participant list.
  const insertedMessages = await db
    .insert(messages)
    .values({
      id: dmMessageId,
      chatId: dmChatId,
      senderId: ghostId,
      content: 'F183 DM message from the ghost',
      type: 'user',
      createdAt: new Date(now.getTime() - 5 * 60_000),
    })
    .returning({ id: messages.id });
  owned.messageIds.push(...insertedMessages.map((m) => m.id));
});

afterAll(async () => {
  if (owned.messageIds.length > 0) {
    await db.delete(messages).where(inArray(messages.id, owned.messageIds));
  }
  if (owned.participantIds.length > 0) {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, owned.participantIds));
  }
  if (owned.chatIds.length > 0) {
    await db.delete(chats).where(inArray(chats.id, owned.chatIds));
  }
  if (owned.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, owned.userIds));
  }
  const remainingParticipants =
    owned.participantIds.length === 0
      ? []
      : await db
          .select({ id: chatParticipants.id })
          .from(chatParticipants)
          .where(inArray(chatParticipants.id, owned.participantIds));
  const remainingChats =
    owned.chatIds.length === 0
      ? []
      : await db
          .select({ id: chats.id })
          .from(chats)
          .where(inArray(chats.id, owned.chatIds));
  const remainingUsers =
    owned.userIds.length === 0
      ? []
      : await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, owned.userIds));
  expect(remainingParticipants).toHaveLength(0);
  expect(remainingChats).toHaveLength(0);
  expect(remainingUsers).toHaveLength(0);
});

describe('account deletion removes chat participant rows', () => {
  it('drops the deleted member from the group chat list and keeps the DM readable', async () => {
    // Pre-deletion: the ghost is a listed member of the group chat.
    const pre = await participantIdsOf(groupChatId, recipId);
    expect(pre).toContain(ghostId);
    expect(pre).toContain(recipId);
    expect(pre).toContain(ctrlId);

    const delRes = await deleteAccountPOST(
      req('http://localhost/api/users/delete-account', ghostId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(delRes.status).toBe(200);

    // Database: the ghost's participant rows are gone, everyone else's stay.
    const ghostRows = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, ghostId));
    expect(ghostRows).toHaveLength(0);
    const recipRows = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, recipId));
    expect(recipRows).toHaveLength(2);
    const ctrlRows = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, ctrlId));
    expect(ctrlRows).toHaveLength(1);

    // Surface: the group chat's member list no longer shows the ghost.
    const post = await participantIdsOf(groupChatId, recipId);
    expect(post).not.toContain(ghostId);
    expect(post).toContain(recipId);
    expect(post).toContain(ctrlId);

    // The DM stays openable for the surviving member and the history
    // (the ghost's message) is retained.
    const dmRes = await chatGET(
      req(`http://localhost/api/chats/${dmChatId}`, recipId),
      {
        params: Promise.resolve({ id: dmChatId }),
      }
    );
    expect(dmRes.status).toBe(200);
    const dmBody = (await dmRes.json()) as {
      data?: { messages?: Array<{ id: string }> };
      messages?: Array<{ id: string }>;
    };
    const dmMessages = dmBody.data?.messages ?? dmBody.messages ?? [];
    expect(dmMessages.map((m) => m.id)).toContain(dmMessageId);
  });

  it('still deletes an account that has no chat rows', async () => {
    const delRes = await deleteAccountPOST(
      req('http://localhost/api/users/delete-account', plainId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(delRes.status).toBe(200);
    const [gone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, plainId));
    expect(gone).toBeUndefined();
  });
});
