/**
 * messaging.get_notifications against a real database: the A2A notification
 * list must apply the same read-time moderation filter as the web list
 * (GET /api/notifications).
 *
 * The web list excludes notifications whose actor is blocked by the user,
 * muted by the user, or has blocked the user — in the query itself, with
 * the note "system notifications have a null actor and are always kept".
 * That read-time filter is what makes a mute effective (muting never stops
 * notification creation) and what hides earlier notifications when a block
 * is placed later. The A2A executor's getNotificationsHandler applied no
 * filter at all, so an agent reading the user's notifications received
 * every notification the web list hides — including DM/group message
 * previews from muted and blocked senders.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  inArray,
  notifications,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type NotificationsResult = {
  unreadCount: number;
  notifications: Array<{ id: string; message: string }>;
};

let recipientId: string;
let normalActorId: string;
let mutedActorId: string;
let blockedActorId: string;
let blockerActorId: string;

let normalNotificationId: string;
let mutedNotificationId: string;
let blockedNotificationId: string;
let blockerNotificationId: string;
let systemNotificationId: string;

const allUserIds: string[] = [];
const allNotificationIds: string[] = [];

async function fetchNotifications() {
  const result = (await FeedAgentExecutor.executeDirectly(
    'messaging.get_notifications',
    { limit: 50 },
    recipientId
  )) as unknown as NotificationsResult;
  return result;
}

beforeAll(async () => {
  [
    recipientId,
    normalActorId,
    mutedActorId,
    blockedActorId,
    blockerActorId,
    normalNotificationId,
    mutedNotificationId,
    blockedNotificationId,
    blockerNotificationId,
    systemNotificationId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allUserIds.push(
    recipientId,
    normalActorId,
    mutedActorId,
    blockedActorId,
    blockerActorId
  );
  allNotificationIds.push(
    normalNotificationId,
    mutedNotificationId,
    blockedNotificationId,
    blockerNotificationId,
    systemNotificationId
  );

  const now = new Date();
  const at = (secondsAgo: number) =>
    new Date(now.getTime() - secondsAgo * 1000);

  await db.insert(users).values(
    allUserIds.map((id, i) => ({
      id,
      username: `f8-${i}-${id}`,
      displayName: `F8 Fixture ${i}`,
      updatedAt: now,
    }))
  );

  // The recipient muted one actor, blocked another, and is blocked by a
  // third — the three sets the web list excludes at read time.
  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(userBlocks).values([
    { id: blockRowA, blockerId: recipientId, blockedId: blockedActorId },
    { id: blockRowB, blockerId: blockerActorId, blockedId: recipientId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: recipientId, mutedId: mutedActorId }]);

  // One notification per actor, plus a null-actor system notification.
  // The muted actor's row is a DM preview (chatId set), the shape whose
  // message text is only ever hidden by the read-time filter.
  await db.insert(notifications).values([
    {
      id: normalNotificationId,
      userId: recipientId,
      type: 'follow',
      actorId: normalActorId,
      title: 'New Follower',
      message: 'Normal actor started following you',
      read: false,
      createdAt: at(50),
    },
    {
      id: mutedNotificationId,
      userId: recipientId,
      type: 'system',
      actorId: mutedActorId,
      chatId: mutedActorId,
      title: 'New Message',
      message: 'Muted actor: a direct message preview that must stay hidden',
      read: false,
      createdAt: at(40),
    },
    {
      id: blockedNotificationId,
      userId: recipientId,
      type: 'comment',
      actorId: blockedActorId,
      title: 'New Comment',
      message: 'Blocked actor commented on your post',
      read: false,
      createdAt: at(30),
    },
    {
      id: blockerNotificationId,
      userId: recipientId,
      type: 'reaction',
      actorId: blockerActorId,
      title: 'New Reaction',
      message: 'Blocking actor liked your post',
      read: false,
      createdAt: at(20),
    },
    {
      id: systemNotificationId,
      userId: recipientId,
      type: 'system',
      actorId: null,
      title: 'Welcome to Feed',
      message: 'Welcome to Feed! Edit your profile details.',
      read: false,
      createdAt: at(10),
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(inArray(notifications.id, allNotificationIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('A2A messaging.get_notifications moderation filter', () => {
  it('hides notifications from muted, blocked, and blocking actors', async () => {
    const { notifications: list } = await fetchNotifications();
    const ids = list.map((n) => n.id);
    expect(ids).toContain(normalNotificationId);
    expect(ids).toContain(systemNotificationId);
    expect(ids).not.toContain(mutedNotificationId);
    expect(ids).not.toContain(blockedNotificationId);
    expect(ids).not.toContain(blockerNotificationId);
    expect(JSON.stringify(list)).not.toContain(
      'a direct message preview that must stay hidden'
    );
  });

  it('counts only the visible unread notifications', async () => {
    const { unreadCount } = await fetchNotifications();
    expect(unreadCount).toBe(2);
  });
});

describe('A2A notification moderation edge cases', () => {
  it('applies moderation before limit and keeps total count independent of limit', async () => {
    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 1 },
      recipientId
    )) as unknown as NotificationsResult;
    expect(result.notifications.map((n) => n.id)).toEqual([
      systemNotificationId,
    ]);
    expect(result.unreadCount).toBe(2);
    const two = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 2 },
      recipientId
    )) as unknown as NotificationsResult;
    expect(two.notifications.map((n) => n.id)).toEqual([
      systemNotificationId,
      normalNotificationId,
    ]);
  });
  it('uses authenticated context instead of a supplied userId', async () => {
    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 50, userId: recipientId },
      normalActorId
    )) as unknown as NotificationsResult;
    expect(result.notifications).toEqual([]);
    expect(result.unreadCount).toBe(0);
  });
  it('refreshes moderation immediately after unblocking and unmuting', async () => {
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, allUserIds));
    await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
    const result = await fetchNotifications();
    expect(result.notifications).toHaveLength(5);
    expect(result.unreadCount).toBe(5);
  });
});
