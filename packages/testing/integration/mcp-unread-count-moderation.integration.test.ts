import { beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP get_unread_count and viewer moderation';
const visibleCase =
  'excludes blocked, muted and blocking actors, keeps visible and system rows';
const unmoderatedCase =
  'keeps the raw unread count for a user with no moderation relations';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { chats, db, notifications, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { executeGetUnreadCount } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const viewerId = 'f150-mcp-viewer';
  const blockedId = 'f150-mcp-blocked';
  const mutedId = 'f150-mcp-muted';
  const blockedById = 'f150-mcp-blocked-by';
  const normalId = 'f150-mcp-normal';
  const plainId = 'f150-mcp-plain';
  const chatId = 'f150-mcp-group';

  beforeAll(async () => {
    const now = new Date();
    await db
      .insert(users)
      .values(
        [viewerId, blockedId, mutedId, blockedById, normalId, plainId].map(
          (id) => ({ id, username: id, displayName: id, updatedAt: now })
        )
      );
    await db.insert(chats).values({
      id: chatId,
      name: 'F150 MCP Group',
      isGroup: true,
      createdAt: now,
      updatedAt: now,
    });

    const notification = (
      suffix: string,
      userId: string,
      actorId: string | null,
      chat: string | null,
      read = false
    ) => ({
      id: `f150-mcp-notification-${suffix}`,
      userId,
      type: 'system' as const,
      actorId,
      chatId: chat,
      title: 'New Message',
      message: 'MCP unread-count fixture',
      read,
    });
    await db
      .insert(notifications)
      .values([
        notification('blocked', viewerId, blockedId, chatId),
        notification('muted', viewerId, mutedId, chatId),
        notification('blocked-by', viewerId, blockedById, null),
        notification('visible', viewerId, normalId, chatId),
        notification('system', viewerId, null, chatId),
        notification('read', viewerId, normalId, chatId, true),
        notification('plain-first', plainId, blockedId, chatId),
        notification('plain-second', plainId, normalId, chatId),
      ]);

    // Relationships set after delivery still hide the old notifications.
    await db.insert(userBlocks).values([
      { id: 'f150-mcp-outgoing-block', blockerId: viewerId, blockedId },
      {
        id: 'f150-mcp-incoming-block',
        blockerId: blockedById,
        blockedId: viewerId,
      },
    ]);
    await db
      .insert(userMutes)
      .values([{ id: 'f150-mcp-mute', muterId: viewerId, mutedId }]);
  });

  describe(suite, () => {
    it(visibleCase, async () => {
      const result = await executeGetUnreadCount(
        { agentId: 'agent', userId: viewerId },
        {}
      );
      expect(result.unreadCount).toBe(2);
    });

    it(unmoderatedCase, async () => {
      const result = await executeGetUnreadCount(
        { agentId: 'agent', userId: plainId },
        {}
      );
      expect(result.unreadCount).toBe(2);
    });
  });
} else {
  it('runs the unread-count cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-unread-count-moderation',
      file: 'packages/testing/integration/mcp-unread-count-moderation.integration.test.ts',
      cases: [`${suite} > ${visibleCase}`, `${suite} > ${unmoderatedCase}`],
    });
  }, 300_000);
}
