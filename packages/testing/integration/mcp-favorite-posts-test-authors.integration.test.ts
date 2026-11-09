/**
 * MCP get_favorite_posts against a real database: the tool must apply the
 * web feed's test-author rule.
 *
 * Every post list in the product excludes test authors in SQL before
 * paginating — accounts with the isTest flag and accounts whose id starts
 * with 'test-' (DatabaseService.getRecentPosts: "Exclude test authors in
 * SQL before paginating, so pages are full"). The web favorites feed was
 * aligned to the same rule (#1670), and the A2A/MCP feed tools were
 * aligned for query_feed (#1740). The MCP get_favorite_posts handler is a
 * separate direct Drizzle query that applies neither check, so an agent
 * reading its favorite profiles' posts receives test-account posts in
 * full — with a small limit they fill the whole page.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, favorites, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetFavoritePosts } from '../../mcp/src/handlers/tool-handlers';

let agentUserId: string;
let normalAuthorId: string;
let flaggedAuthorId: string;
const prefixedAuthorId = 'test-f98-author';

const HOUR = 3_600_000;
let normalPost1: string;
let normalPost2: string;
let flaggedPost: string;
let prefixedPost: string;
let deletedPost: string;
let futurePost: string;

const allPostIds: string[] = [];
const allUserIds: string[] = [];

async function insertUser(
  id: string,
  username: string,
  opts: { isTest?: boolean } = {}
) {
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    isTest: opts.isTest ?? false,
    isActor: false,
    updatedAt: new Date(),
  });
  allUserIds.push(id);
}

async function insertPost(
  id: string,
  authorId: string,
  content: string,
  timestamp: Date,
  deletedAt: Date | null = null
) {
  await db.insert(posts).values({
    id,
    authorId,
    content,
    timestamp,
    deletedAt,
    updatedAt: new Date(),
  });
  allPostIds.push(id);
}

async function fetchFavoritePosts(limit = 20) {
  const result = await executeGetFavoritePosts(
    { agentId: 'agent', userId: agentUserId } as never,
    { limit, offset: 0 }
  );
  return result.posts;
}

beforeAll(async () => {
  agentUserId = await generateSnowflakeId();
  normalAuthorId = await generateSnowflakeId();
  flaggedAuthorId = await generateSnowflakeId();
  [
    normalPost1,
    normalPost2,
    flaggedPost,
    prefixedPost,
    deletedPost,
    futurePost,
  ] = await Promise.all(Array.from({ length: 6 }, () => generateSnowflakeId()));

  await insertUser(agentUserId, 'f98-agent');
  await insertUser(normalAuthorId, 'f98-normal-author');
  await insertUser(flaggedAuthorId, 'f98-flagged-author', { isTest: true });
  await insertUser(prefixedAuthorId, 'f98-prefixed-author');

  const now = Date.now();
  await insertPost(
    normalPost1,
    normalAuthorId,
    'normal post older',
    new Date(now - 2 * HOUR)
  );
  await insertPost(
    normalPost2,
    normalAuthorId,
    'normal post newer',
    new Date(now - 1 * HOUR)
  );
  await insertPost(
    flaggedPost,
    flaggedAuthorId,
    'isTest author post',
    new Date(now - 0.5 * HOUR)
  );
  await insertPost(
    prefixedPost,
    prefixedAuthorId,
    'test- prefix author post',
    new Date(now - 0.75 * HOUR)
  );
  await insertPost(
    deletedPost,
    normalAuthorId,
    'deleted normal post',
    new Date(now - 0.25 * HOUR),
    new Date(now - 0.2 * HOUR)
  );
  await insertPost(
    futurePost,
    normalAuthorId,
    'future normal post',
    new Date(now + 1 * HOUR)
  );

  for (const targetUserId of [
    normalAuthorId,
    flaggedAuthorId,
    prefixedAuthorId,
  ]) {
    await db.insert(favorites).values({
      id: await generateSnowflakeId(),
      userId: agentUserId,
      targetUserId,
    });
  }
});

afterAll(async () => {
  await db.delete(favorites).where(inArray(favorites.userId, allUserIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('MCP get_favorite_posts test-author exclusion', () => {
  it('premise: the agent favorited all three authors and their posts exist', async () => {
    const favs = await db
      .select({ targetUserId: favorites.targetUserId })
      .from(favorites)
      .where(inArray(favorites.userId, [agentUserId]));
    expect(favs.map((f) => f.targetUserId).sort()).toEqual(
      [normalAuthorId, flaggedAuthorId, prefixedAuthorId].sort()
    );
    const stored = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.id, allPostIds));
    expect(stored).toHaveLength(6);
  });

  it('returns only the real author\u2019s posts, not test-author posts', async () => {
    const result = await fetchFavoritePosts();
    expect(result.map((p) => p.id).sort()).toEqual(
      [normalPost1, normalPost2].sort()
    );
  });

  it('does not let test posts fill a small page', async () => {
    const page = await fetchFavoritePosts(2);
    expect(page.map((p) => p.id)).toEqual([normalPost2, normalPost1]);
  });
});
