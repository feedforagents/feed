/**
 * Group invite vs block relationship — through the REAL route handlers.
 *
 * A user who blocked (or was blocked by) the inviter must not receive the
 * group invite: the invite list must not show it, accepting it must fail,
 * and creating it must be rejected. Today none of the three paths checks
 * blocks at all — the invite is created, listed and accepted even though
 * every neighbouring surface refuses contact between blocked users:
 *
 * - DM send rejects when either side blocked
 *   (apps/web/src/app/api/chats/[id]/message/route.ts, BLOCKED_USER)
 * - createNotification skips creation when either side blocked
 *   (packages/api/src/services/notification-service.ts)
 * - the notification list and the unread count hide blocked/muted actors
 *   at read time (apps/web/src/app/api/notifications/route.ts,
 *   apps/web/src/app/api/chats/unread-count/route.ts)
 * - group chat history applies the viewer moderation filter (#1710, merged)
 * - comments/follows between blocked users are rejected (#1822, #1676)
 *
 * The group invite is the one contact path with no block check anywhere:
 * POST /api/groups (memberIds), POST /api/groups/[id]/members, GET
 * /api/groups/invites and acceptGroupInvite all ignore UserBlock.
 *
 * Auth: steward:test:<userId> with ALLOW_TEST_PRIVY_DID_AUTH=true.
 * Run with: DISABLE_RATE_LIMITING=true DATABASE_URL=... TZ=UTC bun test
 *   integration/group-invite-blocked.integration.test.ts
 *   --preload ./integration/preload.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  dbWrite,
  generateSnowflakeId,
  groupInvites,
  groupMembers,
  groups,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { POST as addMember } from '@/app/api/groups/[groupId]/members/route';
import { POST as acceptInvite } from '@/app/api/groups/invites/[inviteId]/accept/route';
import { GET as listInvites } from '@/app/api/groups/invites/route';
import { POST as createGroup } from '@/app/api/groups/route';

const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;

const createdUsers: string[] = [];
const createdGroups: string[] = [];
const createdChats: string[] = [];
const createdInvites: string[] = [];
const createdBlocks: string[] = [];
const createdMutes: string[] = [];

function authHeaders(userId: string) {
  return {
    'Content-Type': 'application/json',
    authorization: `Bearer steward:test:${userId}`,
  };
}

async function createUser(tag: string): Promise<string> {
  const id = await generateSnowflakeId();
  await dbWrite.insert(users).values({
    id,
    username: `ginv-${tag}-${id.slice(-6)}`,
    displayName: `GInv ${tag} ${id.slice(-6)}`,
    isTest: true,
    updatedAt: new Date(),
  });
  createdUsers.push(id);
  return id;
}

async function block(blockerId: string, blockedId: string): Promise<void> {
  const id = await generateSnowflakeId();
  await dbWrite.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
  });
  createdBlocks.push(id);
}

async function mute(muterId: string, mutedId: string): Promise<void> {
  const id = await generateSnowflakeId();
  await dbWrite.insert(userMutes).values({
    id,
    muterId,
    mutedId,
  });
  createdMutes.push(id);
}

/** Group + chat + owner membership, built the way POST /api/groups does. */
async function createGroupFixture(ownerId: string, name: string) {
  const groupId = `ginv-g-${await generateSnowflakeId()}`;
  const chatId = `ginv-c-${await generateSnowflakeId()}`;
  const now = new Date();
  await dbWrite.insert(groups).values({
    id: groupId,
    name,
    type: 'user',
    ownerId,
    createdById: ownerId,
    updatedAt: now,
  });
  await dbWrite.insert(chats).values({
    id: chatId,
    name,
    isGroup: true,
    groupId,
    createdAt: now,
    updatedAt: now,
  });
  await dbWrite.insert(groupMembers).values({
    id: await generateSnowflakeId(),
    groupId,
    userId: ownerId,
    role: 'owner',
    addedBy: ownerId,
    joinedAt: now,
    isActive: true,
    messageCount: 0,
    qualityScore: 1.0,
  });
  await dbWrite.insert(chatParticipants).values({
    id: await generateSnowflakeId(),
    chatId,
    userId: ownerId,
    joinedAt: now,
    isActive: true,
  });
  createdGroups.push(groupId);
  createdChats.push(chatId);
  return { groupId, chatId };
}

/** Pending invite row, as if created before the block existed. */
async function insertInvite(
  groupId: string,
  invitedUserId: string,
  invitedBy: string
): Promise<string> {
  const inviteId = await generateSnowflakeId();
  await dbWrite.insert(groupInvites).values({
    id: inviteId,
    groupId,
    invitedUserId,
    invitedBy,
    status: 'pending',
    invitedAt: new Date(),
  });
  createdInvites.push(inviteId);
  return inviteId;
}

async function inviteViaHandler(
  groupId: string,
  inviterId: string,
  inviteeId: string
): Promise<Response> {
  return addMember(
    new NextRequest(`http://localhost/api/groups/${groupId}/members`, {
      method: 'POST',
      headers: authHeaders(inviterId),
      body: JSON.stringify({ userId: inviteeId }),
    }),
    { params: Promise.resolve({ groupId }) }
  );
}

async function listInvitesAs(userId: string) {
  const res = await listInvites(
    new NextRequest('http://localhost/api/groups/invites', {
      headers: authHeaders(userId),
    })
  );
  const body = (await res.json()) as {
    invites: Array<{ inviteId: string; groupId: string }>;
  };
  return { status: res.status, invites: body.invites ?? [] };
}

async function acceptAs(userId: string, inviteId: string): Promise<Response> {
  return acceptInvite(
    new NextRequest(`http://localhost/api/groups/invites/${inviteId}/accept`, {
      method: 'POST',
      headers: authHeaders(userId),
    }),
    { params: Promise.resolve({ inviteId }) }
  );
}

async function isMember(groupId: string, userId: string): Promise<boolean> {
  const found = await dbWrite.query.groupMembers.findFirst({
    where: (m, { and, eq: e }) =>
      and(e(m.groupId, groupId), e(m.userId, userId), e(m.isActive, true)),
  });
  return !!found;
}

beforeAll(() => {
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
});

afterAll(async () => {
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
  // Clean up in reverse dependency order. Fixture ids are unique snowflakes.
  if (createdInvites.length > 0) {
    await dbWrite
      .delete(groupInvites)
      .where(eq(groupInvites.id, createdInvites[0]));
    for (const id of createdInvites.slice(1)) {
      await dbWrite.delete(groupInvites).where(eq(groupInvites.id, id));
    }
  }
  for (const id of createdChats) {
    await dbWrite
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, id));
    await dbWrite.delete(chats).where(eq(chats.id, id));
  }
  for (const id of createdGroups) {
    await dbWrite.delete(groupMembers).where(eq(groupMembers.groupId, id));
    await dbWrite.delete(groups).where(eq(groups.id, id));
  }
  for (const id of createdBlocks) {
    await dbWrite.delete(userBlocks).where(eq(userBlocks.id, id));
  }
  for (const id of createdMutes) {
    await dbWrite.delete(userMutes).where(eq(userMutes.id, id));
  }
  for (const id of createdUsers) {
    await dbWrite.delete(users).where(eq(users.id, id));
  }
});

describe('group invite vs block relationship', () => {
  it('(a) inviting a user who blocked the inviter is rejected', async () => {
    const inviter = await createUser('inviter-a');
    const invitee = await createUser('invitee-a');
    const { groupId } = await createGroupFixture(inviter, 'ginv-a');
    await block(invitee, inviter);

    const res = await inviteViaHandler(groupId, inviter, invitee);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await isMember(groupId, invitee)).toBe(false);
  });

  it('(b) inviting a user the inviter blocked is rejected', async () => {
    const inviter = await createUser('inviter-b');
    const invitee = await createUser('invitee-b');
    const { groupId } = await createGroupFixture(inviter, 'ginv-b');
    await block(inviter, invitee);

    const res = await inviteViaHandler(groupId, inviter, invitee);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await isMember(groupId, invitee)).toBe(false);
  });

  it('(c) a pre-block invite is hidden from the invites list', async () => {
    const inviter = await createUser('inviter-c');
    const invitee = await createUser('invitee-c');
    const { groupId } = await createGroupFixture(inviter, 'ginv-c');
    const inviteId = await insertInvite(groupId, invitee, inviter);
    await block(invitee, inviter);

    const { status, invites } = await listInvitesAs(invitee);
    expect(status).toBe(200);
    expect(invites.map((i) => i.inviteId)).not.toContain(inviteId);
  });

  it('(d) accepting a pre-block invite fails and adds no membership', async () => {
    const inviter = await createUser('inviter-d');
    const invitee = await createUser('invitee-d');
    const { groupId } = await createGroupFixture(inviter, 'ginv-d');
    const inviteId = await insertInvite(groupId, invitee, inviter);
    await block(invitee, inviter);

    const res = await acceptAs(invitee, inviteId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await isMember(groupId, invitee)).toBe(false);
  });

  it('(e) a muted inviter’s invite is hidden from the invites list', async () => {
    const inviter = await createUser('inviter-e');
    const invitee = await createUser('invitee-e');
    const { groupId } = await createGroupFixture(inviter, 'ginv-e');
    const inviteId = await insertInvite(groupId, invitee, inviter);
    await mute(invitee, inviter);

    const { status, invites } = await listInvitesAs(invitee);
    expect(status).toBe(200);
    expect(invites.map((i) => i.inviteId)).not.toContain(inviteId);
  });

  it('(f) group creation skips a blocked human from invites', async () => {
    const creator = await createUser('creator-f');
    const blockedHuman = await createUser('blocked-f');
    await block(blockedHuman, creator);

    const res = await createGroup(
      new NextRequest('http://localhost/api/groups', {
        method: 'POST',
        headers: authHeaders(creator),
        body: JSON.stringify({
          name: 'ginv-f',
          memberIds: [blockedHuman],
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      group: { id: string; invitedCount: number };
    };
    expect(body.group.invitedCount).toBe(0);
    const rows = await dbWrite.query.groupInvites.findMany({
      where: (inv, { eq: e }) => e(inv.groupId, body.group.id),
    });
    expect(rows).toHaveLength(0);
    createdGroups.push(body.group.id);
  });

  it('(control) an unblocked invite still lists and accepts', async () => {
    const inviter = await createUser('inviter-g');
    const invitee = await createUser('invitee-g');
    const { groupId } = await createGroupFixture(inviter, 'ginv-g');

    const inviteRes = await inviteViaHandler(groupId, inviter, invitee);
    expect(inviteRes.status).toBe(200);
    const inviteBody = (await inviteRes.json()) as { invited: boolean };
    expect(inviteBody.invited).toBe(true);

    const { status, invites } = await listInvitesAs(invitee);
    expect(status).toBe(200);
    expect(invites.length).toBeGreaterThan(0);
    const inviteId = invites.find((i) => i.groupId === groupId)?.inviteId;
    expect(inviteId).toBeDefined();

    const acceptRes = await acceptAs(invitee, inviteId!);
    expect(acceptRes.status).toBe(200);
    expect(await isMember(groupId, invitee)).toBe(true);
  });
});
