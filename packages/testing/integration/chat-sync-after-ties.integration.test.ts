/**
 * Real database: GET /api/chats/[id] incremental sync (`after`) must not
 * skip messages that share a millisecond.
 *
 * The web client syncs missed messages by paging `?after=<createdAt>` and
 * advancing the watermark to the last received message ("Paginates until
 * hasMore is false so long disconnects don't silently drop messages" —
 * useChatMessages.syncNewMessages). createdAt is a millisecond timestamp
 * and bursts of messages routinely share it, so a timestamp-only position
 * loses two kinds of messages forever (the watermark only moves forward):
 *   1. a burst larger than one page that straddles a sync page boundary —
 *      the rest of the burst shares the boundary message's millisecond;
 *   2. messages created in the watermark message's own millisecond.
 * Passing the newest held message's id as `afterId` pins the position to
 * the (createdAt, id) pair and the walk delivers every missed message
 * exactly once. The route handler is exercised unmodified against a real
 * database. PRD §12 / MVP phase 5: the existing chronological contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

type ChatPage = {
  messages: Array<{ id: string; createdAt: string }>;
  pagination: { hasMore: boolean; nextCursor: string | null; limit: number };
};

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

const viewer = await generateSnowflakeId();
const sender = await generateSnowflakeId();
const ownedUsers: string[] = [viewer, sender];
const ownedChats: string[] = [];
const ownedMessages: string[] = [];
const ownedParticipants: string[] = [];

const HOUR = 3600_000;
const baseTime = Date.now() - 6 * HOUR;

async function makeChat(): Promise<string> {
  const chatId = await generateSnowflakeId();
  ownedChats.push(chatId);
  const now = new Date();
  await db.insert(chats).values({
    id: chatId,
    name: `Chat sync fixture ${chatId}`,
    isGroup: true,
    createdBy: viewer,
    updatedAt: now,
  });
  for (const userId of [viewer, sender]) {
    const pid = await generateSnowflakeId();
    ownedParticipants.push(pid);
    await db
      .insert(chatParticipants)
      .values({ id: pid, chatId, userId, isActive: true });
  }
  return chatId;
}

async function addMessage(
  chatId: string,
  createdAtMs: number,
  label: string
): Promise<string> {
  const id = await generateSnowflakeId();
  ownedMessages.push(id);
  await db.insert(messages).values({
    id,
    chatId,
    senderId: sender,
    content: `chat-sync-${label}-${id}`,
    createdAt: new Date(createdAtMs),
  });
  return id;
}

async function getChat(
  chatId: string,
  query: Record<string, string>
): Promise<{ status: number; body: ChatPage & { error?: unknown } }> {
  const qs = new URLSearchParams(query).toString();
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}?${qs}`, {
      headers: { 'x-dev-user-id': viewer },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: chatId }),
  });
  const body = (await response.json().catch(() => null)) as ChatPage & {
    error?: unknown;
  };
  return { status: response.status, body };
}

/**
 * Mirror of useChatMessages.syncNewMessages with the fix applied: the
 * position advances as the (createdAt, id) pair of the last received
 * message, merges dedupe by id, and the walk stops on an empty page or
 * hasMore=false.
 */
async function syncWalk(
  chatId: string,
  watermark: { id: string; createdAtMs: number },
  limit: number,
  sendAfterId: boolean
): Promise<string[]> {
  const collected: string[] = [];
  const seenIds = new Set<string>([watermark.id]);
  let afterMs = watermark.createdAtMs;
  let afterId = watermark.id;
  for (let page = 0; page < 10; page++) {
    const query: Record<string, string> = {
      after: new Date(afterMs).toISOString(),
      limit: String(limit),
    };
    if (sendAfterId) query.afterId = afterId;
    const res = await getChat(chatId, query);
    if (res.status !== 200) throw new Error(`sync ${res.status}`);
    const rows = res.body.messages;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        collected.push(row.id);
      }
    }
    if (!res.body.pagination.hasMore) break;
    const last = rows[rows.length - 1]!;
    afterMs = new Date(last.createdAt).getTime();
    afterId = last.id;
  }
  return collected;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));
  const now = new Date();
  await db.insert(users).values(
    [viewer, sender].map((id) => ({
      id,
      username: `chat-sync-fixture-${id}`,
      displayName: `Chat sync fixture ${id}`,
      stewardId: `chat-sync-steward-${id}`,
      updatedAt: now,
    }))
  );
});

afterAll(async () => {
  if (ownedMessages.length)
    await db.delete(messages).where(inArray(messages.id, ownedMessages));
  if (ownedParticipants.length)
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, ownedParticipants));
  if (ownedChats.length)
    await db.delete(chats).where(inArray(chats.id, ownedChats));
  if (ownedUsers.length)
    await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('chat incremental sync (real database)', () => {
  it('delivers a same-millisecond burst that straddles the sync page boundary', async () => {
    const chatId = await makeChat();
    const t = baseTime;
    const w0 = await addMessage(chatId, t, 'watermark');
    const burst: string[] = [];
    for (let i = 0; i < 5; i++)
      burst.push(await addMessage(chatId, t + 60_000, `burst${i}`));
    const tail = await addMessage(chatId, t + 120_000, 'tail');

    const collected = await syncWalk(
      chatId,
      { id: w0, createdAtMs: t },
      3,
      true
    );
    expect([...collected].sort()).toEqual([...burst, tail].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('delivers messages created in the watermark millisecond itself', async () => {
    const chatId = await makeChat();
    const t = baseTime + 10 * HOUR;
    const w0 = await addMessage(chatId, t, 'watermark');
    const sameMs: string[] = [];
    sameMs.push(await addMessage(chatId, t, 'same1'));
    sameMs.push(await addMessage(chatId, t, 'same2'));
    const later = await addMessage(chatId, t + 5000, 'later');

    const collected = await syncWalk(
      chatId,
      { id: w0, createdAtMs: t },
      10,
      true
    );
    expect([...collected].sort()).toEqual([...sameMs, later].sort());
  });

  it('keeps the legacy timestamp-only walk complete for distinct timestamps', async () => {
    const chatId = await makeChat();
    const t = baseTime + 20 * HOUR;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++)
      ids.push(await addMessage(chatId, t + i * 1000, `d-${i}`));

    const collected = await syncWalk(
      chatId,
      { id: ids[2]!, createdAtMs: t + 2000 },
      3,
      false
    );
    expect([...collected].sort()).toEqual([...ids.slice(3)].sort());
  });

  it('rejects an afterId anchored in another chat', async () => {
    const chatId = await makeChat();
    const otherChatId = await makeChat();
    const t = baseTime + 30 * HOUR;
    const foreign = await addMessage(otherChatId, t, 'foreign');
    await addMessage(chatId, t, 'own');

    const res = await getChat(chatId, {
      after: new Date(t - 1000).toISOString(),
      afterId: foreign,
      limit: '10',
    });
    expect(res.status).not.toBe(200);
  });

  it('rejects afterId without after', async () => {
    const chatId = await makeChat();
    const t = baseTime + 40 * HOUR;
    const own = await addMessage(chatId, t, 'own');

    const res = await getChat(chatId, { afterId: own, limit: '10' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
