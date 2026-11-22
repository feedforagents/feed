import { beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

// PRD §§8.1/12, MVP phases 3/5: MCP must honor web moderation.
const suite = 'MCP notification list moderation';
const cases = {
  visibility:
    'hides both block directions and mutes, keeping visible and system messages',
  limit: 'applies visibility before the requested limit',
  account:
    'uses the authenticated account even when a caller supplies another userId',
  unmoderated:
    'keeps notifications for a different viewer with no moderation relationships',
  lateBlock: 'rechecks moderation after a notification was previously listed',
  auth: 'rejects anonymous MCP calls before reading private notifications',
};

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  const { db, eq, notifications, userBlocks, userMutes, users } = await import(
    '@feed/db'
  );
  const { MCPRequestHandler } = await import(
    '../../mcp/src/handlers/mcp-request-handler'
  );
  const { executeGetNotifications, executeTool } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  let viewer: string;
  let other: string;
  let visible: string;
  const visibleMessages = ['visible notification', 'system notification'];

  async function createUser() {
    const id = crypto.randomUUID();
    await db
      .insert(users)
      .values({ id, username: `notif_${id}`, updatedAt: new Date() });
    return id;
  }

  async function block(blockerId: string, blockedId: string) {
    await db
      .insert(userBlocks)
      .values({ id: crypto.randomUUID(), blockerId, blockedId });
  }

  beforeAll(async () => {
    viewer = await createUser();
    other = await createUser();
    visible = await createUser();
    const blocked = await createUser();
    const blockedBy = await createUser();
    const muted = await createUser();
    const actors = [visible, null, blocked, blockedBy, muted];
    const messages = [
      ...visibleMessages,
      'blocked secret',
      'blocked-by secret',
      'muted secret',
    ];
    await db.insert(notifications).values([
      ...actors.map((actorId, index) => ({
        id: crypto.randomUUID(),
        userId: viewer,
        actorId,
        type: 'system' as const,
        title: 'Notification fixture',
        message: messages[index]!,
        // Hidden notifications are newer: filtering after take loses visible rows.
        createdAt: new Date(1_700_000_000_000 + index * 1000),
      })),
      {
        id: crypto.randomUUID(),
        userId: other,
        actorId: blocked,
        type: 'system' as const,
        title: 'Other account',
        message: 'other account secret',
      },
    ]);
    await block(viewer, blocked);
    await block(blockedBy, viewer);
    await db
      .insert(userMutes)
      .values({ id: crypto.randomUUID(), muterId: viewer, mutedId: muted });
  });

  describe(suite, () => {
    it(cases.visibility, async () => {
      const result = await executeGetNotifications(
        { agentId: viewer, userId: viewer },
        {}
      );
      expect(result.notifications.map((row) => row.message).sort()).toEqual(
        [...visibleMessages].sort()
      );
    });

    it(cases.limit, async () => {
      const result = await executeGetNotifications(
        { agentId: viewer, userId: viewer },
        { limit: 2 }
      );
      expect(result.notifications.map((row) => row.message)).toEqual(
        [...visibleMessages].reverse()
      );
    });

    it(cases.account, async () => {
      const result = await executeTool(
        'get_notifications',
        { userId: other },
        { agentId: viewer, userId: viewer }
      );
      expect(result).toEqual({
        notifications: expect.arrayContaining(
          visibleMessages.map((message) => expect.objectContaining({ message }))
        ),
      });
      expect(JSON.stringify(result)).not.toContain('other account secret');
    });

    it(cases.unmoderated, async () => {
      const result = await executeGetNotifications(
        { agentId: other, userId: other },
        {}
      );
      expect(result.notifications.map((row) => row.message)).toEqual([
        'other account secret',
      ]);
    });

    it(cases.lateBlock, async () => {
      const lateViewer = await createUser();
      const id = crypto.randomUUID();
      await db.insert(notifications).values({
        id,
        userId: lateViewer,
        actorId: visible,
        type: 'system',
        title: 'Notification delivered before block',
        message: 'Delivered before the viewer blocked this actor',
      });
      const account = { agentId: lateViewer, userId: lateViewer };
      expect(
        (await executeGetNotifications(account, {})).notifications
      ).toEqual([expect.objectContaining({ id })]);

      await block(lateViewer, visible);

      expect(
        (await executeGetNotifications(account, {})).notifications
      ).toEqual([]);
      const [persisted] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, id));
      expect(persisted).toBeDefined();
    });

    it(cases.auth, async () => {
      const result = await new MCPRequestHandler().handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_notifications', arguments: {} },
      });
      expect(result.error?.code).toBe(-32000);
      expect(result.error?.message).toBe('Authentication required');
      expect(result.result).toBeUndefined();
    });
  });
} else {
  it('runs notification list cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-notification-list-moderation',
      file: 'packages/testing/integration/mcp-notification-list-moderation.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
}
