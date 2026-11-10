/**
 * FeedAgentExecutor applies the same content/profile/membership policies as
 * the HTTP routes.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import {
  chatParticipants,
  chats,
  comments,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  messages,
  posts,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

const createdUsers: string[] = [];
const createdPosts: string[] = [];
const createdChats: string[] = [];
const createdBlocks: string[] = [];
const createdMessages: string[] = [];
let userId: string;
let dmRecipientId: string;
let npcUserId: string;
let liveFeedPostId: string;
let deletedFeedPostId: string;
let groupId: string;
let chatId: string;
let dmChatId: string;
let npcDmChatId: string;
let dmGroupChatId: string;

async function makeDmChat(
  isGroup: boolean,
  members: string[]
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(chats).values({
    id,
    isGroup,
    updatedAt: new Date(),
  });
  createdChats.push(id);
  for (const memberId of members) {
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId: id,
      userId: memberId,
    });
  }
  return id;
}

function sendAs(senderId: string, targetChatId: string) {
  return FeedAgentExecutor.executeDirectly(
    'messaging.send_message',
    { chatId: targetChatId, content: 'hello' } as Record<string, JsonValue>,
    senderId
  );
}

function run(operation: string, params: Record<string, JsonValue> = {}) {
  return FeedAgentExecutor.executeDirectly(operation, params, userId);
}

describe('FeedAgentExecutor policies', () => {
  beforeAll(async () => {
    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      username: `exec_${userId.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    });
    createdUsers.push(userId);

    // Newest posts in the table so they land in the first feed page.
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    liveFeedPostId = await generateSnowflakeId();
    deletedFeedPostId = await generateSnowflakeId();
    await db.insert(posts).values([
      {
        id: liveFeedPostId,
        content: 'live post',
        authorId: userId,
        timestamp: new Date(future),
      },
      {
        id: deletedFeedPostId,
        content: 'deleted post',
        authorId: userId,
        timestamp: new Date(future + 1000),
        deletedAt: new Date(),
      },
    ]);
    createdPosts.push(liveFeedPostId, deletedFeedPostId);

    groupId = await generateSnowflakeId();
    chatId = await generateSnowflakeId();
    await db.insert(groups).values({
      id: groupId,
      name: 'executor test group',
      type: 'user',
      ownerId: 'someone-else',
      createdById: 'someone-else',
      updatedAt: new Date(),
    });
    await db.insert(chats).values({
      id: chatId,
      isGroup: true,
      groupId,
      updatedAt: new Date(),
    });
    await db.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId,
      userId,
      role: 'member',
    });
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId,
      userId,
    });

    // DM fixtures for the send_message policy tests below.
    dmRecipientId = await generateSnowflakeId();
    npcUserId = await generateSnowflakeId();
    for (const [id, isActor] of [
      [dmRecipientId, false],
      [npcUserId, true],
    ] as const) {
      await db.insert(users).values({
        id,
        username: `exec_dm_${id.slice(-10)}`,
        isActor,
        updatedAt: new Date(),
      });
      createdUsers.push(id);
    }
    dmChatId = await makeDmChat(false, [userId, dmRecipientId]);
    npcDmChatId = await makeDmChat(false, [userId, npcUserId]);
    dmGroupChatId = await makeDmChat(true, [userId, dmRecipientId]);
  });

  afterAll(async () => {
    await db.delete(comments).where(inArray(comments.postId, createdPosts));
    await db.delete(posts).where(inArray(posts.id, createdPosts));
    await db.delete(messages).where(inArray(messages.id, createdMessages));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await db.delete(chats).where(eq(chats.id, chatId));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, createdChats));
    await db.delete(chats).where(inArray(chats.id, createdChats));
    await db.delete(userBlocks).where(inArray(userBlocks.id, createdBlocks));
    await db.delete(users).where(inArray(users.id, createdUsers));
  });

  it('social.get_feed excludes deleted posts', async () => {
    const result = (await run('social.get_feed', { limit: 5 })) as {
      posts: Array<{ id: string }>;
    };
    const ids = result.posts.map((p) => p.id);
    expect(ids).toContain(liveFeedPostId);
    expect(ids).not.toContain(deletedFeedPostId);
  });

  it('rejects comments over the shared 2000 character limit', async () => {
    await expect(
      run('social.create_comment', {
        postId: liveFeedPostId,
        content: 'a'.repeat(2001),
      })
    ).rejects.toThrow('exceeds maximum length (2000');
  });

  it('rejects content that is empty after removing control characters', async () => {
    await expect(
      run('social.create_comment', {
        postId: liveFeedPostId,
        content: '\u0001\u0002\u0003',
      })
    ).rejects.toThrow('content cannot be empty');
  });

  it('validates profile updates with the shared schema', async () => {
    await expect(
      run('users.update_profile', { username: 'no spaces allowed' })
    ).rejects.toThrow('Invalid profile update');
    await expect(
      run('users.update_profile', { profileImageUrl: 'javascript:alert(1)' })
    ).rejects.toThrow('Invalid profile update');

    const ok = (await run('users.update_profile', {
      displayName: '  Exec Tester  ',
    })) as { user: { displayName: string } };
    expect(ok.user.displayName).toBe('Exec Tester');
  });

  it('rejects a DM when the recipient blocked the sender', async () => {
    const blockId = await generateSnowflakeId();
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: dmRecipientId,
      blockedId: userId,
    });
    createdBlocks.push(blockId);
    await expect(sendAs(userId, dmChatId)).rejects.toThrow(
      'Cannot send messages to this user'
    );
    await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
  });

  it('rejects a DM when the sender blocked the recipient', async () => {
    const blockId = await generateSnowflakeId();
    await db.insert(userBlocks).values({
      id: blockId,
      blockerId: userId,
      blockedId: dmRecipientId,
    });
    createdBlocks.push(blockId);
    await expect(sendAs(userId, dmChatId)).rejects.toThrow(
      'Cannot send messages to this user'
    );
    await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
  });

  it('rejects a DM to an NPC actor', async () => {
    await expect(sendAs(userId, npcDmChatId)).rejects.toThrow(
      'Cannot send direct messages to NPC actors'
    );
  });

  it('still allows an unblocked DM and group messages', async () => {
    const dm = (await sendAs(userId, dmChatId)) as {
      message: { id: string };
    };
    createdMessages.push(dm.message.id);
    expect(dm.message.id).toBeTruthy();
    const group = (await sendAs(userId, dmGroupChatId)) as {
      message: { id: string };
    };
    createdMessages.push(group.message.id);
    expect(group.message.id).toBeTruthy();
  });

  it('leaving a group chat also deactivates group membership', async () => {
    await run('messaging.leave_chat', { chatId });
    const [membership] = await db
      .select({ isActive: groupMembers.isActive })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    expect(membership?.isActive).toBe(false);
  });
});
