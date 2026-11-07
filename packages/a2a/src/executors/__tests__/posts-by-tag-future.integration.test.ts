/**
 * stats.posts_by_tag against a real database: the A2A posts-by-tag
 * lookup must apply the same time rule as the web tag surface.
 *
 * The web surface for a tag (GET /api/trending/[tag], backed by the
 * engine's getPostsByTag) states the rule in code: "Deleted and
 * future-dated posts are excluded from both the page and the total so
 * pagination and counts agree", filtering posts with deletedAt IS NULL
 * and timestamp <= now. The API-wide time-filtering test bundle states
 * the same rule: "APIs should not expose future posts or events." The
 * A2A executor's getPostsByTag filtered only deletedAt, so an agent
 * asking for a tag's posts received future-dated (scheduled,
 * unpublished) posts in full before their publication time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../feed-executor';

type PostsByTagResult = {
  posts: Array<{ id: string; content: string; authorId: string }>;
};

let authorId: string;
let tagId: string;
let tagName: string;

let pastPostId: string;
let futurePostId: string;
let deletedPostId: string;
let untaggedPostId: string;

const allPostIds: string[] = [];

async function fetchPostsByTag() {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.posts_by_tag',
    { tag: tagName, limit: 50, offset: 0 },
    authorId
  )) as unknown as PostsByTagResult;
  return result.posts;
}

beforeAll(async () => {
  [authorId, tagId, pastPostId, futurePostId, deletedPostId, untaggedPostId] =
    await Promise.all(Array.from({ length: 6 }, () => generateSnowflakeId()));
  allPostIds.push(pastPostId, futurePostId, deletedPostId, untaggedPostId);
  tagName = `f18tag${tagId}`;

  const now = new Date();
  await db.insert(users).values([
    {
      id: authorId,
      username: `test-f18-author-${authorId}`,
      displayName: 'F18 Author',
      reputationPoints: 0,
      updatedAt: now,
    },
  ]);

  await db.insert(tags).values([
    {
      id: tagId,
      name: tagName,
      displayName: 'F18 Tag',
      updatedAt: now,
    },
  ]);

  const past = new Date(now.getTime() - 60 * 60 * 1000);
  const future = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  await db.insert(posts).values([
    {
      id: pastPostId,
      authorId,
      content: 'f18 past post',
      timestamp: past,
      type: 'post',
    },
    {
      id: futurePostId,
      authorId,
      content: 'f18 future scheduled post',
      timestamp: future,
      type: 'post',
    },
    {
      id: deletedPostId,
      authorId,
      content: 'f18 soft deleted post',
      timestamp: past,
      type: 'post',
      deletedAt: past,
    },
    {
      id: untaggedPostId,
      authorId,
      content: 'f18 untagged past post',
      timestamp: past,
      type: 'post',
    },
  ]);

  await db.insert(postTags).values([
    { id: `pt-${pastPostId}`, postId: pastPostId, tagId },
    { id: `pt-${futurePostId}`, postId: futurePostId, tagId },
    { id: `pt-${deletedPostId}`, postId: deletedPostId, tagId },
  ]);
});

afterAll(async () => {
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagId]));
  await db.delete(users).where(inArray(users.id, [authorId]));
});

describe('A2A stats.posts_by_tag future-post rule', () => {
  it('returns the visible past post and excludes the soft-deleted one', async () => {
    const result = await fetchPostsByTag();
    const ids = result.map((p) => p.id);
    expect(ids).toContain(pastPostId);
    expect(ids).not.toContain(deletedPostId);
    expect(ids).not.toContain(untaggedPostId);
  });

  it('does not return future-dated (unpublished) posts', async () => {
    const result = await fetchPostsByTag();
    const ids = result.map((p) => p.id);
    expect(ids).not.toContain(futurePostId);
    expect(result.map((p) => p.content)).not.toContain(
      'f18 future scheduled post'
    );
    expect(ids).toEqual([pastPostId]);
  });
});
