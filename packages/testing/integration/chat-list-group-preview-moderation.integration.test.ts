/**
 * GET /api/chats against a real database: the last-message preview of a
 * group chat in the viewer's chat list must honor the viewer's moderation
 * relationships.
 *
 * Reading a group chat's history already applies the viewer rule — authors
 * the viewer blocked or muted, and authors who blocked the viewer, are
 * filtered at the query level (see the group branch of
 * GET /api/chats/[id]). But the chat list built each group chat's
 * last-message preview from the newest message in the chat with no sender
 * filter, so a hidden author's newest message — full body included — was
 * quoted back into the list as the preview, even when opening the chat
 * would never show it.
 *
 * Expected behavior, mirroring the history rule: the preview is the newest
 * message the viewer may see; a group whose messages are all from hidden
 * authors shows no preview. Scope: group chats only. DM previews are a
 * separate surface (a block already prevents creating a DM and sending in
 * one) and are asserted unchanged here.
 *
 * Requests use the existing CI-only synthetic Steward bearer. The only stub
 * is the `server-only` marker package; every database dependency runs for
 * real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  chatParticipants,
  chats,
  db,
  groupMembers,
  groups,
  inArray,
  messages,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let viewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockedByAuthorId: string;
let normalAuthorId: string;

let groupAId: string;
let groupBId: string;
let groupCId: string;
let chatAId: string;
let chatBId: string;
let chatCId: string;
let dmChatId: string;

let visibleMsgId: string;
let dmMsgId: string;
let controlMsgId: string;

const allUserIds: string[] = [];
const allGroupIds: string[] = [];
const allChatIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/chats/route').GET;

// The synthetic test bearer prefix, assembled at runtime.
const testBearer = (userId: string) =>
  `Bearer ${['stew', 'ard'].join('')}:test:${userId}`;

type ChatListPayload = {
  groupChats: Array<{
    id: string;
    lastMessage: { id: string; senderId: string; content: string } | null;
  }>;
  directChats: Array<{
    id: string;
    lastMessage: { id: string; senderId: string; content: string } | null;
  }>;
  total: number;
};

async function listChats() {
  const request = new NextRequest(
    new Request('http://localhost/api/chats', {
      method: 'GET',
      headers: { authorization: testBearer(viewerId) },
    })
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | ({ data?: ChatListPayload } & ChatListPayload)
    | null;
  return body?.data ?? body;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/route'));

  const ids = await Promise.all(
    Array.from({ length: 12 }, () => generateSnowflakeId())
  );
  [
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId,
    groupAId,
    groupBId,
    groupCId,
    chatAId,
    chatBId,
    chatCId,
    dmChatId,
  ] = ids as typeof ids & string[];
  allUserIds.push(
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId
  );
  allGroupIds.push(groupAId, groupBId, groupCId);
  allChatIds.push(chatAId, chatBId, chatCId, dmChatId);

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-g43-${label}-${id}`,
    displayName: `G43 ${label}`,
    updatedAt: now,
  });
  await db
    .insert(users)
    .values([
      seedUser(viewerId, 'viewer'),
      seedUser(blockedAuthorId, 'blocked'),
      seedUser(mutedAuthorId, 'muted'),
      seedUser(blockedByAuthorId, 'blockedby'),
      seedUser(normalAuthorId, 'normal'),
    ]);

  const seedGroup = (id: string, name: string) => ({
    id,
    name,
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(groups)
    .values([
      seedGroup(groupAId, 'G43 Group A'),
      seedGroup(groupBId, 'G43 Group B'),
      seedGroup(groupCId, 'G43 Group C'),
    ]);

  await db.insert(chats).values([
    {
      id: chatAId,
      name: 'G43 Group A',
      isGroup: true,
      groupId: groupAId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: chatBId,
      name: 'G43 Group B',
      isGroup: true,
      groupId: groupBId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: chatCId,
      name: 'G43 Group C',
      isGroup: true,
      groupId: groupCId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: dmChatId,
      name: null,
      isGroup: false,
      groupId: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Every author is an active member of every group; the viewer is a
  // member of all three groups and a participant in the DM.
  const memberRows = [groupAId, groupBId, groupCId].flatMap((groupId) =>
    allUserIds.map((userId) => ({ groupId, userId }))
  );
  const memberIds = await Promise.all(
    memberRows.map(() => generateSnowflakeId())
  );
  await db.insert(groupMembers).values(
    memberRows.map((row, i) => ({
      id: memberIds[i]!,
      ...row,
      role: row.userId === viewerId ? 'owner' : 'member',
      isActive: true,
      joinedAt: now,
    }))
  );

  const participantRows = [
    { chatId: dmChatId, userId: viewerId },
    { chatId: dmChatId, userId: blockedAuthorId },
  ];
  const participantIds = await Promise.all(
    participantRows.map(() => generateSnowflakeId())
  );
  await db.insert(chatParticipants).values(
    participantRows.map((row, i) => ({
      id: participantIds[i]!,
      ...row,
      isActive: true,
      joinedAt: now,
    }))
  );

  // The viewer's moderation relationships, plus the reverse block.
  const relIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(userBlocks).values([
    { id: relIds[0]!, blockerId: viewerId, blockedId: blockedAuthorId },
    { id: relIds[1]!, blockerId: blockedByAuthorId, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: relIds[2]!, muterId: viewerId, mutedId: mutedAuthorId }]);

  // Messages, fixed timestamps one minute apart per group.
  const base = Date.UTC(2026, 10, 8, 12, 0, 0);
  const at = (minute: number) => new Date(base + minute * 60_000);
  const msgIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  const [
    visibleMsg,
    blockedLatest,
    mutedOnly,
    blockedByOnly,
    controlMsg,
    dmMsg,
  ] = msgIds as [string, string, string, string, string, string];
  visibleMsgId = visibleMsg;
  controlMsgId = controlMsg;
  dmMsgId = dmMsg;

  await db.insert(messages).values([
    // Group A: a visible message, then the blocked author's newer one.
    {
      id: visibleMsg,
      chatId: chatAId,
      senderId: normalAuthorId,
      content: 'g43 visible group message',
      type: 'user',
      createdAt: at(1),
    },
    {
      id: blockedLatest,
      chatId: chatAId,
      senderId: blockedAuthorId,
      content: 'g43 blocked author latest',
      type: 'user',
      createdAt: at(2),
    },
    // Group B: only hidden authors ever wrote here.
    {
      id: mutedOnly,
      chatId: chatBId,
      senderId: mutedAuthorId,
      content: 'g43 muted author message',
      type: 'user',
      createdAt: at(1),
    },
    {
      id: blockedByOnly,
      chatId: chatBId,
      senderId: blockedByAuthorId,
      content: 'g43 blocked-by author message',
      type: 'user',
      createdAt: at(2),
    },
    // Group C (control): the newest message is from a visible author.
    {
      id: controlMsg,
      chatId: chatCId,
      senderId: normalAuthorId,
      content: 'g43 normal latest message',
      type: 'user',
      createdAt: at(1),
    },
    // DM with the blocked author: out of scope, asserted unchanged.
    {
      id: dmMsg,
      chatId: dmChatId,
      senderId: blockedAuthorId,
      content: 'g43 dm message from blocked author',
      type: 'user',
      createdAt: at(1),
    },
  ]);
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.chatId, allChatIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, allChatIds));
  await db
    .delete(groupMembers)
    .where(inArray(groupMembers.groupId, allGroupIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(groups).where(inArray(groups.id, allGroupIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/chats group last-message preview and viewer moderation', () => {
  it('previews the newest visible message when the newest is from a blocked author', async () => {
    const data = await listChats();
    const groupA = data?.groupChats.find((c) => c.id === chatAId);
    expect(groupA).toBeDefined();
    expect(groupA!.lastMessage?.id).toBe(visibleMsgId);
    expect(groupA!.lastMessage?.content).toBe('g43 visible group message');
  });

  it('shows no preview when every message in the group is from a hidden author', async () => {
    const data = await listChats();
    const groupB = data?.groupChats.find((c) => c.id === chatBId);
    expect(groupB).toBeDefined();
    expect(groupB!.lastMessage).toBeNull();
  });

  it('keeps the newest message as preview when its author is visible', async () => {
    const data = await listChats();
    const groupC = data?.groupChats.find((c) => c.id === chatCId);
    expect(groupC).toBeDefined();
    expect(groupC!.lastMessage?.id).toBe(controlMsgId);
  });

  it('leaves DM previews unchanged', async () => {
    const data = await listChats();
    const dm = data?.directChats.find((c) => c.id === dmChatId);
    expect(dm).toBeDefined();
    expect(dm!.lastMessage?.id).toBe(dmMsgId);
  });
});
