/**
 * GET /api/chats/unread-count against a real database: the chat badge must
 * not count chat notifications the viewer cannot see anywhere.
 *
 * Chat message notifications are created per message with the sender as
 * actorId (notifyDMMessage / notifyGroupChatMessage). Creation skips
 * blocked pairs, but a mute never stops creation, and a block placed later
 * does not remove notifications created before it — so the established
 * rule for every other notification read surface is to exclude blocked,
 * muted and blocking actors at read time: GET /api/notifications applies
 * the predicate to both its list and its unread count ("The unread count
 * uses the same predicate so the badge never counts hidden items"), and
 * the A2A notifications handler does the same. The chat badge endpoint is
 * the one read path that still counts every unread chat notification, so
 * after muting a sender the badge keeps rising on messages that are
 * hidden from the chat history, the chat-list preview and the
 * notification list alike.
 *
 * Requests use the existing CI-only synthetic Steward bearer. The only
 * stub is the `server-only` marker package; the route, the moderation
 * helpers and the database all run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  db,
  eq,
  inArray,
  notifications,
  or,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type UnreadCountResponse = {
  pendingDMs: number;
  pendingDMRequests: number;
  unreadMessages: number;
  hasNewMessages: boolean;
};

let viewerId: string;
let visibleId: string;
let mutedId: string;
let blockedId: string;
let blockerId: string;
let plainViewerId: string;
let chatId: string;
let usersInserted = false;

let GET: typeof import('../../../apps/web/src/app/api/chats/unread-count/route').GET;

async function fetchUnreadCount(userId: string) {
  const request = new NextRequest(
    new Request('http://localhost/api/chats/unread-count', {
      headers: { authorization: `Bearer steward:test:${userId}` },
    })
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as UnreadCountResponse;
}

async function insertChatNotification(
  userId: string,
  actorId: string | null,
  read: boolean,
  withChat = true
) {
  await db.insert(notifications).values({
    id: await generateSnowflakeId(),
    userId,
    type: 'system',
    actorId,
    chatId: withChat ? chatId : null,
    title: 'New Message',
    message: 'fixture message',
    read,
  });
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/chats/unread-count/route'
  ));

  [viewerId, visibleId, mutedId, blockedId, blockerId, plainViewerId, chatId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

  const now = new Date();
  await db.insert(users).values(
    [viewerId, visibleId, mutedId, blockedId, blockerId, plainViewerId].map(
      (id) => ({
        id,
        username: `test-chat-unread-${id}`,
        displayName: 'Chat unread count fixture',
        updatedAt: now,
      })
    )
  );
  usersInserted = true;

  await db.insert(userMutes).values({
    id: await generateSnowflakeId(),
    muterId: viewerId,
    mutedId,
  });
  await db.insert(userBlocks).values([
    { id: await generateSnowflakeId(), blockerId: viewerId, blockedId },
    { id: await generateSnowflakeId(), blockerId, blockedId: viewerId },
  ]);

  // Viewer fixtures: unread chat notifications per actor class.
  await insertChatNotification(viewerId, visibleId, false);
  await insertChatNotification(viewerId, visibleId, false);
  await insertChatNotification(viewerId, mutedId, false);
  await insertChatNotification(viewerId, mutedId, false);
  await insertChatNotification(viewerId, mutedId, false);
  // As if created before the block was placed.
  await insertChatNotification(viewerId, blockedId, false);
  await insertChatNotification(viewerId, blockerId, false);
  // System chat notification (null actor) is always visible.
  await insertChatNotification(viewerId, null, false);
  // Already read: never counted in either state.
  await insertChatNotification(viewerId, mutedId, true);
  // Unread but not a chat notification: never part of the chat badge.
  await insertChatNotification(viewerId, mutedId, false, false);

  // Plain viewer with no moderation relations sees the raw count.
  await insertChatNotification(plainViewerId, visibleId, false);
  await insertChatNotification(plainViewerId, mutedId, false);
});

afterAll(async () => {
  if (!usersInserted) return;
  await db
    .delete(notifications)
    .where(inArray(notifications.userId, [viewerId, plainViewerId]));
  await db
    .delete(userBlocks)
    .where(
      or(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, viewerId))
    );
  await db.delete(userMutes).where(eq(userMutes.muterId, viewerId));
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        viewerId,
        visibleId,
        mutedId,
        blockedId,
        blockerId,
        plainViewerId,
      ])
    );
});

describe('GET /api/chats/unread-count moderation', () => {
  it('counts only the unread chat notifications the viewer can see', async () => {
    const body = await fetchUnreadCount(viewerId);
    // Visible sender (2) + system/null actor (1). Muted (3), blocked (1)
    // and blocking (1) actors are hidden on every other read surface.
    expect(body.unreadMessages).toBe(3);
    expect(body.pendingDMRequests).toBe(0);
    expect(body.pendingDMs).toBe(3);
    expect(body.hasNewMessages).toBe(true);
  });

  it('keeps the raw count for a viewer with no moderation relations', async () => {
    const body = await fetchUnreadCount(plainViewerId);
    expect(body.unreadMessages).toBe(2);
    expect(body.pendingDMs).toBe(2);
  });
});
