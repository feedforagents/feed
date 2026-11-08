/**
 * GET /api/chats/[id] against a real database: cursor (load-older)
 * pagination must reach every message in the room, including messages
 * that share the exact same createdAt millisecond as the message the
 * page boundary landed on.
 *
 * Message createdAt values are millisecond timestamps (JS Date on every
 * write path), so bursts — an agent or NPC posting back-to-back, paired
 * system messages — routinely share a millisecond. The list ordered by
 * createdAt alone and resumed with `createdAt < cursor.createdAt`, so
 * when a page boundary fell inside a same-millisecond group, the rest of
 * that group was on neither page: not in the page just returned (cut off
 * by LIMIT) and not in any later page (excluded by the strict <). The
 * posts feed had the same defect class (see the open keyset-cursor fix
 * for posts); this suite pins the chat-history walk: following
 * nextCursor to the end must yield every message exactly once.
 *
 * Auth uses the dev x-dev-user-id bypass (NODE_ENV=test), the same
 * pattern as the notifications integration suites. The only stub is the
 * `server-only` marker package; every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { chatParticipants, chats, db, eq, messages, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ChatResponse = {
  messages: Array<{ id: string; createdAt: string }>;
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
};

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

let viewerId: string;
let senderId: string;
let chatId: string;
const allMessageIds: string[] = [];

async function fetchChatPage(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}?${qs}`, {
      headers: { 'x-dev-user-id': viewerId },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: chatId }),
  });
  const body = (await response.json().catch(() => null)) as ChatResponse | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));

  [viewerId, senderId, chatId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  await db.insert(users).values([
    {
      id: viewerId,
      username: `test-g11-viewer-${viewerId}`,
      displayName: 'G11 Viewer',
      updatedAt: now,
    },
    {
      id: senderId,
      username: `test-g11-sender-${senderId}`,
      displayName: 'G11 Sender',
      updatedAt: now,
    },
  ]);

  await db.insert(chats).values({
    id: chatId,
    name: 'G11 Cursor Chat',
    isGroup: true,
    createdAt: now,
    updatedAt: now,
  });

  const participantIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(chatParticipants).values([
    { id: participantIds[0], chatId, userId: viewerId, isActive: true },
    { id: participantIds[1], chatId, userId: senderId, isActive: true },
  ]);

  // Seven messages; the middle three share one createdAt millisecond, so
  // a 3-per-page walk cuts the tie group in two.
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  const offsets = [0, 1000, 2000, 2000, 2000, 3000, 4000];
  for (const offset of offsets) {
    const id = await generateSnowflakeId();
    allMessageIds.push(id);
    await db.insert(messages).values({
      id,
      chatId,
      senderId,
      content: `g11 message at +${offset}ms`,
      createdAt: new Date(base + offset),
    });
  }
});

afterAll(async () => {
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatParticipants).where(eq(chatParticipants.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(eq(users.id, viewerId));
  await db.delete(users).where(eq(users.id, senderId));
});

describe('GET /api/chats/[id] message history pagination', () => {
  it('returns the newest page first with hasMore set', async () => {
    const { status, body } = await fetchChatPage({ limit: '3' });
    expect(status).toBe(200);
    expect(body?.messages).toHaveLength(3);
    expect(body?.pagination.hasMore).toBe(true);
    expect(body?.pagination.nextCursor).not.toBeNull();
    // Newest message (base + 4000ms) must head the history.
    expect(body?.messages[body.messages.length - 1]?.id).toBe(
      allMessageIds[allMessageIds.length - 1]
    );
  });

  it('walking nextCursor to the end yields every message exactly once, including same-millisecond ones', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const params: Record<string, string> = { limit: '3' };
      if (cursor) params.cursor = cursor;
      const { status, body } = await fetchChatPage(params);
      expect(status).toBe(200);
      for (const m of body?.messages ?? []) seen.push(m.id);
      if (!body?.pagination.hasMore) break;
      cursor = body.pagination.nextCursor;
      expect(cursor).not.toBeNull();
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect([...seen].sort()).toEqual([...allMessageIds].sort());
  });
});
