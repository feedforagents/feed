/**
 * stats.posts_by_tag against a real database: the A2A posts-by-tag
 * lookup must apply the same time rule as the web tag surface, and
 * eligibility must be applied BEFORE limit/offset so pages never come
 * back empty while visible posts remain.
 *
 * The web surface for a tag (GET /api/trending/[tag], backed by the
 * engine's getPostsByTag) states the rule in code: "Deleted and
 * future-dated posts are excluded from both the page and the total so
 * pagination and counts agree", filtering posts with deletedAt IS NULL
 * and timestamp <= now. The API-wide time-filtering test bundle states
 * the same rule: "APIs should not expose future posts or events." The
 * A2A executor's getPostsByTag filtered only deletedAt, so an agent
 * asking for a tag's posts received future-dated (scheduled,
 * unpublished) posts in full before their publication time; and it
 * paginated the memberships before filtering, so limit=1 with the
 * newest membership pointing at a future post returned an empty page.
 *
 * Fixture cleanup only deletes rows whose insert actually succeeded:
 * ids are recorded as owned after each insert, so a setup failure does
 * not leave cleanup deleting rows that were never created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type PostsByTagResult = {
  posts: Array<{ id: string; content: string; authorId: string }>;
};

let authorId: string;
let tagId: string;
let tagName: string;

let pastPostId1: string;
let pastPostId2: string;
let pastPostId3: string;
let futurePostId: string;
let deletedPostId: string;
let untaggedPostId: string;

/** Rows owned by this suite: only ids recorded here are deleted. */
const owned = {
  users: [] as string[],
  tags: [] as string[],
  posts: [] as string[],
  postTags: [] as string[],
};

async function fetchPostsByTag(limit = 50, offset = 0, tag = tagName) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'stats.posts_by_tag',
    { tag, limit, offset },
    authorId
  )) as unknown as PostsByTagResult;
  return result.posts;
}

beforeAll(async () => {
  authorId = await generateSnowflakeId();
  tagId = await generateSnowflakeId();
  pastPostId1 = await generateSnowflakeId();
  pastPostId2 = await generateSnowflakeId();
  pastPostId3 = await generateSnowflakeId();
  futurePostId = await generateSnowflakeId();
  deletedPostId = await generateSnowflakeId();
  untaggedPostId = await generateSnowflakeId();
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
  owned.users.push(authorId);

  await db.insert(tags).values([
    {
      id: tagId,
      name: tagName,
      displayName: 'F18 Tag',
      updatedAt: now,
    },
  ]);
  owned.tags.push(tagId);

  const past1 = new Date(now.getTime() - 60 * 60 * 1000);
  const past2 = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const past3 = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  await db.insert(posts).values([
    {
      id: pastPostId1,
      authorId,
      content: 'f18 past post 1',
      timestamp: past1,
      type: 'post',
    },
    {
      id: pastPostId2,
      authorId,
      content: 'f18 past post 2',
      timestamp: past2,
      type: 'post',
    },
    {
      id: pastPostId3,
      authorId,
      content: 'f18 past post 3',
      timestamp: past3,
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
      timestamp: past2,
      type: 'post',
      deletedAt: past2,
    },
    {
      id: untaggedPostId,
      authorId,
      content: 'f18 untagged past post',
      timestamp: past1,
      type: 'post',
    },
  ]);
  owned.posts.push(
    pastPostId1,
    pastPostId2,
    pastPostId3,
    futurePostId,
    deletedPostId,
    untaggedPostId
  );

  // The future post's membership is the newest: the old code paginated
  // memberships first, so limit=1 covered only the future post and the
  // first page came back empty.
  await db.insert(postTags).values([
    {
      id: `pt-${pastPostId1}`,
      postId: pastPostId1,
      tagId,
      createdAt: new Date(now.getTime() - 60 * 1000),
    },
    {
      id: `pt-${pastPostId2}`,
      postId: pastPostId2,
      tagId,
      createdAt: new Date(now.getTime() - 2 * 60 * 1000),
    },
    {
      id: `pt-${pastPostId3}`,
      postId: pastPostId3,
      tagId,
      createdAt: new Date(now.getTime() - 3 * 60 * 1000),
    },
    { id: `pt-${futurePostId}`, postId: futurePostId, tagId, createdAt: now },
    {
      id: `pt-${deletedPostId}`,
      postId: deletedPostId,
      tagId,
      createdAt: new Date(now.getTime() - 90 * 1000),
    },
  ]);
  owned.postTags.push(
    pastPostId1,
    pastPostId2,
    pastPostId3,
    futurePostId,
    deletedPostId
  );
});

afterAll(async () => {
  if (owned.postTags.length > 0) {
    await db.delete(postTags).where(inArray(postTags.postId, owned.postTags));
  }
  if (owned.posts.length > 0) {
    await db.delete(posts).where(inArray(posts.id, owned.posts));
  }
  if (owned.tags.length > 0) {
    await db.delete(tags).where(inArray(tags.id, owned.tags));
  }
  if (owned.users.length > 0) {
    await db.delete(users).where(inArray(users.id, owned.users));
  }
});

describe('A2A stats.posts_by_tag future-post rule', () => {
  it('returns the visible past posts and excludes the soft-deleted one', async () => {
    const result = await fetchPostsByTag();
    const ids = result.map((p) => p.id);
    expect(ids).toEqual([pastPostId1, pastPostId2, pastPostId3]);
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
  });

  it('limit=1 returns the newest visible post even when the newest membership is a future post', async () => {
    const result = await fetchPostsByTag(1, 0);
    expect(result.map((p) => p.id)).toEqual([pastPostId1]);
  });

  it('limit=1 pages walk every visible post exactly once', async () => {
    expect((await fetchPostsByTag(1, 0)).map((p) => p.id)).toEqual([
      pastPostId1,
    ]);
    expect((await fetchPostsByTag(1, 1)).map((p) => p.id)).toEqual([
      pastPostId2,
    ]);
    expect((await fetchPostsByTag(1, 2)).map((p) => p.id)).toEqual([
      pastPostId3,
    ]);
    expect(await fetchPostsByTag(1, 3)).toEqual([]);
  });

  it('limit=2 pages cover the visible posts without gaps or repeats', async () => {
    expect((await fetchPostsByTag(2, 0)).map((p) => p.id)).toEqual([
      pastPostId1,
      pastPostId2,
    ]);
    expect((await fetchPostsByTag(2, 2)).map((p) => p.id)).toEqual([
      pastPostId3,
    ]);
    expect(await fetchPostsByTag(2, 4)).toEqual([]);
  });

  it('walks tied post and membership timestamps without gaps or repeats', async () => {
    const tiedTagId = await generateSnowflakeId();
    const tiedTagName = `${tagName}ties`;
    const timestamp = new Date(Date.now() - 60 * 60 * 1000);
    const tiedPostIds: string[] = [];
    for (let index = 0; index < 12; index++) {
      tiedPostIds.push(await generateSnowflakeId());
    }
    await db.insert(tags).values({
      id: tiedTagId,
      name: tiedTagName,
      displayName: 'F18 tied tag',
      updatedAt: new Date(),
    });
    owned.tags.push(tiedTagId);
    await db.insert(posts).values(
      tiedPostIds.map((id) => ({
        id,
        authorId,
        content: 'f18 tied timestamp post',
        timestamp,
        type: 'post',
      }))
    );
    owned.posts.push(...tiedPostIds);
    await db.insert(postTags).values(
      tiedPostIds.map((postId) => ({
        id: `pt-${postId}`,
        postId,
        tagId: tiedTagId,
        createdAt: timestamp,
      }))
    );
    owned.postTags.push(...tiedPostIds);

    const complete = (await fetchPostsByTag(50, 0, tiedTagName)).map(
      (post) => post.id
    );
    expect(complete).toHaveLength(12);
    expect(new Set(complete).size).toBe(12);
    for (const limit of [1, 2, 5]) {
      const walked: string[] = [];
      for (let offset = 0; offset < 12; offset += limit) {
        walked.push(
          ...(await fetchPostsByTag(limit, offset, tiedTagName)).map(
            (post) => post.id
          )
        );
      }
      expect(walked).toEqual(complete);
      expect(new Set(walked).size).toBe(12);
      expect(await fetchPostsByTag(limit, 12, tiedTagName)).toEqual([]);
    }
  });
});
