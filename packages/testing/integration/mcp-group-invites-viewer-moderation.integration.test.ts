/**
 * MCP get_group_invites must apply the viewer's moderation policy to the
 * invite list.
 *
 * PRD §8.1: "Same business logic as the website. Tools call the same
 * services REST uses (notifications, repost posts, rate limits,
 * moderation), not raw DB writes." The notification list hides
 * blocked/muted/blocked-by actors at read time, and the web group-invite
 * list does the same (GET /api/groups/invites — same exclusion set:
 * inviter blocked-by, muted, or blocked by the viewer). The MCP invite
 * list returns every pending invite with no filter at all, so a blocked
 * inviter's invite reaches the agent even though every neighbouring
 * surface refuses contact between blocked users:
 *
 * - DM send rejects when either side blocked (BLOCKED_USER)
 * - createNotification skips creation when either side blocked
 * - the notification list and unread count hide blocked/muted actors
 * - group chat history applies the viewer moderation filter (#1710)
 * - comments/follows between blocked users are rejected (#1822, #1676)
 * - the web invite list excludes blocked/muted inviters (F4-01)
 * - MCP search_agents / query_feed already load the same three
 *   exclusion sets in their own handlers
 *
 * MCP-only: the A2A half (getGroupInvites) was removed — maintainer
 * scope decision #1888 closes A2A as outside the current MVP scope.
 *
 * Real DB, real handler (executeGetGroupInvites directly, no mocks).
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f9r3
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f9r3
 *   TZ=UTC bun test integration/mcp-group-invites-viewer-moderation.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  groupInvites,
  groups,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetGroupInvites } from '../../mcp/src/handlers/tool-handlers';

const CALLER = 'f9-caller';
const STRANGER = 'f9-stranger';
const INV_BLOCKED = 'f9-inviter-blocked';
const INV_MUTED = 'f9-inviter-muted';
const INV_BLOCKER = 'f9-inviter-blocker';
const INV_OK = 'f9-inviter-ok';

const inviteIds: Record<string, string> = {};
const groupIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertGroup(ownerId: string): Promise<string> {
  const groupId = `f9-g-${await generateSnowflakeId()}`;
  await db.insert(groups).values({
    id: groupId,
    name: `f9 group ${groupId.slice(-6)}`,
    type: 'user',
    ownerId,
    createdById: ownerId,
    updatedAt: new Date(),
  });
  groupIds.push(groupId);
  return groupId;
}

async function insertInvite(
  key: string,
  groupId: string,
  invitedUserId: string,
  invitedBy: string
) {
  const id = await generateSnowflakeId();
  await db.insert(groupInvites).values({
    id,
    groupId,
    invitedUserId,
    invitedBy,
    status: 'pending',
    invitedAt: new Date(),
  });
  inviteIds[key] = id;
  return id;
}

async function mcpInviteIds(userId: string): Promise<string[]> {
  const result = await executeGetGroupInvites(
    { agentId: 'agent', userId } as Parameters<
      typeof executeGetGroupInvites
    >[0],
    {}
  );
  return result.invites.map((i) => i.id).sort();
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/feed_f9r3$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    process.env.DATABASE_READ_REPLICA_URL
  )
    throw new Error(
      'Fixture requires DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f9r3'
    );

  await insertUser(CALLER);
  await insertUser(STRANGER);
  await insertUser(INV_BLOCKED);
  await insertUser(INV_MUTED);
  await insertUser(INV_BLOCKER);
  await insertUser(INV_OK);

  // Caller moderation relationships (from the viewer's side)
  const block1 = await generateSnowflakeId();
  const block2 = await generateSnowflakeId();
  const mute1 = await generateSnowflakeId();
  await db.insert(userBlocks).values([
    { id: block1, blockerId: CALLER, blockedId: INV_BLOCKED },
    { id: block2, blockerId: INV_BLOCKER, blockedId: CALLER },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: mute1, muterId: CALLER, mutedId: INV_MUTED }]);
  blockIds.push(block1, block2);
  muteIds.push(mute1);

  // One group + pending invite per inviter, addressed to CALLER ...
  await insertInvite(
    'caller-blocked',
    await insertGroup(INV_BLOCKED),
    CALLER,
    INV_BLOCKED
  );
  await insertInvite(
    'caller-muted',
    await insertGroup(INV_MUTED),
    CALLER,
    INV_MUTED
  );
  await insertInvite(
    'caller-blocker',
    await insertGroup(INV_BLOCKER),
    CALLER,
    INV_BLOCKER
  );
  await insertInvite('caller-ok', await insertGroup(INV_OK), CALLER, INV_OK);
  // ... and the same four inviters addressing STRANGER (control).
  await insertInvite(
    'stranger-blocked',
    await insertGroup(INV_BLOCKED),
    STRANGER,
    INV_BLOCKED
  );
  await insertInvite(
    'stranger-muted',
    await insertGroup(INV_MUTED),
    STRANGER,
    INV_MUTED
  );
  await insertInvite(
    'stranger-blocker',
    await insertGroup(INV_BLOCKER),
    STRANGER,
    INV_BLOCKER
  );
  await insertInvite(
    'stranger-ok',
    await insertGroup(INV_OK),
    STRANGER,
    INV_OK
  );
});

afterAll(async () => {
  const { inArray } = await import('@feed/db');
  await db
    .delete(groupInvites)
    .where(inArray(groupInvites.id, Object.values(inviteIds)));
  await db.delete(groups).where(inArray(groups.id, groupIds));
  await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
  await db.delete(userMutes).where(inArray(userMutes.id, muteIds));
  await db
    .delete(users)
    .where(
      inArray(users.id, [
        CALLER,
        STRANGER,
        INV_BLOCKED,
        INV_MUTED,
        INV_BLOCKER,
        INV_OK,
      ])
    );
});

describe('MCP group invite list viewer moderation', () => {
  it('MCP: hides invites from blocked, muted and blocked-by inviters', async () => {
    const ids = await mcpInviteIds(CALLER);
    expect(ids).toEqual([inviteIds['caller-ok']]);
  });

  it('MCP: unrelated viewer sees all four invites', async () => {
    const ids = await mcpInviteIds(STRANGER);
    expect(ids).toEqual(
      [
        inviteIds['stranger-blocked'],
        inviteIds['stranger-muted'],
        inviteIds['stranger-blocker'],
        inviteIds['stranger-ok'],
      ].sort()
    );
  });
});
