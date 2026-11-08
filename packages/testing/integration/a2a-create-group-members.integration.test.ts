/**
 * messaging.create_group against a real database: the A2A group creator must
 * only add members that exist and are not banned, the same rule the web
 * group route applies (POST /api/groups verifies users exist and are not
 * banned before adding them).
 *
 * The A2A executor added every requested memberId blindly, so a group could
 * be created with ghost members (no user row at all) and with banned users
 * as full members with chat access — rows in GroupMember/ChatParticipant
 * that no user row backs and that the web route would never create.
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
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type CreateGroupResult = {
  success: boolean;
  group: { id: string; name: string; chatId: string };
};

let creatorId: string;
let validMemberId: string;
let bannedMemberId: string;
let ghostMemberId: string;

const allUserIds: string[] = [];
const createdGroupIds: string[] = [];
const createdChatIds: string[] = [];

async function createGroup(
  memberIds: string[],
  name: string
): Promise<CreateGroupResult> {
  return (await FeedAgentExecutor.executeDirectly(
    'messaging.create_group',
    { name, memberIds },
    creatorId
  )) as unknown as CreateGroupResult;
}

async function memberUserIds(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

async function participantUserIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatParticipants.userId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId));
  return rows.map((r) => r.userId);
}

beforeAll(async () => {
  [creatorId, validMemberId, bannedMemberId, ghostMemberId] = await Promise.all(
    [
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]
  );
  allUserIds.push(creatorId, validMemberId, bannedMemberId);

  const now = new Date();
  await db.insert(users).values([
    { id: creatorId, username: `cg-creator-${creatorId}`, updatedAt: now },
    {
      id: validMemberId,
      username: `cg-valid-${validMemberId}`,
      updatedAt: now,
    },
    {
      id: bannedMemberId,
      username: `cg-banned-${bannedMemberId}`,
      isBanned: true,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  if (createdGroupIds.length > 0) {
    await db
      .delete(groupMembers)
      .where(inArray(groupMembers.groupId, createdGroupIds));
    await db.delete(groups).where(inArray(groups.id, createdGroupIds));
  }
  if (createdChatIds.length > 0) {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, createdChatIds));
    await db.delete(chats).where(inArray(chats.id, createdChatIds));
  }
  if (allUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, allUserIds));
  }
});

describe('A2A messaging.create_group member validation', () => {
  it('adds only existing, non-banned members', async () => {
    const result = await createGroup(
      [validMemberId, ghostMemberId, bannedMemberId],
      'Group with invalid members'
    );
    expect(result.success).toBe(true);
    createdGroupIds.push(result.group.id);
    createdChatIds.push(result.group.chatId);

    const members = await memberUserIds(result.group.id);
    expect(members).toContain(creatorId);
    expect(members).toContain(validMemberId);
    expect(members).not.toContain(ghostMemberId);
    expect(members).not.toContain(bannedMemberId);

    const participants = await participantUserIds(result.group.chatId);
    expect(participants).toContain(creatorId);
    expect(participants).toContain(validMemberId);
    expect(participants).not.toContain(ghostMemberId);
    expect(participants).not.toContain(bannedMemberId);
  });

  it('adds a valid member as a control', async () => {
    const result = await createGroup(
      [validMemberId],
      'Group with one valid member'
    );
    expect(result.success).toBe(true);
    createdGroupIds.push(result.group.id);
    createdChatIds.push(result.group.chatId);

    const members = await memberUserIds(result.group.id);
    expect(members).toContain(creatorId);
    expect(members).toContain(validMemberId);
  });
});
