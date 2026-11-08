/**
 * GET /api/chats against a real database: a DM the viewer has left must
 * not appear in the viewer's chat list.
 *
 * Leaving a chat through the agent clients (MCP `leave_chat`, A2A
 * `leaveChat`) keeps the ChatParticipant row and sets `isActive: false`.
 * Every other chat surface treats that row as "no longer a member":
 * GET /api/chats/[id] requires `isActive: true` for access, the A2A
 * getChats list filters the caller's memberships by `isActive: true`,
 * and the DM service only matches DM chats where both participants are
 * active. But the web chat list built its DM section from every
 * ChatParticipant row of the viewer regardless of isActive, so a DM the
 * viewer had left stayed in the list — with a live last-message preview —
 * even though opening it is denied by the detail route.
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
  inArray,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let viewerId: string;
let otherId: string;
let activeChatId: string;
let leftChatId: string;
const allUserIds: string[] = [];
const allChatIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/chats/route').GET;

async function listChats() {
  const request = new NextRequest(
    new Request('http://localhost/api/chats', {
      method: 'GET',
      headers: {
        authorization: `Bearer steward:test:${viewerId}`,
      },
    })
  );
  const res = await GET(request);
  return res.json() as Promise<{
    groupChats: Array<{ id: string }>;
    directChats: Array<{
      id: string;
      lastMessage: { content: string } | null;
    }>;
    total: number;
  }>;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/route'));

  [viewerId, otherId, activeChatId, leftChatId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allUserIds.push(viewerId, otherId);
  allChatIds.push(activeChatId, leftChatId);

  const now = new Date();

  await db.insert(users).values([
    {
      id: viewerId,
      username: `test-g2-viewer-${viewerId}`,
      displayName: 'G2 Viewer',
      updatedAt: now,
    },
    {
      id: otherId,
      username: `test-g2-other-${otherId}`,
      displayName: 'G2 Other',
      updatedAt: now,
    },
  ]);

  await db.insert(chats).values([
    {
      id: activeChatId,
      name: null,
      isGroup: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: leftChatId,
      name: null,
      isGroup: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const participantIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  await db.insert(chatParticipants).values([
    // Active DM: both participants active.
    {
      id: participantIds[0]!,
      chatId: activeChatId,
      userId: viewerId,
      isActive: true,
      joinedAt: now,
    },
    {
      id: participantIds[1]!,
      chatId: activeChatId,
      userId: otherId,
      isActive: true,
      joinedAt: now,
    },
    // Left DM: the viewer's row is in the exact post-leave state the MCP
    // and A2A leave_chat handlers write (row kept, isActive false); the
    // other participant is still active.
    {
      id: participantIds[2]!,
      chatId: leftChatId,
      userId: viewerId,
      isActive: false,
      joinedAt: now,
    },
    {
      id: participantIds[3]!,
      chatId: leftChatId,
      userId: otherId,
      isActive: true,
      joinedAt: now,
    },
  ]);

  const messageIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(messages).values([
    {
      id: messageIds[0]!,
      chatId: activeChatId,
      senderId: otherId,
      content: 'G2 active DM latest message',
      createdAt: new Date(now.getTime() + 1000),
    },
    {
      id: messageIds[1]!,
      chatId: leftChatId,
      senderId: otherId,
      content: 'G2 left DM latest message',
      createdAt: new Date(now.getTime() + 2000),
    },
  ]);
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.chatId, allChatIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, allChatIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/chats DM list and left chats', () => {
  it('lists the active DM with its last message', async () => {
    const data = await listChats();
    const active = data.directChats.find((c) => c.id === activeChatId);
    expect(active).toBeDefined();
    expect(active!.lastMessage?.content).toBe('G2 active DM latest message');
  });

  it('does not list a DM the viewer has left', async () => {
    const data = await listChats();
    const left = data.directChats.find((c) => c.id === leftChatId);
    expect(left).toBeUndefined();
    expect(data.total).toBe(data.groupChats.length + data.directChats.length);
  });
});
