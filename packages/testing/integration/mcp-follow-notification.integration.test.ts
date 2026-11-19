/**
 * MCP follow_user follows the same rules as the web follow route and the
 * other MCP write tools: a fresh follow notifies the followed user (never
 * across a block), a repeat follow does not notify again, and a
 * notification failure must not fail the committed follow.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import {
  db,
  eq,
  follows,
  inArray,
  notifications,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import * as notificationService from '../../api/src/services/notification-service';
import { executeFollowUser } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const blockIds: string[] = [];

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `mcpf_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function followRows(followerId: string) {
  return db
    .select({ id: follows.id, followingId: follows.followingId })
    .from(follows)
    .where(eq(follows.followerId, followerId));
}

async function followNotificationsFor(userId: string) {
  return db
    .select({
      userId: notifications.userId,
      type: notifications.type,
      actorId: notifications.actorId,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
}

describe('MCP follow_user', () => {
  afterAll(async () => {
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(follows).where(inArray(follows.followerId, userIds));
    await db.delete(follows).where(inArray(follows.followingId, userIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('notifies the followed user when the agent follows them', async () => {
    const target = await createUser();
    const agentUserId = await createUser();

    const result = await executeFollowUser(
      { agentId: 'agent', userId: agentUserId },
      { userId: target }
    );

    expect(result.success).toBe(true);
    expect(await followRows(agentUserId)).toHaveLength(1);
    expect(await followNotificationsFor(target)).toEqual([
      { userId: target, type: 'follow', actorId: agentUserId },
    ]);
  });

  it('does not notify again when the agent is already following', async () => {
    const target = await createUser();
    const agentUserId = await createUser();
    const agent = { agentId: 'agent', userId: agentUserId };

    await executeFollowUser(agent, { userId: target });
    const again = await executeFollowUser(agent, { userId: target });

    expect(again.success).toBe(true);
    expect(await followRows(agentUserId)).toHaveLength(1);
    expect(await followNotificationsFor(target)).toHaveLength(1);
  });

  it('rejects a self-follow and does not notify', async () => {
    const agentUserId = await createUser();

    await expect(
      executeFollowUser(
        { agentId: 'agent', userId: agentUserId },
        { userId: agentUserId }
      )
    ).rejects.toThrow('Cannot follow yourself');
    expect(await followRows(agentUserId)).toHaveLength(0);
    expect(await followNotificationsFor(agentUserId)).toHaveLength(0);
  });

  it('does not notify across a block, but the follow still lands', async () => {
    const target = await createUser();
    const agentUserId = await createUser();
    const inserted = await db
      .insert(userBlocks)
      .values({
        id: await generateSnowflakeId(),
        blockerId: target,
        blockedId: agentUserId,
      })
      .returning({ id: userBlocks.id });
    blockIds.push(...inserted.map((row) => row.id));

    const result = await executeFollowUser(
      { agentId: 'agent', userId: agentUserId },
      { userId: target }
    );

    expect(result.success).toBe(true);
    expect(await followRows(agentUserId)).toHaveLength(1);
    expect(await followNotificationsFor(target)).toHaveLength(0);
  });

  it('still reports the committed follow when the notification fails', async () => {
    const target = await createUser();
    const agentUserId = await createUser();
    const notify = spyOn(notificationService, 'notifyFollow');
    notify.mockRejectedValueOnce(new Error('notification unavailable'));
    try {
      const result = await executeFollowUser(
        { agentId: 'agent', userId: agentUserId },
        { userId: target }
      );

      expect(result.success).toBe(true);
      expect(await followRows(agentUserId)).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      notify.mockRestore();
    }
  });
});
