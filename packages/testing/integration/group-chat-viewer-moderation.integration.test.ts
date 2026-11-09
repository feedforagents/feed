/**
 * GET /api/chats/[id] for a group chat against a real database: the message
 * list a member reads must honor the viewer's moderation relationships.
 *
 * Every other reading surface applies the same viewer rule — the home feeds
 * (for-you, hot, stories), the post list, the favorites feed, the comment
 * thread and the notification list all drop authors the viewer blocked or
 * muted, and authors who blocked the viewer (see
 * apps/web/src/app/api/feed/_lib/viewer-moderation.ts). The block/mute
 * dialogs promise "Hide their posts from your feed". But the chat history
 * query behind the group feed fetched every message in the chat, so a
 * blocked or muted member's messages — and the messages of someone who
 * blocked the viewer — stayed fully visible in the group, and a visible
 * reply could even quote the hidden message back through replyToMessage.
 *
 * Scope: group chats only. DM history is a separate surface (a block
 * already prevents creating a DM and sending in one) and is asserted
 * unchanged here.
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
  eq,
  groupMembers,
  groups,
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
let groupId: string;
let groupChatId: string;
let dmChatId: string;

let normalMsg1: string;
let viewerMsg: string;
let systemMsg: string;
let normalMsg2: string;
let dmMsgFromBlocked: string;

const allUserIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

async function getChat(chatId: string, userId: string, query = '') {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer steward:test:${userId}` },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: chatId }),
  });
  const body = (await response.json().catch(() => null)) as
    | ({
        data?: Payload;
      } & Payload)
    | null;
  return { status: response.status, payload: body?.data ?? body ?? null };
}

type Payload = {
  messages: {
    id: string;
    senderId: string;
    content: string;
    replyToMessage: { id: string; content: string } | null;
  }[];
  pagination: { hasMore: boolean; nextCursor: string | null };
};

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));

  [
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId,
    groupId,
    groupChatId,
    dmChatId,
  ] = await Promise.all(Array.from({ length: 8 }, () => generateSnowflakeId()));
  allUserIds.push(
    viewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId
  );

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-g34-${label}-${id}`,
    displayName: `G34 ${label}`,
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

  await db.insert(groups).values({
    id: groupId,
    name: 'G34 Group',
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(chats).values([
    {
      id: groupChatId,
      name: 'G34 Group',
      isGroup: true,
      groupId,
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

  const memberIds = await Promise.all(
    allUserIds.map(() => generateSnowflakeId())
  );
  await db.insert(groupMembers).values(
    allUserIds.map((userId, i) => ({
      id: memberIds[i]!,
      groupId,
      userId,
      role: userId === viewerId ? 'owner' : 'member',
      isActive: true,
      joinedAt: now,
    }))
  );

  const participantRows = [
    ...allUserIds.map((userId) => ({
      chatId: groupChatId,
      userId,
      isActive: true,
      joinedAt: now,
    })),
    { chatId: dmChatId, userId: viewerId, isActive: true, joinedAt: now },
    {
      chatId: dmChatId,
      userId: blockedAuthorId,
      isActive: true,
      joinedAt: now,
    },
  ];
  const participantIds = await Promise.all(
    participantRows.map(() => generateSnowflakeId())
  );
  await db
    .insert(chatParticipants)
    .values(
      participantRows.map((row, i) => ({ id: participantIds[i]!, ...row }))
    );

  // The viewer's moderation relationships, plus the reverse block.
  const blockIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(userBlocks).values([
    { id: blockIds[0]!, blockerId: viewerId, blockedId: blockedAuthorId },
    { id: blockIds[1]!, blockerId: blockedByAuthorId, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: blockIds[2]!, muterId: viewerId, mutedId: mutedAuthorId }]);

  // Group messages, oldest to newest, one minute apart.
  const base = Date.UTC(2026, 10, 8, 12, 0, 0);
  const at = (minute: number) => new Date(base + minute * 60_000);
  const msgIds = await Promise.all(
    Array.from({ length: 8 }, () => generateSnowflakeId())
  );
  const [
    normal1,
    blocked1,
    muted1,
    blockedBy1,
    viewer1,
    system1,
    normal2,
    dm1,
  ] = msgIds as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  normalMsg1 = normal1;
  viewerMsg = viewer1;
  systemMsg = system1;
  normalMsg2 = normal2;
  dmMsgFromBlocked = dm1;

  await db.insert(messages).values([
    {
      id: normal1,
      chatId: groupChatId,
      senderId: normalAuthorId,
      content: 'normal message one',
      type: 'user',
      createdAt: at(1),
    },
    {
      id: blocked1,
      chatId: groupChatId,
      senderId: blockedAuthorId,
      content: 'blocked author message',
      type: 'user',
      createdAt: at(2),
    },
    {
      id: muted1,
      chatId: groupChatId,
      senderId: mutedAuthorId,
      content: 'muted author message',
      type: 'user',
      createdAt: at(3),
    },
    {
      id: blockedBy1,
      chatId: groupChatId,
      senderId: blockedByAuthorId,
      content: 'blocked-by author message',
      type: 'user',
      createdAt: at(4),
    },
    {
      id: viewer1,
      chatId: groupChatId,
      senderId: viewerId,
      content: 'viewer own message',
      type: 'user',
      createdAt: at(5),
    },
    {
      id: system1,
      chatId: groupChatId,
      senderId: 'system',
      content: 'system notice',
      type: 'system',
      createdAt: at(6),
    },
    {
      // A visible reply quoting the blocked author's message: the quote
      // must not leak the hidden content back into the viewer's feed.
      id: normal2,
      chatId: groupChatId,
      senderId: normalAuthorId,
      content: 'normal reply to blocked',
      type: 'user',
      createdAt: at(7),
      replyToMessageId: blocked1,
    },
    {
      id: dm1,
      chatId: dmChatId,
      senderId: blockedAuthorId,
      content: 'dm message from blocked author',
      type: 'user',
      createdAt: at(8),
    },
  ]);
});

afterAll(async () => {
  await db.delete(messages).where(eq(messages.chatId, groupChatId));
  await db.delete(messages).where(eq(messages.chatId, dmChatId));
  await db
    .delete(chatParticipants)
    .where(eq(chatParticipants.chatId, groupChatId));
  await db
    .delete(chatParticipants)
    .where(eq(chatParticipants.chatId, dmChatId));
  await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  await db.delete(userBlocks).where(eq(userBlocks.blockerId, viewerId));
  await db.delete(userBlocks).where(eq(userBlocks.blockedId, viewerId));
  await db.delete(userMutes).where(eq(userMutes.muterId, viewerId));
  await db.delete(chats).where(eq(chats.id, groupChatId));
  await db.delete(chats).where(eq(chats.id, dmChatId));
  await db.delete(groups).where(eq(groups.id, groupId));
  for (const userId of allUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('GET /api/chats/[id] group chat viewer moderation', () => {
  it('hides blocked, muted, and blocked-by authors from the group message list', async () => {
    const { status, payload } = await getChat(groupChatId, viewerId);
    expect(status).toBe(200);
    const ids = (payload?.messages ?? []).map((m) => m.id);
    expect(ids).toEqual([normalMsg1, viewerMsg, systemMsg, normalMsg2]);
    const senders = new Set((payload?.messages ?? []).map((m) => m.senderId));
    expect(senders.has(blockedAuthorId)).toBe(false);
    expect(senders.has(mutedAuthorId)).toBe(false);
    expect(senders.has(blockedByAuthorId)).toBe(false);
  });

  it('does not leak a hidden message back through a reply quote', async () => {
    const { payload } = await getChat(groupChatId, viewerId);
    const reply = (payload?.messages ?? []).find((m) => m.id === normalMsg2);
    expect(reply).toBeDefined();
    expect(reply?.replyToMessage).toBeNull();
  });

  it('pages through only the visible messages', async () => {
    const page1 = await getChat(groupChatId, viewerId, '?limit=2');
    expect((page1.payload?.messages ?? []).map((m) => m.id)).toEqual([
      systemMsg,
      normalMsg2,
    ]);
    expect(page1.payload?.pagination.hasMore).toBe(true);
    const cursor = page1.payload?.pagination.nextCursor;
    expect(cursor).toBe(systemMsg);

    const page2 = await getChat(
      groupChatId,
      viewerId,
      `?cursor=${cursor}&limit=2`
    );
    expect((page2.payload?.messages ?? []).map((m) => m.id)).toEqual([
      normalMsg1,
      viewerMsg,
    ]);
    expect(page2.payload?.pagination.hasMore).toBe(false);
  });

  it('leaves DM history untouched (separate surface)', async () => {
    const { status, payload } = await getChat(dmChatId, viewerId);
    expect(status).toBe(200);
    expect((payload?.messages ?? []).map((m) => m.id)).toEqual([
      dmMsgFromBlocked,
    ]);
  });
});
