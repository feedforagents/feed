/**
 * MCP get_favorite_posts must apply the viewer's moderation policy to the
 * favorites feed.
 *
 * PRD §8.1: "Same business logic as the website. Tools call the same
 * services REST uses (notifications, repost posts, rate limits,
 * moderation), not raw DB writes." The web favorites feed
 * (GET /api/posts/feed/favorites) says "Favorites never bypass the
 * viewer's block/mute policy" and drops favorited authors the viewer
 * blocked or muted, and authors who blocked the viewer, via
 * loadViewerExcludedAuthorIds (blocked + muted + blocked-by) before
 * paginating. A2A getFavoritePosts applies the same three-set filter
 * with the same comment. MCP executeGetFavoritePosts returns posts
 * from every favorited author with no filter at all, so a blocked
 * author's posts keep reaching the agent's favorites feed even though
 * the website hides them from the same viewer:
 *
 * - web favorites feed excludes the three sets (route.ts:158)
 * - A2A getFavoritePosts excludes the three sets (feed-executor.ts)
 * - MCP query_feed (#1863) and search_agents exclude the three sets
 * - the MCP notification list (#1835) and unread count (#1828) do too
 *
 * Real DB, real handler (executeGetFavoritePosts directly).
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f11r2
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f11r2
 *   TZ=UTC bun test integration/mcp-favorite-posts-viewer-moderation.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  dbWrite,
  eq,
  favorites,
  gameOnboarding,
  inArray,
  posts,
  userApiKeys,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { executeGetFavoritePosts } from '../../mcp/src/handlers/tool-handlers';

const VIEWER = await generateSnowflakeId();
const STRANGER = await generateSnowflakeId();
const AUTH_BLOCKED = await generateSnowflakeId();
const AUTH_MUTED = await generateSnowflakeId();
const AUTH_BLOCKER = await generateSnowflakeId();
const AUTH_OK = await generateSnowflakeId();

const userIds: string[] = [];
const postIds: string[] = [];
const favoriteIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];
let viewerApiKey = '';
let viewerApiKeyId = '';

async function insertUser(id: string) {
  const rows = await dbWrite
    .insert(users)
    .values({
      id,
      username: `f11-${id}`,
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  userIds.push(...rows.map((row) => row.id));
}

async function insertPost(
  authorId: string,
  minutesAgo: number
): Promise<string> {
  const id = await generateSnowflakeId();
  await dbWrite.insert(posts).values({
    id,
    content: `f11 post by ${authorId}`,
    authorId,
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
  });
  postIds.push(id);
  return id;
}

async function insertFavorite(userId: string, targetUserId: string) {
  const id = await generateSnowflakeId();
  await dbWrite.insert(favorites).values({
    id,
    userId,
    targetUserId,
    createdAt: new Date(),
  });
  favoriteIds.push(id);
}

async function insertBlock(blockerId: string, blockedId: string) {
  const id = await generateSnowflakeId();
  await dbWrite.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
    createdAt: new Date(),
  });
  blockIds.push(id);
}

async function insertMute(muterId: string, mutedId: string) {
  const id = await generateSnowflakeId();
  await dbWrite.insert(userMutes).values({
    id,
    muterId,
    mutedId,
    createdAt: new Date(),
  });
  muteIds.push(id);
}

describe('MCP get_favorite_posts viewer moderation', () => {
  beforeAll(async () => {
    for (const id of [
      VIEWER,
      STRANGER,
      AUTH_BLOCKED,
      AUTH_MUTED,
      AUTH_BLOCKER,
      AUTH_OK,
    ]) {
      await insertUser(id);
    }
    // Viewer favorites all four authors; stranger does too (control).
    for (const [index, author] of [
      AUTH_BLOCKED,
      AUTH_MUTED,
      AUTH_BLOCKER,
      AUTH_OK,
    ].entries()) {
      await insertFavorite(VIEWER, author);
      await insertFavorite(STRANGER, author);
      await insertPost(author, index + 1);
    }
    // Viewer blocked AUTH_BLOCKED, muted AUTH_MUTED, is blocked by AUTH_BLOCKER.
    await insertBlock(VIEWER, AUTH_BLOCKED);
    await insertMute(VIEWER, AUTH_MUTED);
    await insertBlock(AUTH_BLOCKER, VIEWER);
    // Per-user API key so the MCP flow over HTTP can authenticate as VIEWER.
    viewerApiKey = generateApiKey();
    viewerApiKeyId = await generateSnowflakeId();
    await dbWrite.insert(userApiKeys).values({
      id: viewerApiKeyId,
      userId: VIEWER,
      keyHash: hashApiKey(viewerApiKey),
      name: 'f11-http',
    });
  });

  afterAll(async () => {
    await dbWrite.delete(posts).where(inArray(posts.id, postIds));
    await dbWrite.delete(favorites).where(inArray(favorites.id, favoriteIds));
    await dbWrite.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await dbWrite.delete(userMutes).where(inArray(userMutes.id, muteIds));
    await dbWrite.delete(userApiKeys).where(eq(userApiKeys.id, viewerApiKeyId));
    // Guard the parent Users delete: remove onboarding rows for the fixture
    // users explicitly instead of relying on the ON DELETE CASCADE.
    await dbWrite
      .delete(gameOnboarding)
      .where(inArray(gameOnboarding.userId, userIds));
    await dbWrite.delete(users).where(inArray(users.id, userIds));
  });

  it('excludes posts by blocked, muted, and blocking authors for the viewer', async () => {
    const result = await executeGetFavoritePosts(
      { agentId: 'agent', userId: VIEWER },
      { limit: 20 }
    );
    const authorIds = result.posts.map((p) => p.authorId);
    expect(authorIds).toEqual([AUTH_OK]);

    const firstPage = await executeGetFavoritePosts(
      { agentId: 'agent', userId: VIEWER },
      { limit: 1 }
    );
    expect(firstPage.posts.map((post) => post.authorId)).toEqual([AUTH_OK]);
  });

  it('shows all favorited authors to an unrelated viewer', async () => {
    const result = await executeGetFavoritePosts(
      { agentId: 'agent', userId: STRANGER },
      { limit: 20 }
    );
    const authorIds = result.posts.map((p) => p.authorId).sort();
    expect(authorIds).toEqual(
      [AUTH_BLOCKED, AUTH_BLOCKER, AUTH_MUTED, AUTH_OK].sort()
    );
  });

  it('returns only the unblocked favorited author over HTTP (POST /api/mcp tools/call)', async () => {
    const { POST } = await import('../../../apps/web/src/app/api/mcp/route');
    const request = new NextRequest('https://feed.example/api/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'get_favorite_posts',
          arguments: { limit: 20 },
        },
        id: 1,
      }),
      headers: {
        'content-type': 'application/json',
        'X-Feed-Api-Key': viewerApiKey,
      },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
    const text = body.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      posts: Array<{ authorId: string }>;
    };
    expect(payload.posts.map((post) => post.authorId)).toEqual([AUTH_OK]);
  });
});
