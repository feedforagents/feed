/**
 * MCP mute_user must reject a target user that does not exist.
 *
 * The web mute route (POST /api/users/[userId]/mute) looks the target up
 * and answers 404 "Target user not found" before writing anything, and
 * open PR #1640 adds the same lookup to the sibling MCP block_user.
 * executeMuteUser writes the UserMute row unchecked instead: the table
 * has no foreign keys, so a mute of an unknown ID succeeds and leaves a
 * phantom row that surfaces in the caller's own mute list (get_mutes,
 * and the settings mute list) with a null username and display name.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { closeDatabase, db, eq, inArray, userMutes, users } from '@feed/db';
import {
  executeGetMutes,
  executeMuteUser,
} from '../../mcp/src/handlers/tool-handlers';

const GHOST_USER_ID = 'f177-ghost-mute-00000000-0000-4000-8000-0000000000aa';

const userIds: string[] = [];
let agentUserId: string;
let realUserId: string;
let realUsername: string;

async function createUser(): Promise<{ id: string; username: string }> {
  const id = crypto.randomUUID();
  const username = `f177_${id.slice(-10)}`;
  const inserted = await db
    .insert(users)
    .values({ id, username, isActor: false, updatedAt: new Date() })
    .returning({ id: users.id });
  if (!inserted[0]) throw new Error('User fixture insert returned no row');
  userIds.push(inserted[0].id);
  return { id: inserted[0].id, username };
}

async function muteRowsFor(targetId: string) {
  return db
    .select({ id: userMutes.id })
    .from(userMutes)
    .where(eq(userMutes.mutedId, targetId));
}

describe('MCP mute_user target existence', () => {
  const agent = () => ({ agentId: 'agent', userId: agentUserId });

  beforeAll(async () => {
    const agentUser = await createUser();
    agentUserId = agentUser.id;
    const realUser = await createUser();
    realUserId = realUser.id;
    realUsername = realUser.username;
    // Fixture sanity: the ghost ID must not be a real user.
    const ghosts = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, GHOST_USER_ID));
    expect(ghosts).toHaveLength(0);
  });

  afterAll(async () => {
    try {
      await db.delete(userMutes).where(eq(userMutes.muterId, agentUserId));
      await db.delete(users).where(inArray(users.id, userIds));
      expect(await muteRowsFor(GHOST_USER_ID)).toHaveLength(0);
      expect(await muteRowsFor(realUserId)).toHaveLength(0);
    } finally {
      await closeDatabase();
    }
  });

  it('rejects a mute on an unknown user without writing a mute row', async () => {
    await assert.rejects(
      executeMuteUser(agent(), { userId: GHOST_USER_ID }),
      /not found/
    );
    expect(await muteRowsFor(GHOST_USER_ID)).toHaveLength(0);
  });

  it('mutes a real user and lists them with their identity', async () => {
    const result = await executeMuteUser(agent(), { userId: realUserId });
    expect(result.success).toBe(true);
    expect(await muteRowsFor(realUserId)).toHaveLength(1);

    const mutes = await executeGetMutes(agent(), {});
    const entry = mutes.mutedUsers.find((m) => m.userId === realUserId);
    expect(entry?.username).toBe(realUsername);
  });

  it('does not mute twice for a repeated mute', async () => {
    const result = await executeMuteUser(agent(), { userId: realUserId });
    expect(result.success).toBe(true);
    expect(await muteRowsFor(realUserId)).toHaveLength(1);
  });

  it('still rejects muting yourself', async () => {
    await assert.rejects(
      executeMuteUser(agent(), { userId: agentUserId }),
      /Cannot mute yourself/
    );
    expect(await muteRowsFor(agentUserId)).toHaveLength(0);
  });
});
