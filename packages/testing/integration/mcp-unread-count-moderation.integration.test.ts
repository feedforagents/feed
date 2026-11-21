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
 *
 * Fixture ownership: every row id is registered only after a committed
 * INSERT ... RETURNING actually returned it, so a failed or partial setup
 * never owns a row it did not create. Cleanup deletes exactly those ids
 * in one transaction and refuses when a foreign child still references an
 * owned parent — a setup that collides with a pre-existing account can
 * never erase that account's data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  chats,
  db,
  gameOnboarding,
  inArray,
  notInArray,
  notifications,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

// Strict guard: writes go only to a disposable local database.
function assertDisposableDatabaseUrl(
  value: string | undefined,
  label: string
): string {
  if (!value) throw new Error(`${label} is required for integration tests`);
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !/^(test_db|feed_pr\d+)$/.test(databaseName)
  ) {
    throw new Error(
      `${label} must point to a local test or verification database`
    );
  }
  return databaseName;
}
const databaseName = assertDisposableDatabaseUrl(
  process.env.DATABASE_URL,
  'DATABASE_URL'
);
const directDatabaseName = process.env.DIRECT_DATABASE_URL
  ? assertDisposableDatabaseUrl(
      process.env.DIRECT_DATABASE_URL,
      'DIRECT_DATABASE_URL'
    )
  : null;
if (directDatabaseName !== null && directDatabaseName !== databaseName) {
  throw new Error(
    'DIRECT_DATABASE_URL must point at the same database as DATABASE_URL'
  );
}

let viewerId: string;
let blockedId: string;
let mutedId: string;
let blockedById: string;
let normalId: string;
let plainId: string;
let chatId: string;

// Rows this run actually created, by exact id. A planned id is never
// published here until its INSERT ... RETURNING committed.
const owned = {
  users: new Set<string>(),
  chats: new Set<string>(),
  blocks: new Set<string>(),
  mutes: new Set<string>(),
  notifications: new Set<string>(),
};

let executeGetUnreadCount: typeof import('../../../packages/mcp/src/handlers/tool-handlers').executeGetUnreadCount;

const agent = (userId: string) => ({ agentId: 'agent', userId }) as never;

/** Delete exactly the owned rows, or delete nothing. */
async function cleanupOwned(): Promise<void> {
  if (
    owned.users.size === 0 &&
    owned.chats.size === 0 &&
    owned.blocks.size === 0 &&
    owned.mutes.size === 0 &&
    owned.notifications.size === 0
  ) {
    return;
  }
  const userIds = [...owned.users];
  const chatIds = [...owned.chats];
  const notificationIds = [...owned.notifications];
  const blockIds = [...owned.blocks];
  const muteIds = [...owned.mutes];
  await db.transaction(async (tx) => {
    if (notificationIds.length > 0) {
      await tx
        .delete(notifications)
        .where(inArray(notifications.id, notificationIds));
    }
    if (blockIds.length > 0) {
      await tx.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    }
    if (muteIds.length > 0) {
      await tx.delete(userMutes).where(inArray(userMutes.id, muteIds));
    }
    // Refuse when a foreign child still references an owned parent: the
    // parent delete would silently erase or orphan it.
    if (userIds.length > 0) {
      const foreign = await Promise.all([
        tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              inArray(notifications.userId, userIds),
              notInArray(notifications.id, notificationIds)
            )
          ),
        tx
          .select({ id: userBlocks.id })
          .from(userBlocks)
          .where(
            and(
              inArray(userBlocks.blockerId, userIds),
              notInArray(userBlocks.id, blockIds)
            )
          ),
        tx
          .select({ id: userBlocks.id })
          .from(userBlocks)
          .where(
            and(
              inArray(userBlocks.blockedId, userIds),
              notInArray(userBlocks.id, blockIds)
            )
          ),
        tx
          .select({ id: userMutes.id })
          .from(userMutes)
          .where(
            and(
              inArray(userMutes.muterId, userIds),
              notInArray(userMutes.id, muteIds)
            )
          ),
        tx
          .select({ id: userMutes.id })
          .from(userMutes)
          .where(
            and(
              inArray(userMutes.mutedId, userIds),
              notInArray(userMutes.id, muteIds)
            )
          ),
        // Physical cascade children of a User row.
        tx
          .select({ id: gameOnboarding.userId })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, userIds)),
        tx
          .select({ id: userPnLSnapshots.userId })
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.userId, userIds)),
        tx
          .select({ id: whitelist.userId })
          .from(whitelist)
          .where(inArray(whitelist.userId, userIds)),
        tx
          .select({ id: whitelist.grantedBy })
          .from(whitelist)
          .where(inArray(whitelist.grantedBy, userIds)),
        tx
          .select({ id: whitelistConfig.updatedBy })
          .from(whitelistConfig)
          .where(inArray(whitelistConfig.updatedBy, userIds)),
      ]);
      if (foreign.some((rows) => rows.length > 0)) {
        throw new Error(
          'cleanup refused: foreign rows still reference owned users'
        );
      }
    }
    if (chatIds.length > 0) {
      const foreignChatNotifications = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            inArray(notifications.chatId, chatIds),
            notInArray(notifications.id, notificationIds)
          )
        );
      if (foreignChatNotifications.length > 0) {
        throw new Error(
          'cleanup refused: foreign notifications still reference owned chats'
        );
      }
      await tx.delete(chats).where(inArray(chats.id, chatIds));
    }
    if (userIds.length > 0) {
      await tx.delete(users).where(inArray(users.id, userIds));
    }
  });
  owned.users.clear();
  owned.chats.clear();
  owned.blocks.clear();
  owned.mutes.clear();
  owned.notifications.clear();
}

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

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-f150mcp-${label}-${id}`,
    displayName: `F150 MCP ${label}`,
    updatedAt: now,
  });
  const insertedUsers = await db
    .insert(users)
    .values([
      seedUser(viewerId, 'viewer'),
      seedUser(blockedId, 'blocked'),
      seedUser(mutedId, 'muted'),
      seedUser(blockedById, 'blockedby'),
      seedUser(normalId, 'normal'),
      seedUser(plainId, 'plain'),
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedChats = await db
    .insert(chats)
    .values([
      {
        id: chatId,
        name: 'F150 MCP Group',
        isGroup: true,
        groupId: null,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning({ id: chats.id });
  for (const row of insertedChats) owned.chats.add(row.id);

  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: nid(), blockerId: viewerId, blockedId },
      { id: nid(), blockerId: blockedById, blockedId: viewerId },
    ])
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) owned.blocks.add(row.id);
  const insertedMutes = await db
    .insert(userMutes)
    .values([{ id: nid(), muterId: viewerId, mutedId }])
    .returning({ id: userMutes.id });
  for (const row of insertedMutes) owned.mutes.add(row.id);

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
  const insertedNotifications = await db
    .insert(notifications)
    .values([
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
    ])
    .returning({ id: notifications.id });
  for (const row of insertedNotifications) owned.notifications.add(row.id);
});

afterAll(async () => {
  await cleanupOwned();
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

  it('a failed setup registers no ownership and preserves the original rows', async () => {
    const now = new Date();
    // Canary account this test creates itself, with its own notification
    // and block. It stands in for a pre-existing account that a colliding
    // fixture setup must never touch.
    const canaryId = await generateSnowflakeId();
    const canaryBlockerId = await generateSnowflakeId();
    const freshId = await generateSnowflakeId();
    await db.insert(users).values([
      {
        id: canaryId,
        username: `test-f150mcp-canary-${canaryId}`,
        displayName: 'F150 MCP canary',
        updatedAt: now,
      },
      {
        id: canaryBlockerId,
        username: `test-f150mcp-canary-${canaryBlockerId}`,
        displayName: 'F150 MCP canary blocker',
        updatedAt: now,
      },
    ]);
    const canaryNotificationId = await generateSnowflakeId();
    await db.insert(notifications).values({
      id: canaryNotificationId,
      userId: canaryId,
      type: 'system',
      actorId: null,
      chatId: null,
      title: 'Canary',
      message: 'pre-existing notification',
      read: false,
    });
    const canaryBlockId = await generateSnowflakeId();
    await db.insert(userBlocks).values({
      id: canaryBlockId,
      blockerId: canaryBlockerId,
      blockedId: canaryId,
    });

    // A batch that reuses the canary id must fail on the real PostgreSQL
    // unique-violation cause, and the batch is atomic: the fresh id is
    // not inserted either.
    await expect(
      (async () => {
        await db.insert(users).values([
          {
            id: canaryId,
            username: `test-f150mcp-collision-${canaryId}`,
            displayName: 'F150 MCP collision',
            updatedAt: now,
          },
          {
            id: freshId,
            username: `test-f150mcp-fresh-${freshId}`,
            displayName: 'F150 MCP fresh',
            updatedAt: now,
          },
        ]);
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    const freshRows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [freshId]));
    expect(freshRows).toHaveLength(0);

    // The analogous chat path: re-inserting the fixture chat must fail
    // the same way, and the original chat row must survive.
    await expect(
      (async () => {
        await db.insert(chats).values({
          id: chatId,
          name: 'F150 MCP Group duplicate',
          isGroup: true,
          groupId: null,
          createdAt: now,
          updatedAt: now,
        });
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    const chatRows = await db
      .select({ id: chats.id })
      .from(chats)
      .where(inArray(chats.id, [chatId]));
    expect(chatRows).toHaveLength(1);

    // The failed setup registered no ownership: running the fixture
    // cleanup now must delete only the fixture's own rows.
    await cleanupOwned();
    const canaryUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [canaryId, canaryBlockerId]));
    expect(canaryUsers).toHaveLength(2);
    const canaryNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(inArray(notifications.id, [canaryNotificationId]));
    expect(canaryNotifications).toHaveLength(1);
    const canaryBlocks = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(inArray(userBlocks.id, [canaryBlockId]));
    expect(canaryBlocks).toHaveLength(1);

    // Remove the canary rows this test created, by exact id.
    await db
      .delete(notifications)
      .where(inArray(notifications.id, [canaryNotificationId]));
    await db.delete(userBlocks).where(inArray(userBlocks.id, [canaryBlockId]));
    await db
      .delete(users)
      .where(inArray(users.id, [canaryId, canaryBlockerId]));
  });
});
