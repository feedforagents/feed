/**
 * PRD §8.1: per-account rate limits apply across all clients and the web.
 * The website caps likes, shares, follows and chat messages with
 * RATE_LIMIT_CONFIGS (LIKE_POST, LIKE_COMMENT, SHARE_POST, FOLLOW_USER,
 * UNFOLLOW_USER, SEND_MESSAGE); the A2A operations for the same actions must
 * apply the same per-account limits.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  chatParticipants,
  chats,
  comments,
  db,
  follows,
  inArray,
  messages,
  notifications,
  or,
  posts,
  reactions,
  shares,
  users,
} from '@feed/db';
import { RATE_LIMIT_CONFIGS } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

const userIds: string[] = [];
const chatIds: string[] = [];
let authorId: string;

async function createUser() {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `a2a_rl_${id.slice(-10)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function createPosts(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await generateSnowflakeId();
    await db.insert(posts).values({
      id,
      content: `a2a social rate limit post ${i}`,
      authorId,
      timestamp: new Date(Date.now() - 60_000),
    });
    ids.push(id);
  }
  return ids;
}

async function createComments(postId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await generateSnowflakeId();
    await db.insert(comments).values({
      id,
      content: `a2a social rate limit comment ${i}`,
      postId,
      authorId,
      updatedAt: new Date(),
    });
    ids.push(id);
  }
  return ids;
}

/** Calls `operation` once per argument set; the last call must be refused. */
async function expectLimitAt(
  agentUserId: string,
  operation: string,
  argSets: Record<string, string>[],
  maxRequests: number
) {
  expect(argSets).toHaveLength(maxRequests + 1);
  for (const args of argSets.slice(0, maxRequests)) {
    await FeedAgentExecutor.executeDirectly(operation, args, agentUserId);
  }
  await assert.rejects(
    FeedAgentExecutor.executeDirectly(
      operation,
      argSets[maxRequests] as Record<string, string>,
      agentUserId
    ),
    /Rate limit exceeded/
  );
}

beforeAll(async () => {
  authorId = await createUser();
});

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.chatId, chatIds));
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, chatIds));
  await db.delete(chats).where(inArray(chats.id, chatIds));
  await db
    .delete(notifications)
    .where(
      or(
        inArray(notifications.userId, userIds),
        inArray(notifications.actorId, userIds)
      )
    );
  await db.delete(reactions).where(inArray(reactions.userId, userIds));
  await db.delete(shares).where(inArray(shares.userId, userIds));
  await db.delete(comments).where(inArray(comments.authorId, userIds));
  await db
    .delete(follows)
    .where(
      or(
        inArray(follows.followerId, userIds),
        inArray(follows.followingId, userIds)
      )
    );
  await db.delete(posts).where(inArray(posts.authorId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

test('social.like_post stops at the website post like limit', async () => {
  const agentUserId = await createUser();
  const { maxRequests } = RATE_LIMIT_CONFIGS.LIKE_POST;
  const ids = await createPosts(maxRequests + 1);
  const argSets = ids.map((postId) => ({ postId }));
  await expectLimitAt(agentUserId, 'social.like_post', argSets, maxRequests);
});

test('social.like_comment stops at the website comment like limit', async () => {
  const agentUserId = await createUser();
  const [postId] = await createPosts(1);
  const { maxRequests } = RATE_LIMIT_CONFIGS.LIKE_COMMENT;
  const ids = await createComments(postId as string, maxRequests + 1);
  const argSets = ids.map((commentId) => ({ commentId }));
  await expectLimitAt(agentUserId, 'social.like_comment', argSets, maxRequests);
});

test('social.share_post stops at the website share limit', async () => {
  const agentUserId = await createUser();
  const { maxRequests } = RATE_LIMIT_CONFIGS.SHARE_POST;
  const ids = await createPosts(maxRequests + 1);
  const argSets = ids.map((postId) => ({ postId }));
  await expectLimitAt(agentUserId, 'social.share_post', argSets, maxRequests);
});

test('users.follow stops at the website follow limit', async () => {
  const agentUserId = await createUser();
  const { maxRequests } = RATE_LIMIT_CONFIGS.FOLLOW_USER;
  const targets: string[] = [];
  for (let i = 0; i <= maxRequests; i++) targets.push(await createUser());
  const argSets = targets.map((userId) => ({ userId }));
  await expectLimitAt(agentUserId, 'users.follow', argSets, maxRequests);
});

test('users.unfollow stops at the website unfollow limit', async () => {
  const agentUserId = await createUser();
  const { maxRequests } = RATE_LIMIT_CONFIGS.UNFOLLOW_USER;
  const targets: string[] = [];
  for (let i = 0; i <= maxRequests; i++) {
    const target = await createUser();
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: agentUserId,
      followingId: target,
    });
    targets.push(target);
  }
  const argSets = targets.map((userId) => ({ userId }));
  await expectLimitAt(agentUserId, 'users.unfollow', argSets, maxRequests);
});

test('messaging.send_message stops at the website message limit', async () => {
  const agentUserId = await createUser();
  const chatId = await generateSnowflakeId();
  await db
    .insert(chats)
    .values({ id: chatId, isGroup: true, updatedAt: new Date() });
  chatIds.push(chatId);
  await db.insert(chatParticipants).values({
    id: `${chatId}:${agentUserId}`,
    chatId,
    userId: agentUserId,
  });
  const { maxRequests } = RATE_LIMIT_CONFIGS.SEND_MESSAGE;
  const argSets = Array.from({ length: maxRequests + 1 }, (_, i) => ({
    chatId,
    content: `agent message ${i}`,
  }));
  await expectLimitAt(
    agentUserId,
    'messaging.send_message',
    argSets,
    maxRequests
  );
});
