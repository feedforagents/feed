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
  posts,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';

const createdUsers: string[] = [];
const createdPosts: string[] = [];
let userId: string;
let blockedByUserId: string;
let blockerOfUserId: string;
let blockedByPostId: string;
let blockerOfPostId: string;
let cleanCommentPostId: string;
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

    // Users and posts for the social.create_comment block check: one post
    // author blocked by the executor user, one who blocked the executor
    // user, and one with no block either way.
    for (const slot of ['blockedBy', 'blockerOf', 'clean'] as const) {
      const id = await generateSnowflakeId();
      await db.insert(users).values({
        id,
        username: `exec_comment_${slot}_${id.slice(-10)}`,
        isActor: false,
        updatedAt: new Date(),
      });
      createdUsers.push(id);
      const slotPostId = await generateSnowflakeId();
      await db.insert(posts).values({
        id: slotPostId,
        content: `${slot} post`,
        authorId: id,
        timestamp: new Date(future),
      });
      createdPosts.push(slotPostId);
      if (slot === 'blockedBy') {
        blockedByUserId = id;
        blockedByPostId = slotPostId;
      }
      if (slot === 'blockerOf') {
        blockerOfUserId = id;
        blockerOfPostId = slotPostId;
      }
      if (slot === 'clean') cleanCommentPostId = slotPostId;
    }
    await db.insert(userBlocks).values([
      {
        id: await generateSnowflakeId(),
        blockerId: userId,
        blockedId: blockedByUserId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: blockerOfUserId,
        blockedId: userId,
      },
    ]);

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
  });

  afterAll(async () => {
    await db.delete(comments).where(inArray(comments.postId, createdPosts));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockerId, createdUsers));
    await db
      .delete(userBlocks)
      .where(inArray(userBlocks.blockedId, createdUsers));
    await db.delete(posts).where(inArray(posts.id, createdPosts));
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

  it('rejects social.create_comment in either block direction', async () => {
    await expect(
      run('social.create_comment', {
        postId: blockedByPostId,
        content: 'hello',
      })
    ).rejects.toThrow('Cannot comment on this post');
    await expect(
      run('social.create_comment', {
        postId: blockerOfPostId,
        content: 'hello',
      })
    ).rejects.toThrow('Cannot comment on this post');

    const blockedRows = await db
      .select({ id: comments.id })
      .from(comments)
      .where(inArray(comments.postId, [blockedByPostId, blockerOfPostId]));
    expect(blockedRows).toHaveLength(0);

    const ok = (await run('social.create_comment', {
      postId: cleanCommentPostId,
      content: 'hello',
    })) as { success: boolean };
    expect(ok.success).toBe(true);
    const cleanRows = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.postId, cleanCommentPostId));
    expect(cleanRows).toHaveLength(1);
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

  it('leaving a group chat also deactivates group membership', async () => {
    await run('messaging.leave_chat', { chatId });
    const [membership] = await db
      .select({ isActive: groupMembers.isActive })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    expect(membership?.isActive).toBe(false);
  });
});
