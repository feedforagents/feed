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
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f11r2
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f11r2
 *   TZ=UTC bun test integration/mcp-favorite-posts-viewer-moderation.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  closeDatabase,
  db,
  favorites,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetFavoritePosts } from '../../mcp/src/handlers/tool-handlers';

const VIEWER = 'f11-viewer';
const STRANGER = 'f11-stranger';
const AUTH_BLOCKED = 'f11-author-blocked';
const AUTH_MUTED = 'f11-author-muted';
const AUTH_BLOCKER = 'f11-author-blocker';
const AUTH_OK = 'f11-author-ok';

const postIds: string[] = [];
const favoriteIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];

async function insertUser(id: string) {
  await db.insert(users).values({
    id,
    username: id.replace(/[^a-z0-9-]/g, ''),
    displayName: id,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertPost(authorId: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    content: `f11 post by ${authorId}`,
    authorId,
    timestamp: new Date(Date.now() - 60_000),
  });
  postIds.push(id);
  return id;
}

async function insertFavorite(userId: string, targetUserId: string) {
  const id = await generateSnowflakeId();
  await db.insert(favorites).values({
    id,
    userId,
    targetUserId,
    createdAt: new Date(),
  });
  favoriteIds.push(id);
}

async function insertBlock(blockerId: string, blockedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
    createdAt: new Date(),
  });
  blockIds.push(id);
}

async function insertMute(muterId: string, mutedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userMutes).values({
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
    for (const author of [AUTH_BLOCKED, AUTH_MUTED, AUTH_BLOCKER, AUTH_OK]) {
      await insertFavorite(VIEWER, author);
      await insertFavorite(STRANGER, author);
      await insertPost(author);
    }
    // Viewer blocked AUTH_BLOCKED, muted AUTH_MUTED, is blocked by AUTH_BLOCKER.
    await insertBlock(VIEWER, AUTH_BLOCKED);
    await insertMute(VIEWER, AUTH_MUTED);
    await insertBlock(AUTH_BLOCKER, VIEWER);
  });

  afterAll(async () => {
    await db.delete(posts).where(inArray(posts.id, postIds));
    await db.delete(favorites).where(inArray(favorites.id, favoriteIds));
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db.delete(userMutes).where(inArray(userMutes.id, muteIds));
    await db
      .delete(users)
      .where(
        inArray(users.id, [
          VIEWER,
          STRANGER,
          AUTH_BLOCKED,
          AUTH_MUTED,
          AUTH_BLOCKER,
          AUTH_OK,
        ])
      );
    await closeDatabase();
  });

  it('excludes posts by blocked, muted, and blocking authors for the viewer', async () => {
    const result = await executeGetFavoritePosts(
      { agentId: 'agent', userId: VIEWER },
      { limit: 20 }
    );
    const authorIds = result.posts.map((p) => p.authorId);
    expect(authorIds).toEqual([AUTH_OK]);
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
});
