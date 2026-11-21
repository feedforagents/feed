/**
 * Autonomous-agent direct group actions against a real database:
 * executeDirectCreateGroup and executeDirectInviteToGroup must not add a
 * user with a block relationship to the agent into a group.
 *
 * Same rule as the web group creation route (#1938: blocked members are
 * skipped silently) and MCP create_group (#1941: block in either direction
 * bars the member from being direct-added). The agents-direct path had no
 * check at all: any existing user id landed in groupMembers and
 * chatParticipants, and invite could even reactivate a kicked member.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  type DirectCreateGroupResult,
  executeDirectCreateGroup,
  executeDirectInviteToGroup,
  executeDirectKickFromGroup,
} from '../../agents/src/autonomous/DirectExecutors';

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
const createdGroups: string[] = [];
const createdChats: string[] = [];

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
    .where(eq(chatParticipants.chatId, chatId));
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
});

afterAll(async () => {
  if (createdChats.length > 0) {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, createdChats));
    await db.delete(chats).where(inArray(chats.id, createdChats));
  }
  if (createdGroups.length > 0) {
    await db
      .delete(groupMembers)
      .where(inArray(groupMembers.groupId, createdGroups));
    await db.delete(groups).where(inArray(groups.id, createdGroups));
  }
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('direct group block rules', () => {
  it('create_group skips blocked members in either direction', async () => {
    const result = await executeDirectCreateGroup({
      agentUserId,
      name: 'blocked-skip',
      memberIds: [blockedByAgentId, blockerOfAgentId, cleanUserId],
    });
    expect(result.success).toBe(true);
    const { groupId, chatId } = requireIds(result);
    createdGroups.push(groupId);
    createdChats.push(chatId);
    const members = await memberIds(groupId);
    expect(members).toContain(agentUserId);
    expect(members).toContain(cleanUserId);
    expect(members).not.toContain(blockedByAgentId);
    expect(members).not.toContain(blockerOfAgentId);
    const participants = await participantIds(chatId);
    expect(participants).not.toContain(blockedByAgentId);
    expect(participants).not.toContain(blockerOfAgentId);
  });

  it('invite rejects a blocked user in either direction', async () => {
    const created = await executeDirectCreateGroup({
      agentUserId,
      name: 'invite-block',
      memberIds: [cleanUserId],
    });
    expect(created.success).toBe(true);
    const { groupId, chatId } = requireIds(created);
    createdGroups.push(groupId);
    createdChats.push(chatId);

    const blocked = await executeDirectInviteToGroup({
      agentUserId,
      groupId,
      targetUserId: blockedByAgentId,
    });
    expect(blocked.success).toBe(false);
    const blocker = await executeDirectInviteToGroup({
      agentUserId,
      groupId,
      targetUserId: blockerOfAgentId,
    });
    expect(blocker.success).toBe(false);
    const members = await memberIds(groupId);
    expect(members).not.toContain(blockedByAgentId);
    expect(members).not.toContain(blockerOfAgentId);
  });

  it('invite does not reactivate a kicked member the agent blocked', async () => {
    const reactivateUserId = await generateSnowflakeId();
    await db.insert(users).values({
      id: reactivateUserId,
      username: `direct_group_${reactivateUserId.slice(-10)}`,
      updatedAt: new Date(),
    });
    allUserIds.push(reactivateUserId);
    const created = await executeDirectCreateGroup({
      agentUserId,
      name: 'invite-kicked',
      memberIds: [reactivateUserId],
    });
    expect(created.success).toBe(true);
    const { groupId, chatId } = requireIds(created);
    createdGroups.push(groupId);
    createdChats.push(chatId);
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
  });

  it('control: clean members are still added by both paths', async () => {
    const created = await executeDirectCreateGroup({
      agentUserId,
      name: 'invite-clean',
      memberIds: [cleanUserId],
    });
    expect(created.success).toBe(true);
    const { groupId, chatId } = requireIds(created);
    createdGroups.push(groupId);
    createdChats.push(chatId);
    expect(await memberIds(groupId)).toContain(cleanUserId);

    const otherUserId = await generateSnowflakeId();
    await db.insert(users).values({
      id: otherUserId,
      username: `direct_group_${otherUserId.slice(-10)}`,
      updatedAt: new Date(),
    });
    allUserIds.push(otherUserId);
    const invited = await executeDirectInviteToGroup({
      agentUserId,
      groupId,
      targetUserId: otherUserId,
    });
    expect(invited.success).toBe(true);
    expect(await memberIds(groupId)).toContain(otherUserId);
  });
});
