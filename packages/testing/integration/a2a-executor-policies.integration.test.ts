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
  notifications,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

const createdUsers: string[] = [];
const createdPosts: string[] = [];
const createdNotifications: string[] = [];
let userId: string;
let liveFeedPostId: string;
let deletedFeedPostId: string;
let groupId: string;
let chatId: string;

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

    // One chat notification and one system notification for the
    // get_unread_count test below.
    const chatNotifId = await generateSnowflakeId();
    const systemNotifId = await generateSnowflakeId();
    await db.insert(notifications).values([
      {
        id: chatNotifId,
        userId,
        type: 'message',
        title: 'chat',
        message: 'chat notification',
        chatId: await generateSnowflakeId(),
      },
      {
        id: systemNotifId,
        userId,
        type: 'system',
        title: 'system',
        message: 'system notification',
      },
    ]);
    createdNotifications.push(chatNotifId, systemNotifId);
  });

  afterAll(async () => {
    await db.delete(comments).where(inArray(comments.postId, createdPosts));
    await db.delete(posts).where(inArray(posts.id, createdPosts));
    await db
      .delete(notifications)
      .where(inArray(notifications.id, createdNotifications));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await db.delete(chats).where(eq(chats.id, chatId));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
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

  it('counts all unread notifications, not only chat ones', async () => {
    const result = (await run('messaging.get_unread_count', {})) as {
      unreadCount: number;
    };
    expect(result.unreadCount).toBe(2);
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
