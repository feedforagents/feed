/**
 * getAgentGroupChats against a real database: the group list an autonomous
 * agent uses to decide where it may share and respond must only contain
 * group chats the agent is still an active participant of, and each
 * memberCount must count only active participants.
 *
 * Every other surface treats an inactive ChatParticipant row as "no longer
 * a member": the sibling resolver in the same file
 * (resolveGroupChatByName) filters `isActive: true`, the A2A chat list
 * filters both the viewer's participation and the member list by
 * `isActive: true`, GET /api/groups counts only active GroupMember rows,
 * and the admin group list loads only active chat participants. Leaving a
 * group (A2A leaveChat / MCP leave_chat) and being kicked both keep the
 * ChatParticipant row with `isActive: false`. But getAgentGroupChats built
 * its participation subquery and its member-count join without the
 * isActive condition, so a group the agent had left (or was kicked from)
 * stayed in its group list, and every listed group counted departed
 * members as still present.
 *
 * The only stub is the `server-only` marker package; the database and the
 * function under test run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { chatParticipants, chats, db, groups, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

let agentId: string;
let activeMemberId: string;
let departedMemberId: string;
let stayedGroupId: string;
let stayedChatId: string;
let leftGroupId: string;
let leftChatId: string;
const allUserIds: string[] = [];
const allGroupIds: string[] = [];
const allChatIds: string[] = [];

let getAgentGroupChats: typeof import('../../../packages/agents/src/autonomous/utils/context-gatherers').getAgentGroupChats;

beforeAll(async () => {
  ({ getAgentGroupChats } = await import(
    '../../../packages/agents/src/autonomous/utils/context-gatherers'
  ));

  [agentId, activeMemberId, departedMemberId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  [stayedGroupId, stayedChatId, leftGroupId, leftChatId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allUserIds.push(agentId, activeMemberId, departedMemberId);
  allGroupIds.push(stayedGroupId, leftGroupId);
  allChatIds.push(stayedChatId, leftChatId);

  const now = new Date();

  await db.insert(users).values([
    {
      id: agentId,
      username: `test-g8-agent-${agentId}`,
      displayName: 'G8 Agent',
      updatedAt: now,
    },
    {
      id: activeMemberId,
      username: `test-g8-active-${activeMemberId}`,
      displayName: 'G8 Active Member',
      updatedAt: now,
    },
    {
      id: departedMemberId,
      username: `test-g8-departed-${departedMemberId}`,
      displayName: 'G8 Departed Member',
      updatedAt: now,
    },
  ]);

  await db.insert(groups).values([
    {
      id: stayedGroupId,
      name: 'G8 Stayed Group',
      type: 'user',
      ownerId: agentId,
      createdById: agentId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: leftGroupId,
      name: 'G8 Left Group',
      type: 'user',
      ownerId: activeMemberId,
      createdById: activeMemberId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(chats).values([
    {
      id: stayedChatId,
      name: 'G8 Stayed Group',
      isGroup: true,
      groupId: stayedGroupId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: leftChatId,
      name: 'G8 Left Group',
      isGroup: true,
      groupId: leftGroupId,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const participant = async (
    chatId: string,
    userId: string,
    isActive: boolean
  ) => ({
    id: await generateSnowflakeId(),
    chatId,
    userId,
    joinedAt: now,
    isActive,
  });

  await db.insert(chatParticipants).values([
    // Stayed chat: agent + one active member + one departed (kicked) member
    // whose row remains with isActive: false.
    await participant(stayedChatId, agentId, true),
    await participant(stayedChatId, activeMemberId, true),
    await participant(stayedChatId, departedMemberId, false),
    // Left chat: the agent's own row is inactive (it left / was removed);
    // another member is still active.
    await participant(leftChatId, agentId, false),
    await participant(leftChatId, activeMemberId, true),
  ]);
});

afterAll(async () => {
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, allChatIds));
  await db.delete(chats).where(inArray(chats.id, allChatIds));
  await db.delete(groups).where(inArray(groups.id, allGroupIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('getAgentGroupChats active-participant filtering', () => {
  it('includes group chats the agent actively participates in', async () => {
    const result = await getAgentGroupChats(agentId);
    expect(result.map((c) => c.id)).toContain(stayedChatId);
  });

  it('excludes group chats the agent has left or was removed from', async () => {
    const result = await getAgentGroupChats(agentId);
    expect(result.map((c) => c.id)).not.toContain(leftChatId);
  });

  it('counts only active participants in memberCount', async () => {
    const result = await getAgentGroupChats(agentId);
    const stayed = result.find((c) => c.id === stayedChatId);
    expect(stayed).toBeDefined();
    // Agent + active member = 2; the departed member's inactive row must
    // not be counted.
    expect(stayed!.memberCount).toBe(2);
  });
});
