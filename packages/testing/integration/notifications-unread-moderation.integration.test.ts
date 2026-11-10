/**
 * GET /api/notifications against a real database: the unread badge count
 * must agree with the moderated list it is returned with.
 *
 * The list excludes notifications from actors the viewer blocked, muted or
 * was blocked by; a count that still includes them shows unread items the
 * viewer can never open. Uses the real HTTP listener and the built-in CI test authentication.
 * The database, moderation predicates and route are unmodified.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

type NotificationsResponse = {
  notifications: Array<{ id: string; read: boolean; actorId: string | null }>;
  unreadCount: number;
};

let viewerId: string;
let mutedId: string;
let blockedId: string;
let blockerId: string;
let visibleId: string;
let plainViewerId: string;
let currentViewerId: string;
let usersInserted = false;
const ids = {
  muted: '',
  blocked: '',
  blockedBy: '',
  visibleUnread: '',
  systemUnread: '',
  visibleRead: '',
  plainLikeUnread: '',
  plainFollowUnread: '',
  plainLikeRead: '',
};

beforeAll(async () => {
  viewerId = await generateSnowflakeId();
  mutedId = await generateSnowflakeId();
  blockedId = await generateSnowflakeId();
  blockerId = await generateSnowflakeId();
  visibleId = await generateSnowflakeId();
  plainViewerId = await generateSnowflakeId();
  currentViewerId = viewerId;

  const now = new Date();
  await db.insert(users).values(
    [viewerId, mutedId, blockedId, blockerId, visibleId, plainViewerId].map(
      (id) => ({
        id,
        username: `test-notif-${id}`,
        displayName: 'Notification moderation fixture',
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
    {
      id: await generateSnowflakeId(),
      blockerId,
      blockedId: viewerId,
    },
  ]);

  const rows: Array<{
    key: keyof typeof ids;
    actorId: string | null;
    read: boolean;
  }> = [
    { key: 'muted', actorId: mutedId, read: false },
    { key: 'blocked', actorId: blockedId, read: false },
    { key: 'blockedBy', actorId: blockerId, read: false },
    { key: 'visibleUnread', actorId: visibleId, read: false },
    { key: 'systemUnread', actorId: null, read: false },
    { key: 'visibleRead', actorId: visibleId, read: true },
  ];
  for (const [index, row] of rows.entries()) {
    ids[row.key] = await generateSnowflakeId();
    await db.insert(notifications).values({
      id: ids[row.key],
      userId: viewerId,
      type: 'system',
      actorId: row.actorId,
      title: `fixture ${row.key}`,
      message: `fixture ${row.key}`,
      read: row.read,
      createdAt: new Date(now.getTime() - index * 1000),
    });
  }

  // A viewer with no blocks or mutes, across notification types.
  const plainRows: Array<{
    key: keyof typeof ids;
    type: string;
    read: boolean;
  }> = [
    { key: 'plainLikeUnread', type: 'like', read: false },
    { key: 'plainFollowUnread', type: 'follow', read: false },
    { key: 'plainLikeRead', type: 'like', read: true },
  ];
  for (const [index, row] of plainRows.entries()) {
    ids[row.key] = await generateSnowflakeId();
    await db.insert(notifications).values({
      id: ids[row.key],
      userId: plainViewerId,
      type: row.type,
      actorId: visibleId,
      title: `fixture ${row.key}`,
      message: `fixture ${row.key}`,
      read: row.read,
      createdAt: new Date(now.getTime() - index * 1000),
    });
  }
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
        mutedId,
        blockedId,
        blockerId,
        visibleId,
        plainViewerId,
      ])
    );
});

async function fetchNotifications(query: string) {
  const baseUrl =
    process.env.TEST_API_URL ||
    process.env.TEST_BASE_URL ||
    'http://127.0.0.1:3100';
  const response = await fetch(new URL(`/api/notifications${query}`, baseUrl), {
    headers: { authorization: `Bearer steward:test:${currentViewerId}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as NotificationsResponse;
}

describe('GET /api/notifications unread count without moderation', () => {
  it('counts every unread notification regardless of type filter or page', async () => {
    currentViewerId = plainViewerId;
    try {
      const all = await fetchNotifications('');
      expect(all.notifications).toHaveLength(3);
      expect(all.unreadCount).toBe(2);

      const likes = await fetchNotifications('?type=like');
      expect(likes.notifications.map((n) => n.id)).toEqual([
        ids.plainLikeUnread,
        ids.plainLikeRead,
      ]);
      expect(likes.unreadCount).toBe(2);

      const firstPage = await fetchNotifications('?limit=1');
      expect(firstPage.notifications.map((n) => n.id)).toEqual([
        ids.plainLikeUnread,
      ]);
      expect(firstPage.unreadCount).toBe(2);
    } finally {
      currentViewerId = viewerId;
    }
  });
});

describe('GET /api/notifications unread count with moderation', () => {
  it('lists only notifications from visible and system actors', async () => {
    const body = await fetchNotifications('');
    expect(body.notifications.map((n) => n.id)).toEqual([
      ids.visibleUnread,
      ids.systemUnread,
      ids.visibleRead,
    ]);
  });

  it('counts only the unread notifications the list can show', async () => {
    const body = await fetchNotifications('');
    const visibleUnread = body.notifications.filter((n) => !n.read).length;
    expect(visibleUnread).toBe(2);
    expect(body.unreadCount).toBe(visibleUnread);
  });

  it('keeps the same count with unreadOnly=false', async () => {
    const body = await fetchNotifications('?unreadOnly=false');
    expect(body.notifications).toHaveLength(3);
    expect(body.unreadCount).toBe(2);
  });

  it('keeps the same count with unreadOnly=true', async () => {
    const body = await fetchNotifications('?unreadOnly=true');
    expect(body.notifications.map((n) => n.id)).toEqual([
      ids.visibleUnread,
      ids.systemUnread,
    ]);
    expect(body.unreadCount).toBe(2);
  });
});
