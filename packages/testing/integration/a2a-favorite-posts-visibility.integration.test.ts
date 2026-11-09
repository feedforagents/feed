/**
 * favorites.posts (A2A) against a real database: the posts an agent reads
 * from the profiles it favorited must obey the same visibility rules as
 * every other post list.
 *
 * The canonical post query (DatabaseService.getRecentPosts) excludes, in
 * SQL before paginating: soft-deleted posts, future-dated (not yet
 * published) posts — `timestamp <= now` — and test authors (the isTest
 * flag or a 'test-' id prefix). The web favorites feed
 * (GET /api/posts/feed/favorites) applies the same future/deleted rules
 * and states "Favorites never bypass the viewer's block/mute policy",
 * filtering the favorited authors by the viewer's block/mute sets before
 * querying. The A2A executor's getFavoritePosts applied only the deleted
 * rule, so an agent received favorited authors' scheduled posts with
 * their full content, test-account posts, and posts from authors the
 * viewer has blocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, favorites, inArray, posts, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type FavoritePostsResult = {
  posts: Array<{ id: string; authorId: string }>;
};

let viewerId: string;
let normalAuthorId: string;
let testFlagAuthorId: string;
let testPrefixAuthorId: string;
let blockedAuthorId: string;

let visiblePostId: string;
let futurePostId: string;
let deletedPostId: string;
let testFlagPostId: string;
let testPrefixPostId: string;
let blockedPostId: string;

const allUserIds: string[] = [];
const allPostIds: string[] = [];

async function fetchFavoritePosts() {
  const result = (await FeedAgentExecutor.executeDirectly(
    'favorites.posts',
    { limit: 20 },
    viewerId
  )) as unknown as FavoritePostsResult;
  return result.posts.map((p) => p.id);
}

beforeAll(async () => {
  viewerId = await generateSnowflakeId();
  normalAuthorId = await generateSnowflakeId();
  testFlagAuthorId = await generateSnowflakeId();
  testPrefixAuthorId = `test-f99-${await generateSnowflakeId()}`;
  blockedAuthorId = await generateSnowflakeId();

  visiblePostId = await generateSnowflakeId();
  futurePostId = await generateSnowflakeId();
  deletedPostId = await generateSnowflakeId();
  testFlagPostId = await generateSnowflakeId();
  testPrefixPostId = await generateSnowflakeId();
  blockedPostId = await generateSnowflakeId();

  allUserIds.push(
    viewerId,
    normalAuthorId,
    testFlagAuthorId,
    testPrefixAuthorId,
    blockedAuthorId
  );
  allPostIds.push(
    visiblePostId,
    futurePostId,
    deletedPostId,
    testFlagPostId,
    testPrefixPostId,
    blockedPostId
  );

  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f99-viewer-${viewerId}`,
      displayName: 'F99 Viewer',
      updatedAt: now,
    },
    {
      id: normalAuthorId,
      username: `f99-normal-${normalAuthorId}`,
      displayName: 'F99 Normal Author',
      updatedAt: now,
    },
    {
      id: testFlagAuthorId,
      username: `f99-testflag-${testFlagAuthorId}`,
      displayName: 'F99 Test Flag Author',
      isTest: true,
      updatedAt: now,
    },
    {
      id: testPrefixAuthorId,
      username: `f99-testprefix-${testPrefixAuthorId}`,
      displayName: 'F99 Test Prefix Author',
      updatedAt: now,
    },
    {
      id: blockedAuthorId,
      username: `f99-blocked-${blockedAuthorId}`,
      displayName: 'F99 Blocked Author',
      updatedAt: now,
    },
  ]);

  // The viewer favorited all four authors, then blocked one of them.
  const favIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.insert(favorites).values([
    { id: favIds[0], userId: viewerId, targetUserId: normalAuthorId },
    { id: favIds[1], userId: viewerId, targetUserId: testFlagAuthorId },
    { id: favIds[2], userId: viewerId, targetUserId: testPrefixAuthorId },
    { id: favIds[3], userId: viewerId, targetUserId: blockedAuthorId },
  ]);
  await db
    .insert(userBlocks)
    .values([
      { id: favIds[4], blockerId: viewerId, blockedId: blockedAuthorId },
    ]);

  await db.insert(posts).values([
    {
      id: visiblePostId,
      content: 'F99 visible post from a favorited author',
      authorId: normalAuthorId,
      timestamp: hoursAgo(2),
      createdAt: hoursAgo(2),
      type: 'post',
    },
    {
      id: futurePostId,
      content: 'F99 scheduled post that must not be readable yet',
      authorId: normalAuthorId,
      timestamp: new Date(now.getTime() + 24 * 3_600_000),
      createdAt: now,
      type: 'post',
    },
    {
      id: deletedPostId,
      content: 'F99 deleted post',
      authorId: normalAuthorId,
      timestamp: hoursAgo(3),
      createdAt: hoursAgo(3),
      type: 'post',
      deletedAt: now,
    },
    {
      id: testFlagPostId,
      content: 'F99 post by an isTest-flagged author',
      authorId: testFlagAuthorId,
      timestamp: hoursAgo(1),
      createdAt: hoursAgo(1),
      type: 'post',
    },
    {
      id: testPrefixPostId,
      content: 'F99 post by a test- prefixed author',
      authorId: testPrefixAuthorId,
      timestamp: hoursAgo(1),
      createdAt: hoursAgo(1),
      type: 'post',
    },
    {
      id: blockedPostId,
      content: 'F99 post by an author the viewer blocked',
      authorId: blockedAuthorId,
      timestamp: hoursAgo(1),
      createdAt: hoursAgo(1),
      type: 'post',
    },
  ]);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(favorites).where(inArray(favorites.userId, [viewerId]));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, [viewerId]));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('A2A favorites.posts visibility', () => {
  it('premise: the viewer favorited all four authors and all six posts exist', async () => {
    const favRows = await db
      .select()
      .from(favorites)
      .where(inArray(favorites.userId, [viewerId]));
    expect(favRows).toHaveLength(4);
    const postRows = await db
      .select()
      .from(posts)
      .where(inArray(posts.id, allPostIds));
    expect(postRows).toHaveLength(6);
  });

  it('shows the published post and hides the same author’s future and deleted posts', async () => {
    const ids = await fetchFavoritePosts();
    expect(ids).toContain(visiblePostId);
    expect(ids).not.toContain(futurePostId);
    expect(ids).not.toContain(deletedPostId);
  });

  it('excludes test authors (isTest flag and test- id prefix)', async () => {
    const ids = await fetchFavoritePosts();
    expect(ids).not.toContain(testFlagPostId);
    expect(ids).not.toContain(testPrefixPostId);
  });

  it('excludes authors the viewer has blocked', async () => {
    const ids = await fetchFavoritePosts();
    expect(ids).not.toContain(blockedPostId);
  });
});
