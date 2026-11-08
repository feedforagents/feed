/**
 * messaging.get_unread_count against a real database: the A2A chat unread
 * count must apply the same read-time moderation filter as every other
 * notification read surface.
 *
 * Chat message notifications are created per message with the sender as
 * actorId (notifyDMMessage / notifyGroupChatMessage). Creation skips
 * blocked pairs, but a mute never stops creation, and a block placed later
 * does not remove notifications created before it — so the established
 * rule is to exclude blocked, muted and blocking actors at read time:
 * GET /api/notifications applies the predicate to both its list and its
 * unread count ("the badge never counts hidden items"), the A2A
 * notifications handler in the same executor does the same for its list
 * and its unread count, and the web chat badge (GET /api/chats/unread-count)
 * was aligned to it as well. The A2A chat unread count
 * (messaging.get_unread_count, surfaced to agents as the messaging
 * context's unreadCount) is the one read path that still counts every
 * unread chat notification, so an agent keeps reporting chat messages
 * its user can never see — and the count keeps rising after a mute.
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

type UnreadCountResult = { unreadCount: number };
type NotificationsResult = { unreadCount: number };

let recipientId: string;
let visibleId: string;
let mutedId: string;
let blockedId: string;
let blockerId: string;
let plainViewerId: string;
let chatId: string;

const allUserIds: string[] = [];
const allNotificationIds: string[] = [];

async function fetchChatUnreadCount(userId: string) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'messaging.get_unread_count',
    {},
    userId
  )) as unknown as UnreadCountResult;
  return result.unreadCount;
}

async function insertChatNotification(
  userId: string,
  actorId: string | null,
  read: boolean
) {
  const id = await generateSnowflakeId();
  allNotificationIds.push(id);
  await db.insert(notifications).values({
    id,
    userId,
    type: 'system',
    actorId,
    chatId,
    title: 'New Message',
    message: 'fixture chat message',
    read,
  });
}

beforeAll(async () => {
  [
    recipientId,
    visibleId,
    mutedId,
    blockedId,
    blockerId,
    plainViewerId,
    chatId,
  ] = await Promise.all([
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
    visibleId,
    mutedId,
    blockedId,
    blockerId,
    plainViewerId
  );

  const now = new Date();
  await db.insert(users).values(
    allUserIds.map((id, i) => ({
      id,
      username: `f84-${i}-${id}`,
      displayName: `F84 Fixture ${i}`,
      updatedAt: now,
    }))
  );

  // The recipient muted one actor, blocked another, and is blocked by a
  // third — the three sets every other read surface excludes at read time.
  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(userBlocks).values([
    { id: blockRowA, blockerId: recipientId, blockedId: blockedId },
    { id: blockRowB, blockerId: blockerId, blockedId: recipientId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: recipientId, mutedId: mutedId }]);

  // Chat notifications for the recipient: 2 visible, 3 muted, 1 blocked
  // (created before the block), 1 from the actor who blocked the
  // recipient, 1 null-actor system chat notification — 8 unread in raw
  // terms, of which only 3 are visible anywhere.
  await insertChatNotification(recipientId, visibleId, false);
  await insertChatNotification(recipientId, visibleId, false);
  await insertChatNotification(recipientId, mutedId, false);
  await insertChatNotification(recipientId, mutedId, false);
  await insertChatNotification(recipientId, mutedId, false);
  await insertChatNotification(recipientId, blockedId, false);
  await insertChatNotification(recipientId, blockerId, false);
  await insertChatNotification(recipientId, null, false);
  // Controls: a read chat notification and an unread non-chat
  // notification from the visible actor — neither is a chat unread.
  await insertChatNotification(recipientId, visibleId, true);
  const nonChatId = await generateSnowflakeId();
  allNotificationIds.push(nonChatId);
  await db.insert(notifications).values({
    id: nonChatId,
    userId: recipientId,
    type: 'follow',
    actorId: visibleId,
    title: 'New Follower',
    message: 'Visible actor started following you',
    read: false,
  });

  // A viewer with no moderation relations keeps the raw count.
  await insertChatNotification(plainViewerId, visibleId, false);
  await insertChatNotification(plainViewerId, mutedId, false);
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

describe('A2A messaging.get_unread_count moderation filter', () => {
  it('counts only chat notifications the user can see', async () => {
    const unreadCount = await fetchChatUnreadCount(recipientId);
    expect(unreadCount).toBe(3);
  });

  it('keeps the raw count for a viewer with no moderation relations', async () => {
    const unreadCount = await fetchChatUnreadCount(plainViewerId);
    expect(unreadCount).toBe(2);
  });

  it('agrees with the A2A notifications unread count on the visible set', async () => {
    // messaging.get_notifications already applies the filter to its
    // unread count over all notifications: the 3 visible chat
    // notifications plus the 1 visible non-chat notification.
    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 50 },
      recipientId
    )) as unknown as NotificationsResult;
    expect(result.unreadCount).toBe(4);
  });
});
