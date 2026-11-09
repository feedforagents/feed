/**
 * MCP get_unread_count against a real database: the unread count an agent
 * client reports must not include notifications from actors the user
 * cannot see anywhere.
 *
 * Every other notification read surface applies the viewer moderation rule
 * at read time — the web notification list, the A2A notification list
 * (#1659, which filters its list and its unread tally with the same
 * clause), and the web chat badge (#1782): actors the user has blocked or
 * muted, and actors who have blocked the user, are excluded; system
 * notifications (null actor) are always kept. The MCP count applied no
 * filter, so a blocked or muted actor's notifications kept the agent-side
 * count lit after the user had hidden that actor on every other surface.
 *
 * The filter has to live at read time: muting never stops notification
 * creation, and a block placed later must hide notifications created
 * before it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chats,
  db,
  inArray,
  notifications,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

let viewerId: string;
let blockedId: string;
let mutedId: string;
let blockedById: string;
let normalId: string;
let plainId: string;
let chatId: string;

const allUserIds: string[] = [];

let executeGetUnreadCount: typeof import('../../../packages/mcp/src/handlers/tool-handlers').executeGetUnreadCount;

const agent = (userId: string) => ({ agentId: 'agent', userId }) as never;

beforeAll(async () => {
  ({ executeGetUnreadCount } = await import(
    '../../../packages/mcp/src/handlers/tool-handlers'
  ));

  const ids = await Promise.all(
    Array.from({ length: 24 }, () => generateSnowflakeId())
  );
  let i = 0;
  const nid = () => ids[i++]!;
  viewerId = nid();
  blockedId = nid();
  mutedId = nid();
  blockedById = nid();
  normalId = nid();
  plainId = nid();
  chatId = nid();
  allUserIds.push(viewerId, blockedId, mutedId, blockedById, normalId, plainId);

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-f150mcp-${label}-${id}`,
    displayName: `F150 MCP ${label}`,
    updatedAt: now,
  });
  await db
    .insert(users)
    .values([
      seedUser(viewerId, 'viewer'),
      seedUser(blockedId, 'blocked'),
      seedUser(mutedId, 'muted'),
      seedUser(blockedById, 'blockedby'),
      seedUser(normalId, 'normal'),
      seedUser(plainId, 'plain'),
    ]);

  await db.insert(chats).values([
    {
      id: chatId,
      name: 'F150 MCP Group',
      isGroup: true,
      groupId: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(userBlocks).values([
    { id: nid(), blockerId: viewerId, blockedId },
    { id: nid(), blockerId: blockedById, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: nid(), muterId: viewerId, mutedId }]);

  const notif = (
    userId: string,
    actorId: string | null,
    chat: string | null,
    read: boolean
  ) => ({
    id: nid(),
    userId,
    type: 'system' as const,
    actorId,
    chatId: chat,
    title: 'New Message',
    message: 'f150 mcp fixture',
    read,
  });
  await db.insert(notifications).values([
    // Viewer: three hidden actors (one via a non-chat notification — the
    // rule is actor-based, not type-based), one visible actor, one system
    // row, and one already-read row from the visible actor.
    notif(viewerId, blockedId, chatId, false),
    notif(viewerId, mutedId, chatId, false),
    notif(viewerId, blockedById, null, false),
    notif(viewerId, normalId, chatId, false),
    notif(viewerId, null, chatId, false),
    notif(viewerId, normalId, chatId, true),
    // Plain viewer (no relationships): everything unread counts.
    notif(plainId, blockedId, chatId, false),
    notif(plainId, normalId, chatId, false),
  ]);
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(inArray(notifications.userId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(chats).where(inArray(chats.id, [chatId]));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('MCP get_unread_count and viewer moderation', () => {
  it('excludes blocked, muted and blocking actors, keeps visible and system rows', async () => {
    const result = await executeGetUnreadCount(agent(viewerId), {});
    expect(result.unreadCount).toBe(2);
  });

  it('keeps the raw unread count for a user with no moderation relations', async () => {
    const result = await executeGetUnreadCount(agent(plainId), {});
    expect(result.unreadCount).toBe(2);
  });
});
