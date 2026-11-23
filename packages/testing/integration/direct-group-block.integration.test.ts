/**
 * PRD §12 and MVP Phase 5: autonomous group creation and invites
 * use the same bilateral block rule as web and MCP groups.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'direct group block rules';
const createCase = 'create_group skips blocked members in either direction';
const inviteCase = 'invite rejects a blocked user in either direction';
const kickedCase =
  'invite does not reactivate a kicked member the agent blocked';
const controlCase = 'clean and muted members are still added by both paths';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  it('checks direct group moderation in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'direct-group-block',
      file: 'packages/testing/integration/direct-group-block.integration.test.ts',
      cases: [createCase, inviteCase, kickedCase, controlCase].map(
        (name) => `${suite} > ${name}`
      ),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    and,
    chatParticipants,
    closeDatabase,
    db,
    eq,
    groupMembers,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const {
    executeDirectCreateGroup,
    executeDirectInviteToGroup,
    executeDirectKickFromGroup,
  } = await import('../../agents/src/autonomous/DirectExecutors');
  type DirectCreateGroupResult = Awaited<
    ReturnType<typeof executeDirectCreateGroup>
  >;
  afterAll(async () => {
    await closeDatabase();
  });

  const agentUserId = await generateSnowflakeId();
  const blockedByAgentId = await generateSnowflakeId();
  const blockerOfAgentId = await generateSnowflakeId();
  const cleanUserId = await generateSnowflakeId();
  const allUserIds = [
    agentUserId,
    blockedByAgentId,
    blockerOfAgentId,
    cleanUserId,
  ];

  async function memberIds(groupId: string): Promise<string[]> {
    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((r) => r.userId);
  }

  async function participantIds(chatId: string): Promise<string[]> {
    const rows = await db
      .select({ userId: chatParticipants.userId })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.isActive, true)
        )
      );
    return rows.map((r) => r.userId);
  }

  function requireIds(result: DirectCreateGroupResult): {
    groupId: string;
    chatId: string;
  } {
    if (!result.groupId || !result.chatId) {
      throw new Error('expected groupId and chatId on success');
    }
    return { groupId: result.groupId, chatId: result.chatId };
  }

  beforeAll(async () => {
    await db.insert(users).values(
      allUserIds.map((id) => ({
        id,
        username: `direct_group_${id.slice(-10)}`,
        updatedAt: new Date(),
      }))
    );
    await db.insert(userBlocks).values([
      {
        id: await generateSnowflakeId(),
        blockerId: agentUserId,
        blockedId: blockedByAgentId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: blockerOfAgentId,
        blockedId: agentUserId,
      },
    ]);
    await db.insert(userMutes).values({
      id: await generateSnowflakeId(),
      muterId: agentUserId,
      mutedId: cleanUserId,
    });
  });

  describe(suite, () => {
    it(createCase, async () => {
      const result = await executeDirectCreateGroup({
        agentUserId,
        name: 'blocked-skip',
        memberIds: [blockedByAgentId, blockerOfAgentId, cleanUserId],
      });
      expect(result.success).toBe(true);
      const { groupId, chatId } = requireIds(result);
      const expected = [agentUserId, cleanUserId].sort();
      expect((await memberIds(groupId)).sort()).toEqual(expected);
      expect((await participantIds(chatId)).sort()).toEqual(expected);
    });

    it(inviteCase, async () => {
      const created = await executeDirectCreateGroup({
        agentUserId,
        name: 'invite-block',
        memberIds: [cleanUserId],
      });
      expect(created.success).toBe(true);
      const { groupId, chatId } = requireIds(created);

      const blocked = await executeDirectInviteToGroup({
        agentUserId,
        groupId,
        targetUserId: blockedByAgentId,
      });
      expect(blocked).toEqual({
        success: false,
        error: 'Cannot invite this user',
      });
      const blocker = await executeDirectInviteToGroup({
        agentUserId,
        groupId,
        targetUserId: blockerOfAgentId,
      });
      expect(blocker).toEqual({
        success: false,
        error: 'Cannot invite this user',
      });
      const expected = [agentUserId, cleanUserId].sort();
      expect((await memberIds(groupId)).sort()).toEqual(expected);
      expect((await participantIds(chatId)).sort()).toEqual(expected);
    });

    it(kickedCase, async () => {
      const reactivateUserId = await generateSnowflakeId();
      await db.insert(users).values({
        id: reactivateUserId,
        username: `direct_group_${reactivateUserId.slice(-10)}`,
        updatedAt: new Date(),
      });
      const created = await executeDirectCreateGroup({
        agentUserId,
        name: 'invite-kicked',
        memberIds: [reactivateUserId],
      });
      expect(created.success).toBe(true);
      const { groupId, chatId } = requireIds(created);
      expect(await memberIds(groupId)).toContain(reactivateUserId);

      const kicked = await executeDirectKickFromGroup({
        agentUserId,
        groupId,
        targetUserId: reactivateUserId,
      });
      expect(kicked.success).toBe(true);
      const [inactive] = await db
        .select({ isActive: groupMembers.isActive })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, reactivateUserId)
          )
        );
      expect(inactive?.isActive).toBe(false);

      // The agent blocks the kicked member afterwards; invite must not
      // reactivate the row.
      await db.insert(userBlocks).values({
        id: await generateSnowflakeId(),
        blockerId: agentUserId,
        blockedId: reactivateUserId,
      });
      const invited = await executeDirectInviteToGroup({
        agentUserId,
        groupId,
        targetUserId: reactivateUserId,
      });
      expect(invited.success).toBe(false);
      const [still] = await db
        .select({ isActive: groupMembers.isActive })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, groupId),
            eq(groupMembers.userId, reactivateUserId)
          )
        );
      expect(still?.isActive).toBe(false);
      expect(await participantIds(chatId)).not.toContain(reactivateUserId);
    });

    it(controlCase, async () => {
      const created = await executeDirectCreateGroup({
        agentUserId,
        name: 'invite-clean',
        memberIds: [cleanUserId],
      });
      expect(created.success).toBe(true);
      const { groupId, chatId } = requireIds(created);
      expect(await memberIds(groupId)).toContain(cleanUserId);

      const otherUserId = await generateSnowflakeId();
      await db.insert(users).values({
        id: otherUserId,
        username: `direct_group_${otherUserId.slice(-10)}`,
        updatedAt: new Date(),
      });
      const invited = await executeDirectInviteToGroup({
        agentUserId,
        groupId,
        targetUserId: otherUserId,
      });
      expect(invited.success).toBe(true);
      const repeated = await executeDirectInviteToGroup({
        agentUserId,
        groupId,
        targetUserId: otherUserId,
      });
      expect(repeated).toEqual({ success: true, alreadyMember: true });
      const expected = [agentUserId, cleanUserId, otherUserId].sort();
      expect((await memberIds(groupId)).sort()).toEqual(expected);
      expect((await participantIds(chatId)).sort()).toEqual(expected);
    });
  });
}
