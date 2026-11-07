/**
 * favorites.posts against a real database: the A2A favorites feed must
 * apply the same visibility rules as the web favorites feed.
 *
 * The web favorites feed (GET /api/posts/feed/favorites) states both
 * rules in code: "Favorites never bypass the viewer's block/mute policy"
 * (it drops favorited authors the viewer blocked or muted, and authors
 * who blocked the viewer, via the shared @feed/db moderation sets) and
 * "Only show posts up to current time (prevent future access)" (it
 * filters posts with deletedAt IS NULL and timestamp <= now). The A2A
 * executor's getFavoritePosts filtered only deletedAt, so an agent
 * reading a user's favorites feed received favorited authors'
 * future-dated (scheduled, unpublished) posts in full, and posts by
 * authors the viewer can no longer see on the web feed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  favorites,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../feed-executor';

type FavoritePostsResult = {
  posts: Array<{ id: string; content: string; authorId: string }>;
};

let viewerId: string;
let normalAuthorId: string;
let futureAuthorId: string;
let mutedAuthorId: string;
let blockedAuthorId: string;
let blockingAuthorId: string;
let deletedAuthorId: string;

let visiblePostId: string;
let futurePostId: string;
let mutedPostId: string;
let blockedPostId: string;
let blockingPostId: string;
let deletedPostId: string;

const allUserIds: string[] = [];
const allPostIds: string[] = [];

async function fetchFavoritePosts() {
  const result = (await FeedAgentExecutor.executeDirectly(
    'favorites.posts',
    { limit: 50 },
    viewerId
  )) as unknown as FavoritePostsResult;
  return result.posts;
}

beforeAll(async () => {
  [
    viewerId,
    normalAuthorId,
    futureAuthorId,
    mutedAuthorId,
    blockedAuthorId,
    blockingAuthorId,
    deletedAuthorId,
  ] = await Promise.all(Array.from({ length: 7 }, () => generateSnowflakeId()));
  allUserIds.push(
    viewerId,
    normalAuthorId,
    futureAuthorId,
    mutedAuthorId,
    blockedAuthorId,
    blockingAuthorId,
    deletedAuthorId
  );

  const now = new Date();
  const authorRows = [
    [normalAuthorId, 'normal'],
    [futureAuthorId, 'future'],
    [mutedAuthorId, 'muted'],
    [blockedAuthorId, 'blocked'],
    [blockingAuthorId, 'blocking'],
    [deletedAuthorId, 'deleted'],
  ] as const;
  await db.insert(users).values([
    {
      id: viewerId,
      username: `test-f16-viewer-${viewerId}`,
      displayName: 'F16 Viewer',
      reputationPoints: 0,
      updatedAt: now,
    },
    ...authorRows.map(([id, label]) => ({
      id,
      username: `test-f16-${label}-${id}`,
      displayName: `F16 ${label} author`,
      reputationPoints: 0,
      updatedAt: now,
    })),
  ]);

  // The viewer favorites every author.
  await db.insert(favorites).values(
    authorRows.map(([targetUserId]) => ({
      id: `fav-${viewerId}-${targetUserId}`,
      userId: viewerId,
      targetUserId,
    }))
  );

  // The viewer muted one author, blocked one, and is blocked by one.
  await db
    .insert(userMutes)
    .values([
      { id: `mute-${viewerId}`, muterId: viewerId, mutedId: mutedAuthorId },
    ]);
  await db.insert(userBlocks).values([
    {
      id: `block-${viewerId}`,
      blockerId: viewerId,
      blockedId: blockedAuthorId,
    },
    {
      id: `blockby-${viewerId}`,
      blockerId: blockingAuthorId,
      blockedId: viewerId,
    },
  ]);

  const past = new Date(now.getTime() - 60 * 60 * 1000);
  const future = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  [
    visiblePostId,
    futurePostId,
    mutedPostId,
    blockedPostId,
    blockingPostId,
    deletedPostId,
  ] = await Promise.all(Array.from({ length: 6 }, () => generateSnowflakeId()));
  allPostIds.push(
    visiblePostId,
    futurePostId,
    mutedPostId,
    blockedPostId,
    blockingPostId,
    deletedPostId
  );
  await db.insert(posts).values([
    {
      id: visiblePostId,
      authorId: normalAuthorId,
      content: 'f16 visible post',
      timestamp: past,
      type: 'post',
    },
    {
      id: futurePostId,
      authorId: futureAuthorId,
      content: 'f16 future scheduled post',
      timestamp: future,
      type: 'post',
    },
    {
      id: mutedPostId,
      authorId: mutedAuthorId,
      content: 'f16 muted author post',
      timestamp: past,
      type: 'post',
    },
    {
      id: blockedPostId,
      authorId: blockedAuthorId,
      content: 'f16 blocked author post',
      timestamp: past,
      type: 'post',
    },
    {
      id: blockingPostId,
      authorId: blockingAuthorId,
      content: 'f16 blocking author post',
      timestamp: past,
      type: 'post',
    },
    {
      id: deletedPostId,
      authorId: deletedAuthorId,
      content: 'f16 soft deleted post',
      timestamp: past,
      type: 'post',
      deletedAt: past,
    },
  ]);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(favorites).where(inArray(favorites.userId, [viewerId]));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userBlocks).where(inArray(userBlocks.blockedId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('A2A favorites.posts visibility rules', () => {
  it('does not return future-dated (unpublished) posts', async () => {
    const result = await fetchFavoritePosts();
    const ids = result.map((p) => p.id);
    expect(ids).toContain(visiblePostId);
    expect(ids).not.toContain(futurePostId);
  });

  it('does not return posts by blocked, muted, or blocking authors', async () => {
    const result = await fetchFavoritePosts();
    const ids = result.map((p) => p.id);
    expect(ids).not.toContain(mutedPostId);
    expect(ids).not.toContain(blockedPostId);
    expect(ids).not.toContain(blockingPostId);
    expect(ids).not.toContain(deletedPostId);
    expect(ids).toEqual([visiblePostId]);
  });
});
