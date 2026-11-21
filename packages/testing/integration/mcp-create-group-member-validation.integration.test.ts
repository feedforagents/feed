/**
 * MCP create_group must only add members that exist and are not banned
 * (the same rule the web group creation route applies). ChatParticipant
 * and GroupMember rows have no foreign key to User, so an unchecked
 * member ID becomes a permanent orphan membership.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  users,
} from '@feed/db';
import { executeCreateGroup } from '../../mcp/src/handlers/tool-handlers';

const createdUserIds: string[] = [];
const createdChatIds: string[] = [];
const createdGroupIds: string[] = [];

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `f184_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
    ...overrides,
  });
  createdUserIds.push(id);
  return id;
}

const agentFor = (userId: string) =>
  ({ agentId: 'agent', userId }) as Parameters<typeof executeCreateGroup>[0];

async function createGroupWith(
  creatorId: string,
  memberIds: string[]
): Promise<{ chatId: string; groupId: string }> {
  const result = await executeCreateGroup(agentFor(creatorId), {
    name: 'f184 member validation',
    memberIds,
  });
  createdChatIds.push(result.chatId);
  const chat = await db.query.chats.findFirst({
    where: (c, { eq: eqOp }) => eqOp(c.id, result.chatId),
  });
  const groupId = chat?.groupId ?? '';
  if (groupId) createdGroupIds.push(groupId);
  return { chatId: result.chatId, groupId };
}

async function participantIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatParticipants.userId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId));
  return rows.map((r) => r.userId).sort();
}

async function memberIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => r.userId).sort();
}

describe('MCP create_group member validation', () => {
  it('does not create membership rows for a user that does not exist', async () => {
    const creator = await createUser();
    const ghostId = crypto.randomUUID();
    const { chatId, groupId } = await createGroupWith(creator, [ghostId]);
    expect(await participantIds(chatId)).toEqual([creator]);
    expect(await memberIds(groupId)).toEqual([creator]);
  });

  it('does not create membership rows for a banned user', async () => {
    const creator = await createUser();
    const banned = await createUser({ isBanned: true });
    const { chatId, groupId } = await createGroupWith(creator, [banned]);
    expect(await participantIds(chatId)).toEqual([creator]);
    expect(await memberIds(groupId)).toEqual([creator]);
  });

  it('still adds a real, unbanned member', async () => {
    const creator = await createUser();
    const member = await createUser();
    const { chatId, groupId } = await createGroupWith(creator, [member]);
    expect(await participantIds(chatId)).toEqual([creator, member].sort());
    expect(await memberIds(groupId)).toEqual([creator, member].sort());
  });

  it('keeps valid members while dropping ghost and banned IDs', async () => {
    const creator = await createUser();
    const member = await createUser();
    const banned = await createUser({ isBanned: true });
    const ghostId = crypto.randomUUID();
    const { chatId, groupId } = await createGroupWith(creator, [
      member,
      banned,
      ghostId,
    ]);
    expect(await participantIds(chatId)).toEqual([creator, member].sort());
    expect(await memberIds(groupId)).toEqual([creator, member].sort());
  });

  afterAll(async () => {
    if (createdChatIds.length > 0) {
      await db
        .delete(chatParticipants)
        .where(inArray(chatParticipants.chatId, createdChatIds));
      await db.delete(chats).where(inArray(chats.id, createdChatIds));
    }
    if (createdGroupIds.length > 0) {
      await db
        .delete(groupMembers)
        .where(inArray(groupMembers.groupId, createdGroupIds));
      await db.delete(groups).where(inArray(groups.id, createdGroupIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    // Residue check: nothing this suite created may survive cleanup.
    const leftoverUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, createdUserIds));
    expect(leftoverUsers).toEqual([]);
  });
});
