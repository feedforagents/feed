/**
 * MCP leave_chat must follow the same group-owner rule as
 * DELETE /api/chats/[id]/participants/me.
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
let groupId: string;
let chatId: string;
let dmChatId: string;

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
});
