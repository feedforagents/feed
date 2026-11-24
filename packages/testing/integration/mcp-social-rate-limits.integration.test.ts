/**
 * PRD §8.1: per-account rate limits apply across all clients and the web.
 * The website caps likes and follows with RATE_LIMIT_CONFIGS (LIKE_POST,
 * LIKE_COMMENT, FOLLOW_USER, UNFOLLOW_USER); the MCP tools for the same
 * actions must apply the same per-account limits.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  comments,
  db,
  follows,
  inArray,
  notifications,
  or,
  posts,
  reactions,
  users,
} from '@feed/db';
import { RATE_LIMIT_CONFIGS } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { executeTool } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];
const postIds: string[] = [];
const commentIds: string[] = [];
let authorId: string;

async function createUser(prefix: string) {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `${prefix}-${id}`,
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
      content: `mcp social rate limit post ${i}`,
      authorId,
      timestamp: new Date(),
    });
    ids.push(id);
  }
  postIds.push(...ids);
  return ids;
}

async function createComments(postId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await generateSnowflakeId();
    await db.insert(comments).values({
      id,
      content: `mcp social rate limit comment ${i}`,
      postId,
      authorId,
      updatedAt: new Date(),
    });
    ids.push(id);
  }
  commentIds.push(...ids);
  return ids;
}

/** Calls `tool` once per argument set; the last call must be refused. */
async function expectLimitAt(
  agentUserId: string,
  tool: string,
  argSets: Record<string, string>[],
  maxRequests: number
) {
  expect(argSets).toHaveLength(maxRequests + 1);
  const agent = { agentId: `rate-limit-${tool}`, userId: agentUserId };
  for (const args of argSets.slice(0, maxRequests)) {
    await executeTool(tool, args, agent);
  }
  await assert.rejects(
    executeTool(tool, argSets[maxRequests] as Record<string, string>, agent),
    /Rate limit exceeded/
  );
}

beforeAll(async () => {
  authorId = await createUser('mcp-rl-author');
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(
      or(
        inArray(notifications.userId, userIds),
        inArray(notifications.actorId, userIds)
      )
    );
  await db.delete(reactions).where(inArray(reactions.userId, userIds));
  await db.delete(comments).where(inArray(comments.authorId, userIds));
  await db
    .delete(follows)
    .where(
      or(
        inArray(follows.followerId, userIds),
        inArray(follows.followingId, userIds)
      )
    );
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db.delete(users).where(inArray(users.id, userIds));
});

test('like_post stops at the website post like limit', async () => {
  const agentUserId = await createUser('mcp-rl-liker');
  const { maxRequests } = RATE_LIMIT_CONFIGS.LIKE_POST;
  const ids = await createPosts(maxRequests + 1);
  const argSets = ids.map((postId) => ({ postId }));
  await expectLimitAt(agentUserId, 'like_post', argSets, maxRequests);
});

test('like_comment stops at the website comment like limit', async () => {
  const agentUserId = await createUser('mcp-rl-comment-liker');
  const [postId] = await createPosts(1);
  const { maxRequests } = RATE_LIMIT_CONFIGS.LIKE_COMMENT;
  const ids = await createComments(postId as string, maxRequests + 1);
  const argSets = ids.map((commentId) => ({ commentId }));
  await expectLimitAt(agentUserId, 'like_comment', argSets, maxRequests);
});

test('follow_user stops at the website follow limit', async () => {
  const agentUserId = await createUser('mcp-rl-follower');
  const { maxRequests } = RATE_LIMIT_CONFIGS.FOLLOW_USER;
  const targets: string[] = [];
  for (let i = 0; i <= maxRequests; i++) {
    targets.push(await createUser('mcp-rl-target'));
  }
  const argSets = targets.map((userId) => ({ userId }));
  await expectLimitAt(agentUserId, 'follow_user', argSets, maxRequests);
});

test('unfollow_user stops at the website unfollow limit', async () => {
  const agentUserId = await createUser('mcp-rl-unfollower');
  const { maxRequests } = RATE_LIMIT_CONFIGS.UNFOLLOW_USER;
  const targets: string[] = [];
  for (let i = 0; i <= maxRequests; i++) {
    const target = await createUser('mcp-rl-unfollow-target');
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: agentUserId,
      followingId: target,
    });
    targets.push(target);
  }
  const argSets = targets.map((userId) => ({ userId }));
  await expectLimitAt(agentUserId, 'unfollow_user', argSets, maxRequests);
});
