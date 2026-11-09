/**
 * Web hashtag page traversal against a real database: the engine's
 * getPostsByTag (backing GET /api/trending/[tag]) must page over a
 * total order so scrolling a tag's post list reaches every eligible
 * post exactly once.
 *
 * PRD §12 keeps hashtags/trending ("Present and kept"), and the
 * function's own contract states excluded posts are removed "from
 * both the page and the total so pagination and counts agree". The
 * sibling posts-by-tag surfaces (A2A and MCP) already order by a
 * unique post id last "to keep tied pages stable", and the merged
 * A2A suite walks tied membership timestamps without gaps or
 * repeats. The engine query ordered only by postTags.createdAt, so
 * when memberships share one timestamp (posts created in a single
 * batch/transaction all receive the same createdAt) each offset page
 * could return the tied block in a different order: posts repeated
 * across pages and others were skipped permanently, while the
 * reported total still counted them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { getPostsByTag } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

let authorId: string;
let tiedTagId: string;
let tiedTagName: string;
let mixedTagId: string;
let mixedTagName: string;

const TIED_COUNT = 25;
const tiedPostIds: string[] = [];
const mixedNewerId = '';
let mixedOlderPostId = '';
let mixedNewerPostId = '';
let mixedNewestPostId = '';

const owned = {
  users: [] as string[],
  tags: [] as string[],
  posts: [] as string[],
  postTags: [] as string[],
};

async function pageIds(tag: string, limit: number, offset: number) {
  const result = await getPostsByTag(tag, { limit, offset });
  return result.posts.map((p) => p.id);
}

beforeAll(async () => {
  authorId = await generateSnowflakeId();
  tiedTagId = await generateSnowflakeId();
  mixedTagId = await generateSnowflakeId();
  tiedTagName = `f123tied${tiedTagId}`;
  mixedTagName = `f123mixed${mixedTagId}`;
  void mixedNewerId;

  const now = new Date();
  await db.insert(users).values([
    {
      id: authorId,
      username: `test-f123-author-${authorId}`,
      displayName: 'F123 Author',
      reputationPoints: 0,
      updatedAt: now,
    },
  ]);
  owned.users.push(authorId);

  await db.insert(tags).values([
    {
      id: tiedTagId,
      name: tiedTagName,
      displayName: 'F123 Tied',
      updatedAt: now,
    },
    {
      id: mixedTagId,
      name: mixedTagName,
      displayName: 'F123 Mixed',
      updatedAt: now,
    },
  ]);
  owned.tags.push(tiedTagId, mixedTagId);

  // One batch: every post and every membership shares a single
  // timestamp, as happens when posts are created in one transaction.
  const tieTime = new Date(now.getTime() - 60 * 60 * 1000);
  for (let i = 0; i < TIED_COUNT; i++) {
    tiedPostIds.push(await generateSnowflakeId());
  }
  await db.insert(posts).values(
    tiedPostIds.map((id) => ({
      id,
      authorId,
      content: 'f123 tied post',
      timestamp: tieTime,
      type: 'post' as const,
    }))
  );
  owned.posts.push(...tiedPostIds);
  await db.insert(postTags).values(
    tiedPostIds.map((postId) => ({
      id: `pt-${postId}`,
      postId,
      tagId: tiedTagId,
      createdAt: tieTime,
    }))
  );
  owned.postTags.push(...tiedPostIds);

  // Distinct membership times: newest membership must list first.
  mixedOlderPostId = await generateSnowflakeId();
  mixedNewerPostId = await generateSnowflakeId();
  mixedNewestPostId = await generateSnowflakeId();
  const older = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const newer = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const newest = new Date(now.getTime() - 60 * 60 * 1000);
  await db.insert(posts).values([
    {
      id: mixedOlderPostId,
      authorId,
      content: 'f123 older',
      timestamp: older,
      type: 'post' as const,
    },
    {
      id: mixedNewerPostId,
      authorId,
      content: 'f123 newer',
      timestamp: newer,
      type: 'post' as const,
    },
    {
      id: mixedNewestPostId,
      authorId,
      content: 'f123 newest',
      timestamp: newest,
      type: 'post' as const,
    },
  ]);
  owned.posts.push(mixedOlderPostId, mixedNewerPostId, mixedNewestPostId);
  await db.insert(postTags).values([
    {
      id: `pt-${mixedOlderPostId}`,
      postId: mixedOlderPostId,
      tagId: mixedTagId,
      createdAt: older,
    },
    {
      id: `pt-${mixedNewerPostId}`,
      postId: mixedNewerPostId,
      tagId: mixedTagId,
      createdAt: newer,
    },
    {
      id: `pt-${mixedNewestPostId}`,
      postId: mixedNewestPostId,
      tagId: mixedTagId,
      createdAt: newest,
    },
  ]);
  owned.postTags.push(mixedOlderPostId, mixedNewerPostId, mixedNewestPostId);
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

describe('web getPostsByTag tied-membership pagination', () => {
  it('returns every tied post exactly once in the complete listing', async () => {
    const result = await getPostsByTag(tiedTagName, { limit: 100, offset: 0 });
    expect(result.total).toBe(TIED_COUNT);
    expect(result.posts).toHaveLength(TIED_COUNT);
    expect(new Set(result.posts.map((p) => p.id)).size).toBe(TIED_COUNT);
  });

  it('walks tied memberships without gaps or repeats at small page sizes', async () => {
    const complete = await pageIds(tiedTagName, 100, 0);
    for (const limit of [1, 2, 5]) {
      const walked: string[] = [];
      for (let offset = 0; offset < TIED_COUNT; offset += limit) {
        walked.push(...(await pageIds(tiedTagName, limit, offset)));
      }
      expect(walked).toEqual(complete);
      expect(new Set(walked).size).toBe(TIED_COUNT);
      expect(await pageIds(tiedTagName, limit, TIED_COUNT)).toEqual([]);
    }
  });

  it('keeps newest membership first when membership times differ', async () => {
    expect(await pageIds(mixedTagName, 20, 0)).toEqual([
      mixedNewestPostId,
      mixedNewerPostId,
      mixedOlderPostId,
    ]);
  });
});
