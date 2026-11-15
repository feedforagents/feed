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
import {
  db,
  eq,
  favorites,
  gameOnboarding,
  inArray,
  posts,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetFavoritePosts } from '../../mcp/src/handlers/tool-handlers';

let agentUserId: string;
let normalAuthorId: string;
let flaggedAuthorId: string;
let prefixedAuthorId: string;

const HOUR = 3_600_000;
let normalPost1: string;
let normalPost2: string;
let flaggedPost: string;
let prefixedPost: string;
let deletedPost: string;
let futurePost: string;

type OwnedRows = {
  postIds: string[];
  userIds: string[];
  favoriteIds: string[];
};
const owned: OwnedRows = { postIds: [], userIds: [], favoriteIds: [] };
const allPostIds = owned.postIds;

async function insertUser(
  id: string,
  username: string,
  opts: { isTest?: boolean } = {},
  acquired: OwnedRows = owned
) {
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    isTest: opts.isTest ?? false,
    isActor: false,
    updatedAt: new Date(),
  });
  acquired.userIds.push(id);
}

async function insertPost(
  id: string,
  authorId: string,
  content: string,
  timestamp: Date,
  deletedAt: Date | null = null,
  acquired: OwnedRows = owned
) {
  await db.insert(posts).values({
    id,
    authorId,
    content,
    timestamp,
    deletedAt,
  });
  acquired.postIds.push(id);
}

async function insertFavorite(
  userId: string,
  targetUserId: string,
  acquired: OwnedRows = owned,
  id?: string
) {
  const [row] = await db
    .insert(favorites)
    .values({
      id: id ?? (await generateSnowflakeId()),
      userId,
      targetUserId,
    })
    .returning({ id: favorites.id });
  if (!row) throw new Error('Favorite insert returned no ownership');
  acquired.favoriteIds.push(row.id);
  return row.id;
}

/**
 * The five destructive FK paths off users.id: three ON DELETE CASCADE
 * (GameOnboarding.userId, UserPnLSnapshot.userId, Whitelist.userId) and
 * two ON DELETE SET NULL (Whitelist.grantedBy, WhitelistConfig.updatedBy).
 * Deleting a fixture user while any of them references it would silently
 * destroy or null another owner's row, so cleanup refuses instead of
 * deleting. The check, the row lock, and the delete run in one short
 * transaction so the decision and the deletion cannot drift apart.
 */
async function cleanup(acquired: OwnedRows) {
  await db.transaction(async (tx) => {
    if (acquired.userIds.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, acquired.userIds))
        .for('update');
      const [onboarding, snapshots, whitelistRows, grantedRows, configRows] =
        await Promise.all([
          tx
            .select({ id: gameOnboarding.id })
            .from(gameOnboarding)
            .where(inArray(gameOnboarding.userId, acquired.userIds))
            .limit(1),
          tx
            .select({ id: userPnLSnapshots.id })
            .from(userPnLSnapshots)
            .where(inArray(userPnLSnapshots.userId, acquired.userIds))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.userId, acquired.userIds))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.grantedBy, acquired.userIds))
            .limit(1),
          tx
            .select({ id: whitelistConfig.id })
            .from(whitelistConfig)
            .where(inArray(whitelistConfig.updatedBy, acquired.userIds))
            .limit(1),
        ]);
      if (
        onboarding.length > 0 ||
        snapshots.length > 0 ||
        whitelistRows.length > 0 ||
        grantedRows.length > 0 ||
        configRows.length > 0
      ) {
        throw new Error(
          'cleanup refused: a foreign row still references an owned user'
        );
      }
    }
    if (acquired.favoriteIds.length > 0) {
      await tx
        .delete(favorites)
        .where(inArray(favorites.id, acquired.favoriteIds));
      expect(
        await tx
          .select({ id: favorites.id })
          .from(favorites)
          .where(inArray(favorites.id, acquired.favoriteIds))
      ).toHaveLength(0);
    }
    if (acquired.postIds.length > 0) {
      await tx.delete(posts).where(inArray(posts.id, acquired.postIds));
      expect(
        await tx
          .select({ id: posts.id })
          .from(posts)
          .where(inArray(posts.id, acquired.postIds))
      ).toHaveLength(0);
    }
    if (acquired.userIds.length > 0) {
      await tx.delete(users).where(inArray(users.id, acquired.userIds));
      expect(
        await tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, acquired.userIds))
      ).toHaveLength(0);
    }
  });
}

async function fetchFavoritePosts(limit = 20) {
  const result = await executeGetFavoritePosts(
    { agentId: 'agent', userId: agentUserId } as never,
    { limit, offset: 0 }
  );
  return result.posts;
}

beforeAll(async () => {
  const suffix = await generateSnowflakeId();
  prefixedAuthorId = `test-f98-author-${suffix}`;
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
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  await insertUser(agentUserId, `f98-agent-${suffix}`);
  await insertUser(normalAuthorId, `f98-normal-author-${suffix}`);
  await insertUser(flaggedAuthorId, `f98-flagged-author-${suffix}`, {
    isTest: true,
  });
  await insertUser(prefixedAuthorId, `f98-prefixed-author-${suffix}`);

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
    await insertFavorite(agentUserId, targetUserId);
  }
});

afterAll(() => cleanup(owned));

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

  for (const partialSetup of [false, true]) {
    it(`preserves pre-existing rows after ${partialSetup ? 'partial setup' : 'insert collisions'}`, async () => {
      const existing: OwnedRows = { postIds: [], userIds: [], favoriteIds: [] };
      const attempted: OwnedRows = {
        postIds: [],
        userIds: [],
        favoriteIds: [],
      };
      try {
        const [userId, authorId, postId] = await Promise.all([
          generateSnowflakeId(),
          generateSnowflakeId(),
          generateSnowflakeId(),
        ]);
        await insertUser(userId, `f98-control-${userId}`, {}, existing);
        await insertUser(authorId, `f98-control-${authorId}`, {}, existing);
        await insertPost(
          postId,
          authorId,
          'retained control',
          new Date(),
          null,
          existing
        );
        const favoriteId = await insertFavorite(userId, authorId, existing);
        const readExisting = async () => ({
          users: await db
            .select()
            .from(users)
            .where(inArray(users.id, existing.userIds))
            .orderBy(users.id),
          posts: await db.select().from(posts).where(eq(posts.id, postId)),
          favorites: await db
            .select()
            .from(favorites)
            .where(eq(favorites.id, favoriteId)),
        });
        const before = await readExisting();
        if (partialSetup) {
          const partialUserId = await generateSnowflakeId();
          await insertUser(
            partialUserId,
            `f98-partial-${partialUserId}`,
            {},
            attempted
          );
          await insertPost(
            await generateSnowflakeId(),
            partialUserId,
            'partial setup',
            new Date(),
            null,
            attempted
          );
          await expect(
            insertFavorite(partialUserId, authorId, attempted, favoriteId)
          ).rejects.toMatchObject({ cause: { code: '23505' } });
        } else {
          await expect(
            insertUser(userId, `f98-control-${userId}`, {}, attempted)
          ).rejects.toMatchObject({ cause: { code: '23505' } });
          await expect(
            insertPost(
              postId,
              authorId,
              'collision',
              new Date(),
              null,
              attempted
            )
          ).rejects.toMatchObject({ cause: { code: '23505' } });
          await expect(
            insertFavorite(userId, authorId, attempted, favoriteId)
          ).rejects.toMatchObject({ cause: { code: '23505' } });
        }
        await cleanup(attempted);
        expect(await readExisting()).toEqual(before);
      } finally {
        await cleanup(attempted);
        await cleanup(existing);
      }
    });
  }

  it('refuses cleanup while a foreign onboarding row references an owned user', async () => {
    const foreign: OwnedRows = { postIds: [], userIds: [], favoriteIds: [] };
    const foreignUserId = await generateSnowflakeId();
    const onboardingId = await generateSnowflakeId();
    await insertUser(
      foreignUserId,
      `f98-foreign-${foreignUserId}`,
      {},
      foreign
    );
    await db
      .insert(gameOnboarding)
      .values({ id: onboardingId, userId: foreignUserId });
    try {
      await expect(cleanup(foreign)).rejects.toThrow(
        'cleanup refused: a foreign row still references an owned user'
      );
      // Nothing was deleted: the foreign onboarding row and its user survive.
      expect(
        await db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, onboardingId))
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, foreignUserId))
      ).toHaveLength(1);
    } finally {
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, onboardingId));
      await cleanup(foreign);
    }
  });
});
