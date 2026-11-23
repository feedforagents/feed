/** Retained group invites and viewer moderation (PRD §12, MVP Phase 5). */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  invite: 'group members rejects invitations in both block directions',
  list: 'pending invites are hidden for blocks and mutes',
  accept: 'blocked acceptance leaves the invite pending and adds no membership',
  create:
    'group creation skips blocked humans and agents but adds eligible members',
  control: 'an unblocked invite can be created, listed and accepted',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks group invites in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'group-invite-blocked',
      file: 'packages/testing/integration/group-invite-blocked.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // Group writes and their moderation checks must fit on one connection.
  process.env.DATABASE_POOL_MAX = '1';
  const {
    and,
    chatParticipants,
    chats,
    db,
    eq,
    groupInvites,
    groupMembers,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { POST: addMember } = await import(
    '../../../apps/web/src/app/api/groups/[groupId]/members/route'
  );
  const { POST: acceptInvite } = await import(
    '../../../apps/web/src/app/api/groups/invites/[inviteId]/accept/route'
  );
  const { GET: listInvites } = await import(
    '../../../apps/web/src/app/api/groups/invites/route'
  );
  const { POST: createGroup } = await import(
    '../../../apps/web/src/app/api/groups/route'
  );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const nextRequest = new NextRequest(request);
      if (pathname === '/api/groups' && request.method === 'POST')
        return createGroup(nextRequest);
      if (pathname === '/api/groups/invites' && request.method === 'GET')
        return listInvites(nextRequest);
      const groupId = pathname.match(/^\/api\/groups\/([^/]+)\/members$/)?.[1];
      if (groupId && request.method === 'POST') {
        return addMember(nextRequest, { params: Promise.resolve({ groupId }) });
      }
      const inviteId = pathname.match(
        /^\/api\/groups\/invites\/([^/]+)\/accept$/
      )?.[1];
      if (inviteId && request.method === 'POST') {
        return acceptInvite(nextRequest, {
          params: Promise.resolve({ inviteId }),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  async function createUser(isAgent = false) {
    const id = crypto.randomUUID();
    const stewardId = `lease-group-invite-${id}`;
    await db.insert(users).values({
      id,
      username: `lease-group-${id.slice(0, 8)}`,
      displayName: 'Group invitation fixture',
      stewardId,
      isAgent,
      updatedAt: new Date(),
    });
    return { id, token: await createStewardTestToken(stewardId) };
  }

  async function request(token: string, route: string, body?: object) {
    const requestId = crypto.randomUUID();
    const response = await fetch(new URL(route, server.url), {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    console.info('Group invite response', {
      requestId,
      route,
      status: response.status,
    });
    return response;
  }

  async function group(token: string, memberIds: string[] = []) {
    const response = await request(token, '/api/groups', {
      name: 'Invite test group',
      memberIds,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      group: { id: string; memberCount: number; invitedCount: number };
    };
    return result.group;
  }

  async function invite(token: string, groupId: string, userId: string) {
    return request(token, `/api/groups/${groupId}/members`, { userId });
  }

  async function blocked(blockerId: string, blockedId: string) {
    await db.insert(userBlocks).values({
      id: crypto.randomUUID(),
      blockerId,
      blockedId,
    });
  }

  async function invites(groupId: string) {
    return db
      .select({ id: groupInvites.id, userId: groupInvites.invitedUserId })
      .from(groupInvites)
      .where(eq(groupInvites.groupId, groupId));
  }

  async function pendingInvite(token: string, groupId: string, userId: string) {
    const response = await invite(token, groupId, userId);
    expect(response.status).toBe(200);
    const rows = await invites(groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
    return rows[0]!.id;
  }

  async function listedInviteIds(token: string) {
    const response = await request(token, '/api/groups/invites');
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      invites: { inviteId: string }[];
    };
    return result.invites.map(({ inviteId }) => inviteId);
  }

  async function accept(token: string, inviteId: string) {
    return request(token, `/api/groups/invites/${inviteId}/accept`, {});
  }

  async function membership(groupId: string, userId: string) {
    const [member] = await db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))
      );
    const [participant] = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .innerJoin(chats, eq(chats.id, chatParticipants.chatId))
      .where(
        and(eq(chats.groupId, groupId), eq(chatParticipants.userId, userId))
      );
    return { group: !!member, chat: !!participant };
  }

  test(cases.invite, async () => {
    const owner = await createUser();
    const { id } = await group(owner.token);
    const blockedByOwner = await createUser();
    const blockedOwner = await createUser();
    await blocked(owner.id, blockedByOwner.id);
    await blocked(blockedOwner.id, owner.id);
    for (const userId of [blockedByOwner.id, blockedOwner.id]) {
      expect((await invite(owner.token, id, userId)).status).toBe(400);
      expect(await membership(id, userId)).toEqual({
        group: false,
        chat: false,
      });
    }
    expect(await invites(id)).toEqual([]);
  });

  test(cases.list, async () => {
    const viewer = await createUser();
    for (const direction of ['outgoing', 'incoming', 'mute']) {
      const owner = await createUser();
      const { id } = await group(owner.token);
      const inviteId = await pendingInvite(owner.token, id, viewer.id);
      expect(await listedInviteIds(viewer.token)).toContain(inviteId);
      if (direction === 'mute') {
        await db.insert(userMutes).values({
          id: crypto.randomUUID(),
          muterId: viewer.id,
          mutedId: owner.id,
        });
      } else if (direction === 'outgoing') {
        await blocked(viewer.id, owner.id);
      } else {
        await blocked(owner.id, viewer.id);
      }
      expect(await listedInviteIds(viewer.token)).not.toContain(inviteId);
    }
  });

  test(cases.accept, async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const { id } = await group(owner.token);
    const inviteId = await pendingInvite(owner.token, id, viewer.id);
    await blocked(viewer.id, owner.id);
    expect((await accept(viewer.token, inviteId)).status).toBe(403);
    const [pending] = await db
      .select({
        status: groupInvites.status,
        respondedAt: groupInvites.respondedAt,
      })
      .from(groupInvites)
      .where(eq(groupInvites.id, inviteId));
    expect(pending).toEqual({ status: 'pending', respondedAt: null });
    expect(await membership(id, viewer.id)).toEqual({
      group: false,
      chat: false,
    });
  });

  test(cases.create, async () => {
    const owner = await createUser();
    const human = await createUser();
    const agent = await createUser(true);
    const eligibleAgent = await createUser(true);
    const eligibleHuman = await createUser();
    await blocked(human.id, owner.id);
    await blocked(owner.id, agent.id);
    const created = await group(owner.token, [
      human.id,
      agent.id,
      eligibleAgent.id,
      eligibleHuman.id,
    ]);
    expect(created.memberCount).toBe(2);
    expect(created.invitedCount).toBe(1);
    expect(await membership(created.id, agent.id)).toEqual({
      group: false,
      chat: false,
    });
    expect(await membership(created.id, eligibleAgent.id)).toEqual({
      group: true,
      chat: true,
    });
    expect((await invites(created.id)).map(({ userId }) => userId)).toEqual([
      eligibleHuman.id,
    ]);
  });

  test(cases.control, async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const { id } = await group(owner.token);
    const inviteId = await pendingInvite(owner.token, id, viewer.id);
    expect(await listedInviteIds(viewer.token)).toContain(inviteId);
    expect((await accept(viewer.token, inviteId)).status).toBe(200);
    expect(await membership(id, viewer.id)).toEqual({
      group: true,
      chat: true,
    });
  });
}
