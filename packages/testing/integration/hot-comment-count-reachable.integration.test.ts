/**
 * PRD §6.1 / #1994 rule: a Hot feed card must promise only the comments the
 * post detail screen can show. GET /api/feed/hot is the cached public feed
 * PRD §6.1 names for logged-out visitors (and GET /feed/rss renders its
 * output), so its commentCount is published outside the site — and the same
 * number feeds the hot score (comments weigh 2), so an inflated count also
 * distorts ranking.
 *
 * The detail screen counts with countReachablePostComments: a reply is
 * reachable only through visible (non-deleted) parents rooted on the post.
 * The Hot route counts every non-deleted comment row, so a visible reply
 * under a soft-deleted parent inflates the card (and the score) while the
 * detail screen never shows it — the same defect #2115 (For You), #2116
 * (tag feed) and #2117 (Stories) already fixed on their own pipelines.
 *
 * Reads use the real route and PostgreSQL; no module is mocked. The shared
 * snapshot is cached under one key, so this suite runs in its own bun
 * process (as the other Hot suites do) and reads its own fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { countReachablePostComments } from '@feed/api';
import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/hot/route';

type HotResponse = {
  success: boolean;
  posts: Array<{
    id: string;
    commentCount: number;
    likeCount: number;
    shareCount: number;
    hotScore: number;
  }>;
  limit: number;
};

// A limit no other Hot suite requests.
const LIMIT = 93;

let suffix: string;
let authorId: string;
let commenterId: string;
let mixedPostId: string;
let controlPostId: string;
let visibleTopId: string;
let visibleReplyId: string;
let visibleTop2Id: string;
let deletedParentId: string;
let replyUnderDeletedId: string;
let controlCommentId: string;

type OwnedRows = {
  commentIds: string[];
  postIds: string[];
  userIds: string[];
};
const owned: OwnedRows = { commentIds: [], postIds: [], userIds: [] };

async function deleteOwnedRows(rows: OwnedRows): Promise<void> {
  if (rows.commentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, rows.commentIds));
  }
  if (rows.postIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, rows.postIds));
  }
  if (rows.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, rows.userIds));
  }
}

async function readHot(limit: number): Promise<HotResponse> {
  const response = await GET(
    new NextRequest(`http://localhost/api/feed/hot?limit=${limit}`)
  );
  if (!response.ok) {
    throw new Error(`Hot read failed: ${response.status}`);
  }
  return (await response.json()) as HotResponse;
}

function findPost(result: HotResponse, postId: string) {
  const post = result.posts.find((p) => p.id === postId);
  expect(post).toBeDefined();
  return post!;
}

beforeAll(async () => {
  const generated = await Promise.all(
    Array.from({ length: 10 }, () => generateSnowflakeId())
  );
  [
    suffix,
    authorId,
    commenterId,
    mixedPostId,
    controlPostId,
    visibleTopId,
    visibleReplyId,
    visibleTop2Id,
    deletedParentId,
    replyUnderDeletedId,
  ] = generated as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  controlCommentId = (await generateSnowflakeId()) as string;
  const now = new Date();

  const createdUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `hcc-author-${suffix}`,
        displayName: 'Hot Comment Count Author',
        isTest: false,
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `hcc-commenter-${suffix}`,
        displayName: 'Hot Comment Count Commenter',
        isTest: false,
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  owned.userIds.push(...createdUsers.map((row) => row.id));

  const createdPosts = await db
    .insert(posts)
    .values([
      {
        id: mixedPostId,
        content:
          'hot mixed post: visible comments plus a reply under a deleted parent',
        authorId,
        timestamp: now,
        createdAt: now,
      },
      {
        id: controlPostId,
        content: 'hot control post: one visible comment',
        authorId,
        timestamp: now,
        createdAt: now,
      },
    ])
    .returning({ id: posts.id });
  owned.postIds.push(...createdPosts.map((row) => row.id));

  // Mixed post: 4 non-deleted rows, only 3 reachable from the post —
  // the reply under the soft-deleted parent is invisible on detail.
  const createdComments = await db
    .insert(comments)
    .values([
      {
        id: visibleTopId,
        content: 'visible top-level comment',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: visibleReplyId,
        content: 'visible reply under a visible parent',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: visibleTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: visibleTop2Id,
        content: 'second visible top-level comment',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: deletedParentId,
        content: 'soft-deleted parent comment',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: replyUnderDeletedId,
        content: 'visible reply under the deleted parent',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: deletedParentId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: controlCommentId,
        content: 'control visible comment',
        postId: controlPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  owned.commentIds.push(...createdComments.map((row) => row.id));
});

afterAll(async () => {
  await deleteOwnedRows(owned);
});

describe('GET /api/feed/hot reachable comment count', () => {
  it('counts only reachable comments on the mixed-post card', async () => {
    const result = await readHot(LIMIT);
    expect(result.success).toBe(true);
    const post = findPost(result, mixedPostId);
    // 4 non-deleted rows, 3 reachable: the reply under the deleted
    // parent must not be counted.
    expect(post.commentCount).toBe(3);
  });

  it('counts the control post correctly', async () => {
    const result = await readHot(LIMIT);
    expect(findPost(result, controlPostId).commentCount).toBe(1);
  });

  it('matches the detail-screen count, and the hot score follows it', async () => {
    const result = await readHot(LIMIT);
    const post = findPost(result, mixedPostId);
    const detailCount = await countReachablePostComments(mixedPostId, []);
    expect(detailCount).toBe(3);
    expect(post.commentCount).toBe(detailCount);
    // No likes/shares on the fixture, so the score is commentCount * 2
    // minus a sub-second age penalty.
    expect(post.hotScore).toBeCloseTo(post.commentCount * 2, 1);
  });
});
