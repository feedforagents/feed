import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  closeDatabase,
  db,
  eq,
  inArray,
  notifications,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { MCPRequestHandler } from '../../mcp/src/handlers/mcp-request-handler';
import {
  executeGetNotifications,
  executeTool,
} from '../../mcp/src/handlers/tool-handlers';

// PRD §8.1/§12, MVP phases 3/5: MCP must honor web moderation.
// Real database and handlers; no authentication or moderation mocks.
const ownedUsers: string[] = [];
const ownedNotifications: string[] = [];
const ownedBlocks: string[] = [];
const ownedMutes: string[] = [];
let viewer: string;
let other: string;
let visible: string;
const visibleMessages = ['visible notification', 'system notification'];

async function createUser() {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(users)
    .values({ id, username: `notif_${id}`, updatedAt: new Date() })
    .returning({ id: users.id });
  if (!row) throw new Error('User insert returned no fixture');
  ownedUsers.push(row.id);
  return row.id;
}

async function block(blockerId: string, blockedId: string) {
  const rows = await db
    .insert(userBlocks)
    .values({ id: crypto.randomUUID(), blockerId, blockedId })
    .returning({ id: userBlocks.id });
  ownedBlocks.push(...rows.map((row) => row.id));
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
  const rows = await db
    .insert(notifications)
    .values([
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
    ])
    .returning({ id: notifications.id });
  ownedNotifications.push(...rows.map((row) => row.id));
  await block(viewer, blocked);
  await block(blockedBy, viewer);
  const mutes = await db
    .insert(userMutes)
    .values({ id: crypto.randomUUID(), muterId: viewer, mutedId: muted })
    .returning({ id: userMutes.id });
  ownedMutes.push(...mutes.map((row) => row.id));
});

afterAll(async () => {
  if (ownedNotifications.length)
    await db
      .delete(notifications)
      .where(inArray(notifications.id, ownedNotifications));
  if (ownedBlocks.length)
    await db.delete(userBlocks).where(inArray(userBlocks.id, ownedBlocks));
  if (ownedMutes.length)
    await db.delete(userMutes).where(inArray(userMutes.id, ownedMutes));
  if (ownedUsers.length)
    await db.delete(users).where(inArray(users.id, ownedUsers));
  await closeDatabase();
});

describe('MCP notification list moderation', () => {
  it('hides both block directions and mutes, keeping visible and system messages', async () => {
    const result = await executeGetNotifications(
      { agentId: viewer, userId: viewer },
      {}
    );
    expect(result.notifications.map((row) => row.message).sort()).toEqual(
      [...visibleMessages].sort()
    );
  });

  it('applies visibility before the requested limit', async () => {
    const result = await executeGetNotifications(
      { agentId: viewer, userId: viewer },
      { limit: 2 }
    );
    expect(result.notifications.map((row) => row.message)).toEqual(
      [...visibleMessages].reverse()
    );
  });

  it('uses the authenticated account even when a caller supplies another userId', async () => {
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

  it('keeps notifications for a different viewer with no moderation relationships', async () => {
    const result = await executeGetNotifications(
      { agentId: other, userId: other },
      {}
    );
    expect(result.notifications.map((row) => row.message)).toEqual([
      'other account secret',
    ]);
  });

  it('rechecks moderation after a notification was created and previously read', async () => {
    await block(viewer, visible);
    const result = await executeGetNotifications(
      { agentId: viewer, userId: viewer },
      {}
    );
    expect(result.notifications.map((row) => row.message)).toEqual([
      'system notification',
    ]);
    const [persisted] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.actorId, visible));
    expect(persisted).toBeDefined();
  });

  it('rejects anonymous MCP calls before reading private notifications', async () => {
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
