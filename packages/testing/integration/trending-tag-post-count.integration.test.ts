/**
 * Trending tag post counts against a real database: the postCount stored
 * for a trending tag (and served by the trending widget, the A2A trending
 * tags response, and the grouped trending total) must count only posts a
 * viewer can actually see on that tag's page.
 *
 * The tag page enforces this through getPostsByTag ("Deleted and
 * future-dated posts are excluded from both the page and the total"), the
 * actor stats route states the rule for the same kind of count
 * ("future-scheduled posts must not be counted or hinted at"), and every
 * sibling feed excludes test authors (main feed in DatabaseService, the
 * tag page itself once test authors are excluded there): accounts flagged
 * isTest in the users table and ids starting with 'test-'.
 * getTagStatistics — the sole source of the trending postCount — applied
 * only the soft-delete filter, so the trending list counted future-dated
 * and test-author posts, and a tag whose posts were all invisible could
 * trend with a positive count and no viewable posts at all.
 *
 * No module is mocked; the statistics, the trending calculation, and the
 * stored-batch read all run against the real database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  db,
  inArray,
  posts,
  postTags,
  tags,
  trendingTags,
  users,
} from '@feed/db';
import {
  calculateTrendingTags,
  getCurrentTrendingTags,
  getTagStatistics,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

let normalAuthorId: string;
let testFlaggedAuthorId: string;
let testPrefixedAuthorId: string;
let tagId: string;
let ghostTagId: string;
let tagName: string;
let ghostTagName: string;
let allPostIds: string[] = [];

beforeAll(async () => {
  const ids = await Promise.all(
    Array.from({ length: 16 }, () => generateSnowflakeId())
  );
  normalAuthorId = ids[0]!;
  testFlaggedAuthorId = ids[1]!;
  tagId = ids[2]!;
  ghostTagId = ids[3]!;
  allPostIds = ids.slice(4);
  testPrefixedAuthorId = `test-g29-${normalAuthorId}`;
  tagName = `g29trend-${normalAuthorId}`;
  ghostTagName = `g29ghost-${normalAuthorId}`;

  const now = new Date();
  const past1h = new Date(now.getTime() - 60 * 60_000);
  const past2h = new Date(now.getTime() - 2 * 60 * 60_000);
  const past3h = new Date(now.getTime() - 3 * 60 * 60_000);
  const future1d = new Date(now.getTime() + 24 * 60 * 60_000);
  const future2d = new Date(now.getTime() + 2 * 24 * 60 * 60_000);

  await db.insert(users).values([
    {
      id: normalAuthorId,
      username: `g29normal-${normalAuthorId}`,
      displayName: 'G29 Normal Author',
      updatedAt: now,
      isTest: false,
    },
    {
      id: testFlaggedAuthorId,
      username: `g29testflag-${testFlaggedAuthorId}`,
      displayName: 'G29 Test Author',
      updatedAt: now,
      isTest: true,
    },
  ]);

  await db.insert(tags).values([
    {
      id: tagId,
      name: tagName,
      displayName: 'G29 Trend',
      category: 'test',
      createdAt: past1h,
      updatedAt: past1h,
    },
    {
      id: ghostTagId,
      name: ghostTagName,
      displayName: 'G29 Ghost',
      category: 'test',
      createdAt: past1h,
      updatedAt: past1h,
    },
  ]);

  // Tag: 3 visible posts, 2 future-dated, 2 by an isTest author, 1 by a
  // 'test-' author, 1 soft-deleted. Ghost tag: 2 future-dated and 1 by an
  // isTest author — no viewable post at all.
  const visible = allPostIds.slice(0, 3);
  const future = allPostIds.slice(3, 5);
  const testFlagged = allPostIds.slice(5, 7);
  const testPrefixed = allPostIds.slice(7, 8);
  const deleted = allPostIds.slice(8, 9);
  const ghostFuture = allPostIds.slice(9, 11);
  const ghostTest = allPostIds.slice(11, 12);

  await db.insert(posts).values([
    ...visible.map((id, i) => ({
      id,
      content: `visible post ${i}`,
      authorId: normalAuthorId,
      timestamp: [past1h, past2h, past3h][i]!,
      createdAt: past1h,
    })),
    ...future.map((id, i) => ({
      id,
      content: `future post ${i}`,
      authorId: normalAuthorId,
      timestamp: [future1d, future2d][i]!,
      createdAt: past1h,
    })),
    ...testFlagged.map((id, i) => ({
      id,
      content: `test-flagged post ${i}`,
      authorId: testFlaggedAuthorId,
      timestamp: past1h,
      createdAt: past1h,
    })),
    ...testPrefixed.map((id) => ({
      id,
      content: 'test-prefixed post',
      authorId: testPrefixedAuthorId,
      timestamp: past1h,
      createdAt: past1h,
    })),
    ...deleted.map((id) => ({
      id,
      content: 'soft-deleted post',
      authorId: normalAuthorId,
      timestamp: past1h,
      createdAt: past1h,
      deletedAt: past1h,
    })),
    ...ghostFuture.map((id, i) => ({
      id,
      content: `ghost future post ${i}`,
      authorId: normalAuthorId,
      timestamp: future1d,
      createdAt: past1h,
    })),
    ...ghostTest.map((id) => ({
      id,
      content: 'ghost test-flagged post',
      authorId: testFlaggedAuthorId,
      timestamp: past1h,
      createdAt: past1h,
    })),
  ]);

  const postTagIds = await Promise.all(
    allPostIds.map(() => generateSnowflakeId())
  );
  const tagForPost = (postId: string) =>
    ghostFuture.includes(postId) || ghostTest.includes(postId)
      ? ghostTagId
      : tagId;
  await db.insert(postTags).values(
    allPostIds.map((postId, i) => ({
      id: postTagIds[i]!,
      postId,
      tagId: tagForPost(postId),
      createdAt: past1h,
    }))
  );
});

afterAll(async () => {
  await db
    .delete(trendingTags)
    .where(inArray(trendingTags.tagId, [tagId, ghostTagId]));
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagId, ghostTagId]));
  await db
    .delete(users)
    .where(inArray(users.id, [normalAuthorId, testFlaggedAuthorId]));
});

describe('trending tag postCount (getTagStatistics)', () => {
  it('counts only the posts visible on the tag page', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stats = await getTagStatistics(windowStart, windowEnd);
    const entry = stats.find((s) => s.tagId === tagId);
    // 3 visible; the 2 future, 3 test-author and 1 deleted posts must not
    // be counted (an exact count also pins the deleted control).
    expect(entry?.postCount).toBe(3);
    expect(entry?.recentPostCount).toBe(3);
  });

  it('does not trend a tag with no viewable posts', async () => {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stats = await getTagStatistics(windowStart, windowEnd);
    expect(stats.find((s) => s.tagId === ghostTagId)).toBeUndefined();
  });

  it('counts a future post once its timestamp has passed', async () => {
    const windowEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
    const stats = await getTagStatistics(windowStart, windowEnd);
    const entry = stats.find((s) => s.tagId === tagId);
    // The 2 future-dated posts are published by then: 3 + 2 = 5. The
    // test-author posts stay excluded at any window end.
    expect(entry?.postCount).toBe(5);
  });
});

describe('stored trending batch (what the trending list serves)', () => {
  it('stores the visible-only count and omits the ghost tag', async () => {
    await calculateTrendingTags();
    const current = await getCurrentTrendingTags(20);
    const entry = current.find((t) => t.tagId === tagId);
    expect(entry?.postCount).toBe(3);
    expect(current.find((t) => t.tagId === ghostTagId)).toBeUndefined();
  });
});
