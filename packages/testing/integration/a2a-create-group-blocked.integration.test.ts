/**
 * PRD §8.1 and §12 (block/mute), MVP Phase 3: agent tools apply the same
 * moderation as the website. POST /api/groups and MCP create_group (#1941)
 * leave out users in a block relationship with the creator in either
 * direction; A2A messaging.create_group must not add them either.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  dbWrite,
  eq,
  groupMembers,
  groups,
  inArray,
  or,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

const userIds: string[] = [];
const groupIds: string[] = [];

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await dbWrite.insert(users).values({
    id,
    username: `a2a-grp-${id}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function block(blockerId: string, blockedId: string) {
  await dbWrite
    .insert(userBlocks)
    .values({ id: await generateSnowflakeId(), blockerId, blockedId });
}

async function members(groupId: string, chatId: string) {
  const [inGroup, inChat] = await Promise.all([
    dbWrite
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId)),
    dbWrite
      .select({ userId: chatParticipants.userId })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId)),
  ]);
  return {
    group: inGroup.map((m) => m.userId).sort(),
    chat: inChat.map((m) => m.userId).sort(),
  };
}

afterAll(async () => {
  const chatRows = groupIds.length
    ? await dbWrite
        .select({ id: chats.id })
        .from(chats)
        .where(inArray(chats.groupId, groupIds))
    : [];
  const chatIds = chatRows.map((c) => c.id);
  if (chatIds.length)
    await dbWrite
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, chatIds));
  if (groupIds.length) {
    await dbWrite
      .delete(groupMembers)
      .where(inArray(groupMembers.groupId, groupIds));
    await dbWrite.delete(chats).where(inArray(chats.groupId, groupIds));
    await dbWrite.delete(groups).where(inArray(groups.id, groupIds));
  }
  await dbWrite
    .delete(userBlocks)
    .where(
      or(
        inArray(userBlocks.blockerId, userIds),
        inArray(userBlocks.blockedId, userIds)
      )
    );
  await dbWrite.delete(users).where(inArray(users.id, userIds));
});

describe('A2A messaging.create_group blocks', () => {
  it('leaves out members in a block relationship in either direction', async () => {
    const [agentId, friendId, blockerId, blockedId] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser(),
    ]);
    // blockerId blocked the agent; the agent blocked blockedId.
    await block(blockerId, agentId);
    await block(agentId, blockedId);

    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.create_group',
      { name: 'Desk', memberIds: [friendId, blockerId, blockedId] },
      agentId
    )) as { success: boolean; group: { id: string; chatId: string } };
    groupIds.push(result.group.id);

    expect(result.success).toBe(true);
    const expected = [agentId, friendId].sort();
    expect(await members(result.group.id, result.group.chatId)).toEqual({
      group: expected,
      chat: expected,
    });
  });

  it('still adds every member when no block exists', async () => {
    const [agentId, firstId, secondId] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
    ]);

    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.create_group',
      { name: 'Open desk', memberIds: [firstId, secondId] },
      agentId
    )) as { success: boolean; group: { id: string; chatId: string } };
    groupIds.push(result.group.id);

    const expected = [agentId, firstId, secondId].sort();
    expect(await members(result.group.id, result.group.chatId)).toEqual({
      group: expected,
      chat: expected,
    });
  });
});
