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
 *
 * The last cases run the retained caller path itself: the feed plugin's
 * FEED_MESSAGES provider (registered on NPC runtimes in A2A mode) calls
 * FeedA2AClient.getUnreadCount, which maps to messaging.get_unread_count
 * with the account bound into the per-agent client. The client is built
 * exactly as production wiring builds it (real SDK client + the agent
 * card), with the direct same-process transport selected.
 *
 * Fixture ownership: every row this file creates is registered only from
 * the INSERT ... RETURNING result of the statement that created it, per
 * table. Cleanup deletes by those owned row IDs only — never by a
 * pre-generated ID and never by relation — so a failed or partial setup
 * cannot delete rows the fixture does not own. The final case proves it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { A2AClient } from '@a2a-js/sdk/client';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import {
  count,
  db,
  inArray,
  notifications,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import { feedAgentCard } from '../../a2a/src/feed-agent-card';
import { FeedA2AClient } from '../../agents/src/plugins/feed/integration-a2a-sdk';
import { messagesProvider } from '../../agents/src/plugins/feed/providers/messaging';

type UnreadCountResult = { unreadCount: number };
type NotificationsResult = { unreadCount: number };

let recipientId: string;
let visibleId: string;
let mutedId: string;
let blockedId: string;
let blockerId: string;
let plainViewerId: string;
let chatId: string;

// Ownership is acquired per table from INSERT ... RETURNING results only.
const ownedUserIds: string[] = [];
const ownedBlockIds: string[] = [];
const ownedMuteIds: string[] = [];
const ownedNotificationIds: string[] = [];

async function cleanupOwnedFixtures() {
  if (ownedNotificationIds.length > 0) {
    await db
      .delete(notifications)
      .where(inArray(notifications.id, ownedNotificationIds));
  }
  if (ownedBlockIds.length > 0) {
    await db.delete(userBlocks).where(inArray(userBlocks.id, ownedBlockIds));
  }
  if (ownedMuteIds.length > 0) {
    await db.delete(userMutes).where(inArray(userMutes.id, ownedMuteIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
}

afterAll(cleanupOwnedFixtures);

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
  const [row] = await db
    .insert(notifications)
    .values({
      id,
      userId,
      type: 'system',
      actorId,
      chatId,
      title: 'New Message',
      message: 'fixture chat message',
      read,
    })
    .returning({ id: notifications.id });
  assert.ok(row);
  ownedNotificationIds.push(row.id);
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
  const fixtureUserIds = [
    recipientId,
    visibleId,
    mutedId,
    blockedId,
    blockerId,
    plainViewerId,
  ];

  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values(
      fixtureUserIds.map((id, i) => ({
        id,
        username: `f84-${i}-${id}`,
        displayName: `F84 Fixture ${i}`,
        updatedAt: now,
      }))
    )
    .returning({ id: users.id });
  ownedUserIds.push(...insertedUsers.map((row) => row.id));

  // The recipient muted one actor, blocked another, and is blocked by a
  // third — the three sets every other read surface excludes at read time.
  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: blockRowA, blockerId: recipientId, blockedId: blockedId },
      { id: blockRowB, blockerId: blockerId, blockedId: recipientId },
    ])
    .returning({ id: userBlocks.id });
  ownedBlockIds.push(...insertedBlocks.map((row) => row.id));
  const insertedMutes = await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: recipientId, mutedId: mutedId }])
    .returning({ id: userMutes.id });
  ownedMuteIds.push(...insertedMutes.map((row) => row.id));

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
  const [nonChatRow] = await db
    .insert(notifications)
    .values({
      id: nonChatId,
      userId: recipientId,
      type: 'follow',
      actorId: visibleId,
      title: 'New Follower',
      message: 'Visible actor started following you',
      read: false,
    })
    .returning({ id: notifications.id });
  assert.ok(nonChatRow);
  ownedNotificationIds.push(nonChatRow.id);

  // A viewer with no moderation relations keeps the raw count.
  await insertChatNotification(plainViewerId, visibleId, false);
  await insertChatNotification(plainViewerId, mutedId, false);
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

describe('retained FEED_MESSAGES provider path', () => {
  function buildClient(agentUserId: string) {
    // Same construction as initializeAgentA2AClient: a real SDK client
    // over the feed agent card, bound to one agent account. The direct
    // transport below routes requests to the in-process executor with
    // that bound account, exactly as a same-process deployment does.
    const sdk = new A2AClient({
      ...feedAgentCard,
      url: 'http://127.0.0.1:9/api/a2a',
    });
    return new FeedA2AClient(sdk, agentUserId, {
      agentUserId,
      displayName: 'F84 Fixture Agent',
      cachedAt: Date.now(),
    });
  }

  it('serves the moderated count to the bound caller only', async () => {
    const savedTransport = process.env.FEED_A2A_TRANSPORT;
    process.env.FEED_A2A_TRANSPORT = 'direct';
    try {
      const recipientClient = buildClient(recipientId);
      expect(recipientClient.isConnected()).toBe(true);

      const direct =
        (await recipientClient.getUnreadCount()) as unknown as UnreadCountResult;
      expect(direct.unreadCount).toBe(3);

      // The provider the feed plugin registers for NPC runtimes renders
      // the same count from the same client.
      const runtime = {
        a2aClient: recipientClient,
      } as unknown as IAgentRuntime;
      const provided = await messagesProvider.get(
        runtime,
        {} as Memory,
        {} as State
      );
      expect(provided.text).toContain('Unread messages: 3');

      // Caller isolation: a client bound to a different account reports
      // that account's count — identity comes from the bound client,
      // never from a request parameter.
      const viewerClient = buildClient(plainViewerId);
      const viewer =
        (await viewerClient.getUnreadCount()) as unknown as UnreadCountResult;
      expect(viewer.unreadCount).toBe(2);
    } finally {
      if (savedTransport === undefined) {
        delete process.env.FEED_A2A_TRANSPORT;
      } else {
        process.env.FEED_A2A_TRANSPORT = savedTransport;
      }
    }
  });
});

describe('fixture ownership', () => {
  it('teardown removes only rows the fixture actually owns', async () => {
    // Foreign rows this fixture never created: a user, a block row in
    // which that user blocks the recipient (relation-scoped cleanup
    // keyed on the owned blockedId would have deleted it), and a chat
    // notification for the foreign user.
    const foreignUserId = await generateSnowflakeId();
    const foreignBlockId = await generateSnowflakeId();
    const foreignNotificationId = await generateSnowflakeId();
    await db.insert(users).values({
      id: foreignUserId,
      username: `f84-foreign-${foreignUserId}`,
      displayName: 'F84 Foreign',
      updatedAt: new Date(),
    });
    await db.insert(userBlocks).values({
      id: foreignBlockId,
      blockerId: foreignUserId,
      blockedId: recipientId,
    });
    await db.insert(notifications).values({
      id: foreignNotificationId,
      userId: foreignUserId,
      type: 'system',
      actorId: visibleId,
      chatId,
      title: 'New Message',
      message: 'foreign chat message',
      read: false,
    });

    // A partial setup step that tries to claim an existing notification
    // ID fails on the duplicate key; because ownership comes only from
    // RETURNING, the failed step owns nothing.
    const partialOwnedIds: string[] = [];
    let setupFailed = false;
    try {
      const [row] = await db
        .insert(notifications)
        .values({
          id: foreignNotificationId,
          userId: recipientId,
          type: 'system',
          actorId: visibleId,
          chatId,
          title: 'New Message',
          message: 'partial setup attempt',
          read: false,
        })
        .returning({ id: notifications.id });
      if (row) partialOwnedIds.push(row.id);
    } catch {
      setupFailed = true;
    }
    expect(setupFailed).toBe(true);
    expect(partialOwnedIds).toHaveLength(0);

    await cleanupOwnedFixtures();

    // Everything the fixture owned is gone.
    const [ownedUsersLeft] = await db
      .select({ n: count() })
      .from(users)
      .where(inArray(users.id, ownedUserIds));
    assert.ok(ownedUsersLeft);
    expect(ownedUsersLeft.n).toBe(0);
    const [ownedNotificationsLeft] = await db
      .select({ n: count() })
      .from(notifications)
      .where(inArray(notifications.id, ownedNotificationIds));
    assert.ok(ownedNotificationsLeft);
    expect(ownedNotificationsLeft.n).toBe(0);

    // Every foreign row survives, including the block that references
    // an owned user and the notification whose ID the failed setup
    // step tried to claim.
    const [foreignUsersLeft] = await db
      .select({ n: count() })
      .from(users)
      .where(inArray(users.id, [foreignUserId]));
    assert.ok(foreignUsersLeft);
    expect(foreignUsersLeft.n).toBe(1);
    const [foreignBlocksLeft] = await db
      .select({ n: count() })
      .from(userBlocks)
      .where(inArray(userBlocks.id, [foreignBlockId]));
    assert.ok(foreignBlocksLeft);
    expect(foreignBlocksLeft.n).toBe(1);
    const [foreignNotificationsLeft] = await db
      .select({ n: count() })
      .from(notifications)
      .where(inArray(notifications.id, [foreignNotificationId]));
    assert.ok(foreignNotificationsLeft);
    expect(foreignNotificationsLeft.n).toBe(1);

    // Remove the foreign rows by the exact IDs this case created them
    // with.
    await db
      .delete(notifications)
      .where(inArray(notifications.id, [foreignNotificationId]));
    await db.delete(userBlocks).where(inArray(userBlocks.id, [foreignBlockId]));
    await db.delete(users).where(inArray(users.id, [foreignUserId]));
  });
});
