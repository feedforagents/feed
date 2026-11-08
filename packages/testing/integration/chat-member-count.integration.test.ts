/**
 * GET /api/chats/[id] against a real database: the group chat header
 * renders "{N} participants" (ChatViewHeader) from this response, and N
 * must be the room's current member count.
 *
 * A ChatParticipant row is soft state: leaving through the A2A or MCP
 * client, a tier promotion/demotion, or an agent kick/leave all keep the
 * row with `isActive: false` instead of deleting it, and leaving through
 * the web deletes the row entirely. Every membership check in the app
 * reads the flag — this route's own access check requires the caller's
 * row to be active, and the dedicated participants list is being fixed
 * to active-only (#1668) for the same reason. But this route builds its
 * participants array from every row regardless of the flag and appends
 * message senders who have no row at all, because the array's job is to
 * resolve sender names for old messages (MessageList). The header then
 * renders the array's length as the member count, so departed members —
 * inactive rows and row-less senders alike — are counted as if they were
 * still in the room, and the count even grows with whoever happens to
 * appear in the currently loaded message page.
 *
 * The fix keeps the array exactly as it is (departed senders keep their
 * names) and reports the current member count separately as
 * `chat.memberCount`: the number of active participant rows, the same
 * membership rule the route's access check and #1668 apply.
 *
 * Requests use the existing CI-only synthetic Steward bearer. The only
 * stub is the `server-only` marker package; every database dependency
 * runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  chatParticipants,
  chats,
  db,
  eq,
  groups,
  inArray,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const bearer = (id: string) =>
  ['Bearer', ['steward', 'test', id].join(':')].join(' ');

let viewerId: string;
let memberId: string;
let departedSenderId: string;
let departedSilentId: string;
let rowlessSenderId: string;
let groupId: string;
let chatId: string;
let activeChatId: string;
const allUserIds: string[] = [];
const allChatIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

interface ChatBody {
  chat?: { memberCount?: number };
  participants?: Array<{ id: string; displayName?: string }>;
}

async function fetchChat(id: string): Promise<ChatBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${id}`, {
      headers: { authorization: bearer(viewerId) },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data?: ChatBody } & ChatBody;
  return body.data ?? body;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));

  const ids = await Promise.all(
    Array.from({ length: 9 }, () => generateSnowflakeId())
  );
  viewerId = ids[0]!;
  memberId = ids[1]!;
  departedSenderId = ids[2]!;
  departedSilentId = ids[3]!;
  rowlessSenderId = ids[4]!;
  groupId = ids[5]!;
  chatId = ids[6]!;
  activeChatId = ids[7]!;
  const extraGroupId = ids[8]!;
  allUserIds.push(
    viewerId,
    memberId,
    departedSenderId,
    departedSilentId,
    rowlessSenderId
  );
  allChatIds.push(chatId, activeChatId);

  const now = new Date();
  await db.insert(users).values(
    [
      [viewerId, 'Viewer'],
      [memberId, 'Member'],
      [departedSenderId, 'Departed Sender'],
      [departedSilentId, 'Departed Silent'],
      [rowlessSenderId, 'Rowless Sender'],
    ].map(([id, name]) => ({
      id: id!,
      username: `f78-${name!.toLowerCase().replace(' ', '-')}-${id}`,
      displayName: `F78 ${name}`,
      updatedAt: now,
    }))
  );

  await db.insert(groups).values([
    {
      id: groupId,
      name: 'F78 Member Count Group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: extraGroupId,
      name: 'F78 All Active Group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(chats).values([
    {
      id: chatId,
      name: 'F78 Member Count Group',
      isGroup: true,
      groupId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: activeChatId,
      name: 'F78 All Active Group',
      isGroup: true,
      groupId: extraGroupId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const row = async (chat: string, userId: string, isActive: boolean) => ({
    id: await generateSnowflakeId(),
    chatId: chat,
    userId,
    isActive,
    joinedAt: now,
  });
  await db.insert(chatParticipants).values([
    // The room under test: two current members, two departed members
    // whose rows remain as soft state.
    await row(chatId, viewerId, true),
    await row(chatId, memberId, true),
    await row(chatId, departedSenderId, false),
    await row(chatId, departedSilentId, false),
    // A second room where everyone is a current member.
    await row(activeChatId, viewerId, true),
    await row(activeChatId, memberId, true),
    await row(activeChatId, departedSenderId, true),
  ]);

  const msg = async (chat: string, senderId: string, content: string) => ({
    id: await generateSnowflakeId(),
    chatId: chat,
    senderId,
    content,
    createdAt: now,
  });
  await db.insert(messages).values([
    await msg(chatId, memberId, 'Still here.'),
    await msg(chatId, departedSenderId, 'Last note before I was moved out.'),
    // The row-less sender left through the web, which deletes the
    // participant row; only their messages remain.
    await msg(chatId, rowlessSenderId, 'I left through the web earlier.'),
  ]);
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.chatId, allChatIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, allChatIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(groups).where(eq(groups.ownerId, viewerId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/chats/[id] member count for the room header', () => {
  it('counts only current members, not departed rows or senders', async () => {
    const body = await fetchChat(chatId);
    // Two active rows; the header must not count the two inactive rows
    // or the row-less departed sender.
    expect(body.chat?.memberCount).toBe(2);
  });

  it('keeps departed senders in the array so old messages keep names', async () => {
    const body = await fetchChat(chatId);
    const byId = new Map((body.participants ?? []).map((p) => [p.id, p]));

    expect(body.participants?.length).toBe(5);
    expect(byId.get(departedSenderId)?.displayName).toBe('F78 Departed Sender');
    expect(byId.get(departedSilentId)?.displayName).toBe('F78 Departed Silent');
    expect(byId.get(rowlessSenderId)?.displayName).toBe('F78 Rowless Sender');
  });

  it('counts every member when all rows are active', async () => {
    const body = await fetchChat(activeChatId);
    expect(body.chat?.memberCount).toBe(3);
    expect(body.participants?.length).toBe(3);
  });
});
