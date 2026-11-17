/**
 * MCP group creation must not direct-add a member with a block relationship
 * to the creator. The web invite flow already refuses blocked users (DM
 * send, notifications, comments, follows, group invite routes), but MCP
 * create_group adds members straight into GroupMember + ChatParticipant
 * with no block check at all. A blocked user ends up in the same room with
 * no invite to decline.
 *
 * MCP only: the A2A half of this fix was dropped — A2A is outside the
 * current MVP scope (maintainer decision on #1888).
 *
 * Requires DATABASE_URL pointing at a disposable local database with schema
 * applied (e.g. feed_f6r2).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
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
import { executeCreateGroup } from '../../mcp/src/handlers/tool-handlers';

const createdUserIds: string[] = [];
const createdBlockIds: string[] = [];
const createdChatIds: string[] = [];
const createdGroupIds: string[] = [];

async function createUser(
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `f6_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
    ...overrides,
  });
  createdUserIds.push(id);
  return id;
}

async function blockUser(blockerId: string, blockedId: string) {
  const id = crypto.randomUUID();
  await db.insert(userBlocks).values({ id, blockerId, blockedId });
  createdBlockIds.push(id);
}

const agentFor = (userId: string) =>
  ({ agentId: 'agent', userId }) as Parameters<typeof executeCreateGroup>[0];

async function mcpGroupMembers(
  creatorId: string,
  memberIds: string[]
): Promise<{ chatId: string; groupId: string }> {
  const result = await executeCreateGroup(agentFor(creatorId), {
    name: 'f6 mcp blocked',
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

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/feed_f6r2$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    process.env.DATABASE_READ_REPLICA_URL
  )
    throw new Error(
      'Blocked group fixture requires DATABASE_URL=feed_f6r2 on localhost'
    );
});

describe('MCP create_group with a block relationship', () => {
  it('does not add a member the creator blocked', async () => {
    const creator = await createUser();
    const blocked = await createUser();
    await blockUser(creator, blocked);
    const { chatId, groupId } = await mcpGroupMembers(creator, [blocked]);
    expect(await participantIds(chatId)).toEqual([creator]);
    expect(await memberIds(groupId)).toEqual([creator]);
  });

  it('does not add a member who blocked the creator', async () => {
    const creator = await createUser();
    const blocker = await createUser();
    await blockUser(blocker, creator);
    const { chatId, groupId } = await mcpGroupMembers(creator, [blocker]);
    expect(await participantIds(chatId)).toEqual([creator]);
    expect(await memberIds(groupId)).toEqual([creator]);
  });

  it('still adds a real member with no block', async () => {
    const creator = await createUser();
    const member = await createUser();
    const { chatId, groupId } = await mcpGroupMembers(creator, [member]);
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
    if (createdBlockIds.length > 0) {
      await db
        .delete(userBlocks)
        .where(inArray(userBlocks.id, createdBlockIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    const leftoverUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, createdUserIds));
    expect(leftoverUsers).toEqual([]);
  });
});
