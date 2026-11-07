/**
 * MCP leave_chat must follow the same membership rules as
 * DELETE /api/chats/[id]/participants/me: a caller who is not a participant
 * is rejected, and a group owner cannot leave.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
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
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeLeaveChat } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
let ownerId: string;
let memberId: string;
let outsiderId: string;
let groupId: string;
let chatId: string;
let dmChatId: string;

async function snapshotUserRows(userId: string) {
  const participants = await db
    .select({
      id: chatParticipants.id,
      chatId: chatParticipants.chatId,
      isActive: chatParticipants.isActive,
    })
    .from(chatParticipants)
    .where(eq(chatParticipants.userId, userId));
  const members = await db
    .select({
      id: groupMembers.id,
      groupId: groupMembers.groupId,
      isActive: groupMembers.isActive,
      role: groupMembers.role,
      kickReason: groupMembers.kickReason,
      kickedAt: groupMembers.kickedAt,
    })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  const byId = (left: { id: string }, right: { id: string }) =>
    left.id.localeCompare(right.id);
  return {
    participants: participants.sort(byId),
    members: members.sort(byId),
  };
}

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `leave_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

describe('MCP leave_chat group owner policy', () => {
  beforeAll(async () => {
    ownerId = await createUser();
    memberId = await createUser();
    outsiderId = await createUser();
    groupId = await generateSnowflakeId();
    chatId = await generateSnowflakeId();
    dmChatId = await generateSnowflakeId();

    await db.insert(groups).values({
      id: groupId,
      name: 'mcp leave owner group',
      type: 'user',
      ownerId,
      createdById: ownerId,
      updatedAt: new Date(),
    });
    await db.insert(chats).values([
      {
        id: chatId,
        isGroup: true,
        groupId,
        createdBy: ownerId,
        updatedAt: new Date(),
      },
      {
        id: dmChatId,
        isGroup: false,
        createdBy: ownerId,
        updatedAt: new Date(),
      },
    ]);
    await db.insert(groupMembers).values([
      {
        id: await generateSnowflakeId(),
        groupId,
        userId: ownerId,
        role: 'owner',
        addedBy: ownerId,
      },
      {
        id: await generateSnowflakeId(),
        groupId,
        userId: memberId,
        role: 'member',
        addedBy: ownerId,
      },
    ]);
    await db.insert(chatParticipants).values([
      {
        id: await generateSnowflakeId(),
        chatId,
        userId: ownerId,
      },
      {
        id: await generateSnowflakeId(),
        chatId,
        userId: memberId,
      },
      {
        id: await generateSnowflakeId(),
        chatId: dmChatId,
        userId: ownerId,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, [chatId, dmChatId]));
    await db.delete(chats).where(inArray(chats.id, [chatId, dmChatId]));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('refuses to let the group owner leave and keeps both memberships active', async () => {
    await expect(
      executeLeaveChat({ agentId: 'owner-agent', userId: ownerId }, { chatId })
    ).rejects.toThrow(
      'Group owners cannot leave. Transfer ownership or delete the group.'
    );

    const [ownerMembership] = await db
      .select({
        isActive: groupMembers.isActive,
        role: groupMembers.role,
      })
      .from(groupMembers)
      .where(
        and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, ownerId))
      );
    const [ownerParticipant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, ownerId)
        )
      );

    expect(ownerMembership).toEqual({ isActive: true, role: 'owner' });
    expect(ownerParticipant?.isActive).toBe(true);
  });

  it('deactivates a non-owner member of the same group chat', async () => {
    const result = await executeLeaveChat(
      { agentId: 'member-agent', userId: memberId },
      { chatId }
    );
    expect(result).toEqual({ success: true });

    const [membership] = await db
      .select({
        isActive: groupMembers.isActive,
        kickReason: groupMembers.kickReason,
      })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, memberId)
        )
      );
    const [participant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, memberId)
        )
      );

    expect(membership?.isActive).toBe(false);
    expect(membership?.kickReason).toBe('User left');
    expect(participant?.isActive).toBe(false);
  });

  it('still lets the owner leave a direct chat that has no group', async () => {
    const result = await executeLeaveChat(
      { agentId: 'owner-agent', userId: ownerId },
      { chatId: dmChatId }
    );
    expect(result).toEqual({ success: true });

    const [participant] = await db
      .select({ isActive: chatParticipants.isActive })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, dmChatId),
          eq(chatParticipants.userId, ownerId)
        )
      );
    expect(participant?.isActive).toBe(false);
  });

  it('rejects an unknown chatId and does not write a membership', async () => {
    const unknownChatId = await generateSnowflakeId();
    const before = await snapshotUserRows(ownerId);

    await expect(
      executeLeaveChat(
        { agentId: 'owner-agent', userId: ownerId },
        { chatId: unknownChatId }
      )
    ).rejects.toThrow('You are not a member of this chat.');

    const [chat] = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, unknownChatId));
    const strayParticipants = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, unknownChatId));

    expect(chat).toBeUndefined();
    expect(strayParticipants).toEqual([]);
    expect(await snapshotUserRows(ownerId)).toEqual(before);
  });

  it('rejects a caller who is not a participant and leaves existing rows unchanged', async () => {
    const chatBefore = await snapshotUserRows(ownerId);
    const memberBefore = await snapshotUserRows(memberId);
    const outsiderBefore = await snapshotUserRows(outsiderId);

    await expect(
      executeLeaveChat(
        { agentId: 'outsider-agent', userId: outsiderId },
        { chatId }
      )
    ).rejects.toThrow('You are not a member of this chat.');

    expect(await snapshotUserRows(ownerId)).toEqual(chatBefore);
    expect(await snapshotUserRows(memberId)).toEqual(memberBefore);
    expect(await snapshotUserRows(outsiderId)).toEqual(outsiderBefore);
    expect(outsiderBefore.participants).toEqual([]);
    expect(outsiderBefore.members).toEqual([]);
  });
});
