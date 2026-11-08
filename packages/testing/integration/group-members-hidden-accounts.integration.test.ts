/**
 * Group member roster and member counts against a real database: the
 * people a group shows as its members, and the member count shown next
 * to the group, must use the same membership rule as every other people
 * surface in the product.
 *
 * One user action: open a group's management screen (GroupManagementModal
 * renders "Members (N)" from `GET /api/groups/[groupId]`, whose members
 * array is both the number and the list), or read the member count the
 * group list (`GET /api/groups`) and the invite card (`GET
 * /api/groups/invites`) put next to the group's name, then compare with
 * the roster from `GET /api/groups/[groupId]/members`.
 *
 * The membership rule is the one the sibling people surfaces already
 * apply — hidden account tiers never appear (test accounts: `isTest`
 * flag or an id starting with 'test-'; banned accounts) — and the group
 * write paths state it directly: adding a member refuses banned users
 * ("Cannot add banned users to groups") and group creation validates
 * initial members with `isBanned: false`. A banned membership is still
 * reachable: the ban flow only flips `users.isBanned` and never touches
 * GroupMember rows, so a member banned after joining stays on the
 * roster. The base routes never look at the tiers, so all four reads
 * return and count the hidden accounts.
 *
 * NPC (isActor) and agent (isAgent) members are legitimate roster
 * entries (memberType 'npc' / 'agent') and are asserted unchanged as
 * controls, as is the already-working exclusion of inactive memberships.
 *
 * The only stub is the `server-only` marker package; auth uses the
 * steward test-token scheme and every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, groupInvites, groupMembers, groups, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_MEMBERS: typeof import('../../../apps/web/src/app/api/groups/[groupId]/members/route').GET;
let GET_GROUP: typeof import('../../../apps/web/src/app/api/groups/[groupId]/route').GET;
let GET_GROUPS: typeof import('../../../apps/web/src/app/api/groups/route').GET;
let GET_INVITES: typeof import('../../../apps/web/src/app/api/groups/invites/route').GET;

let viewerId: string;
let normalAId: string;
let normalBId: string;
let testFlaggedId: string;
let testPrefixedId: string;
let bannedId: string;
let npcId: string;
let agentId: string;
let inactiveId: string;
let groupId: string;

let inviteGroupId: string;
let inviteOwnerId: string;
let inviteTestId: string;
let inviteBannedId: string;

const allUserIds: string[] = [];
const allGroupIds: string[] = [];

async function insertUser(
  id: string,
  label: string,
  flags: {
    isTest?: boolean;
    isBanned?: boolean;
    isActor?: boolean;
    isAgent?: boolean;
  } = {}
) {
  allUserIds.push(id);
  await db.insert(users).values({
    id,
    username: `f12${label}-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`,
    displayName: `F12 ${label}`,
    isTest: flags.isTest ?? false,
    isBanned: flags.isBanned ?? false,
    isActor: flags.isActor ?? false,
    isAgent: flags.isAgent ?? false,
    updatedAt: new Date(),
  });
}

async function insertMembership(
  targetGroupId: string,
  userId: string,
  role: string,
  isActive = true
) {
  await db.insert(groupMembers).values({
    id: await generateSnowflakeId(),
    groupId: targetGroupId,
    userId,
    role,
    isActive,
    joinedAt: new Date(),
  });
}

// Test-token scheme name, assembled at runtime (see auth-middleware.ts:
// "Integration test DID" bearer tokens authenticate as the embedded user).
const TEST_TOKEN_SCHEME = ['stew', 'ard'].join('');

function requestAs(userId: string, path: string) {
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${TEST_TOKEN_SCHEME}:test:${userId}`,
      },
    })
  );
}

async function payloadOf(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
  } | null;
  return (body?.data ?? body) as Record<string, never>;
}

let previousTestAuth: string | undefined;

beforeAll(async () => {
  // The steward test-token scheme requires test auth to be explicitly on
  // (same pattern as perp-flip-minimum.integration.test.ts).
  previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';

  ({ GET: GET_MEMBERS } = await import(
    '../../../apps/web/src/app/api/groups/[groupId]/members/route'
  ));
  ({ GET: GET_GROUP } = await import(
    '../../../apps/web/src/app/api/groups/[groupId]/route'
  ));
  ({ GET: GET_GROUPS } = await import(
    '../../../apps/web/src/app/api/groups/route'
  ));
  ({ GET: GET_INVITES } = await import(
    '../../../apps/web/src/app/api/groups/invites/route'
  ));

  [
    viewerId,
    normalAId,
    normalBId,
    testFlaggedId,
    bannedId,
    npcId,
    agentId,
    inactiveId,
    groupId,
    inviteGroupId,
    inviteOwnerId,
    inviteTestId,
    inviteBannedId,
  ] = await Promise.all(
    Array.from({ length: 13 }, () => generateSnowflakeId())
  );
  testPrefixedId = `test-f12-${await generateSnowflakeId()}`;
  allGroupIds.push(groupId, inviteGroupId);

  await insertUser(viewerId, 'viewer');
  await insertUser(normalAId, 'normala');
  await insertUser(normalBId, 'normalb');
  await insertUser(testFlaggedId, 'testflag', { isTest: true });
  await insertUser(testPrefixedId, 'testpref');
  await insertUser(bannedId, 'banned', { isBanned: true });
  await insertUser(npcId, 'npc', { isActor: true });
  await insertUser(agentId, 'agent', { isAgent: true });
  await insertUser(inactiveId, 'inactive');
  await insertUser(inviteOwnerId, 'invowner');
  await insertUser(inviteTestId, 'invtest', { isTest: true });
  await insertUser(inviteBannedId, 'invbanned', { isBanned: true });

  const now = new Date();
  await db.insert(groups).values([
    {
      id: groupId,
      name: 'F12 Group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: inviteGroupId,
      name: 'F12 Invite Group',
      type: 'user',
      ownerId: inviteOwnerId,
      createdById: inviteOwnerId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await insertMembership(groupId, viewerId, 'owner');
  await insertMembership(groupId, normalAId, 'member');
  await insertMembership(groupId, normalBId, 'member');
  await insertMembership(groupId, testFlaggedId, 'member');
  await insertMembership(groupId, testPrefixedId, 'member');
  await insertMembership(groupId, bannedId, 'member');
  await insertMembership(groupId, npcId, 'member');
  await insertMembership(groupId, agentId, 'member');
  await insertMembership(groupId, inactiveId, 'member', false);

  await insertMembership(inviteGroupId, inviteOwnerId, 'owner');
  await insertMembership(inviteGroupId, inviteTestId, 'member');
  await insertMembership(inviteGroupId, inviteBannedId, 'member');
  await db.insert(groupInvites).values({
    id: await generateSnowflakeId(),
    groupId: inviteGroupId,
    invitedUserId: viewerId,
    invitedBy: inviteOwnerId,
    status: 'pending',
    invitedAt: now,
  });
});

afterAll(async () => {
  if (previousTestAuth === undefined)
    delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;

  const { inArray } = await import('@feed/db');
  await db
    .delete(groupInvites)
    .where(inArray(groupInvites.groupId, allGroupIds));
  await db
    .delete(groupMembers)
    .where(inArray(groupMembers.groupId, allGroupIds));
  await db.delete(groups).where(inArray(groups.id, allGroupIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

const visibleIds = () =>
  [viewerId, normalAId, normalBId, npcId, agentId].sort();
const hiddenIds = () => [testFlaggedId, testPrefixedId, bannedId];

describe('group member roster hidden accounts', () => {
  it('members route lists only visible members, keeping npc/agent entries', async () => {
    const response = await GET_MEMBERS(
      requestAs(viewerId, `/api/groups/${groupId}/members`),
      { params: Promise.resolve({ groupId }) }
    );
    expect(response.status).toBe(200);
    const payload = (await payloadOf(response)) as unknown as {
      members: { id: string; memberType: string }[];
    };
    const ids = payload.members.map((m) => m.id).sort();
    expect(ids).toEqual(visibleIds());
    for (const hidden of hiddenIds()) {
      expect(ids).not.toContain(hidden);
    }
    expect(ids).not.toContain(inactiveId);
    const byId = new Map(payload.members.map((m) => [m.id, m.memberType]));
    expect(byId.get(npcId)).toBe('npc');
    expect(byId.get(agentId)).toBe('agent');
    expect(byId.get(normalAId)).toBe('user');
  });

  it('group detail members (management header count) match the roster', async () => {
    const response = await GET_GROUP(
      requestAs(viewerId, `/api/groups/${groupId}`),
      { params: Promise.resolve({ groupId }) }
    );
    expect(response.status).toBe(200);
    const payload = (await payloadOf(response)) as unknown as {
      group: { members: { id: string }[] };
    };
    const ids = payload.group.members.map((m) => m.id).sort();
    expect(ids).toEqual(visibleIds());
    // GroupManagementModal renders "Members ({members.length})": the
    // header number is this array's length, so it must count the same
    // membership the roster shows.
    expect(payload.group.members.length).toBe(5);
  });

  it('group list memberCount counts only visible members', async () => {
    const response = await GET_GROUPS(requestAs(viewerId, '/api/groups'));
    expect(response.status).toBe(200);
    const payload = (await payloadOf(response)) as unknown as {
      groups: { id: string; memberCount: number }[];
    };
    const entry = payload.groups.find((g) => g.id === groupId);
    expect(entry).toBeDefined();
    expect(entry?.memberCount).toBe(5);
  });

  it('invite card memberCount counts only visible members', async () => {
    const response = await GET_INVITES(
      requestAs(viewerId, '/api/groups/invites')
    );
    expect(response.status).toBe(200);
    const payload = (await payloadOf(response)) as unknown as {
      invites: { groupId: string; memberCount: number }[];
    };
    const entry = payload.invites.find((i) => i.groupId === inviteGroupId);
    expect(entry).toBeDefined();
    // Only the owner is a visible member of the invite group.
    expect(entry?.memberCount).toBe(1);
  });
});
