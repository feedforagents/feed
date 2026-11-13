/**
 * PRD §§6.1, 12 / MVP Phase 5: the public Hot feed must not return posts by
 * test authors. GET /api/feed/hot is the cached public feed PRD §6.1 names
 * for logged-out visitors, and GET /feed/rss renders its output as RSS, so a
 * test-author post here is published outside the site.
 *
 * Every sibling post list already excludes test authors in SQL — the main
 * feed, the following feed, an actor's own post list, the single-tag page
 * (#1685), grouped trending (#1726), stories (#1673) and favorites (#1760).
 * A test author is an account flagged isTest in the users table or an author
 * id starting with 'test-'. Hot filtered only soft-deleted, future-dated and
 * reply rows, so test-author posts were candidates for ranking and for the
 * public RSS conversion.
 *
 * Reads use the real route and PostgreSQL; no module is mocked. The shared
 * snapshot is cached under one key for every limit, and the route applies
 * the limit per request after the snapshot, so each read here sees the
 * fixtures inserted in beforeAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, reactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/hot/route';

type HotResponse = {
  success: boolean;
  posts: Array<{ id: string; authorId: string; content: string }>;
  limit: number;
};

// A limit no other Hot suite requests, so this suite reads its own snapshot.
const LIMIT = 97;

let suffix: string;
let normalAuthorId: string;
let testFlaggedAuthorId: string;
// No user row; only the id marks it as a test author.
let testPrefixedAuthorId: string;
// No user row and a non-test id: NPC actors and organizations stay visible.
let noUserAuthorId: string;
let normalPostId: string;
let noUserPostId: string;
let testFlaggedPostId: string;
let testPrefixedPostId: string;
let deletedPostId: string;
let futurePostId: string;
let likeUserIds: string[] = [];

type OwnedRows = {
  reactionIds: string[];
  postIds: string[];
  userIds: string[];
};
const owned: OwnedRows = { reactionIds: [], postIds: [], userIds: [] };

/**
 * Delete only rows this suite created, child-first. Each id lands in `owned`
 * immediately after its own INSERT RETURNING succeeds, so a failed later
 * insert never registers a row this suite does not own.
 */
async function deleteOwnedRows(rows: OwnedRows): Promise<void> {
  if (rows.reactionIds.length > 0) {
    await db.delete(reactions).where(inArray(reactions.id, rows.reactionIds));
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

beforeAll(async () => {
  const generated = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    ...Array.from({ length: 8 }, () => generateSnowflakeId()),
  ]);
  suffix = generated[0]!;
  normalAuthorId = generated[1]!;
  testFlaggedAuthorId = generated[2]!;
  noUserAuthorId = generated[3]!;
  normalPostId = generated[4]!;
  noUserPostId = generated[5]!;
  testFlaggedPostId = generated[6]!;
  testPrefixedPostId = generated[7]!;
  deletedPostId = generated[8]!;
  futurePostId = generated[9]!;
  likeUserIds = generated.slice(10);
  testPrefixedAuthorId = `test-hot-${suffix}`;
  const now = new Date();

  const createdUsers = await db
    .insert(users)
    .values([
      {
        id: normalAuthorId,
        username: `htnormal${suffix}`,
        displayName: 'Hot Test Normal Author',
        isTest: false,
        updatedAt: now,
      },
      {
        id: testFlaggedAuthorId,
        username: `httestflag${suffix}`,
        displayName: 'Hot Test Flagged Author',
        isTest: true,
        updatedAt: now,
      },
      ...likeUserIds.map((id, index) => ({
        id,
        username: `htlike${index}${suffix}`,
        displayName: `Hot Test Liker ${index}`,
        isTest: false,
        updatedAt: now,
      })),
    ])
    .returning({ id: users.id });
  owned.userIds.push(...createdUsers.map((row) => row.id));

  // All fixture posts share the newest timestamp so the candidate window
  // (ordered by timestamp desc) cannot drop them, and the engagement
  // ranking below is decided by likes alone.
  const createdPosts = await db
    .insert(posts)
    .values([
      {
        id: normalPostId,
        content: 'hot visible post by a normal author',
        authorId: normalAuthorId,
        timestamp: now,
        createdAt: now,
      },
      {
        id: noUserPostId,
        content: 'hot visible post by an author with no user row',
        authorId: noUserAuthorId,
        timestamp: now,
        createdAt: now,
      },
      {
        id: testFlaggedPostId,
        content: 'hot post by an isTest-flagged author',
        authorId: testFlaggedAuthorId,
        timestamp: now,
        createdAt: now,
      },
      {
        id: testPrefixedPostId,
        content: 'hot post by a test- prefixed author',
        authorId: testPrefixedAuthorId,
        timestamp: now,
        createdAt: now,
      },
      {
        id: deletedPostId,
        content: 'hot soft-deleted post',
        authorId: normalAuthorId,
        timestamp: now,
        createdAt: now,
        deletedAt: now,
      },
      {
        id: futurePostId,
        content: 'hot future-dated post',
        authorId: normalAuthorId,
        timestamp: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
      },
    ])
    .returning({ id: posts.id });
  owned.postIds.push(...createdPosts.map((row) => row.id));

  // The test-author posts out-rank the visible posts on engagement, so an
  // unfiltered limit=1 read returns a test-author post and a real visitor
  // (or an RSS reader) never sees the eligible one.
  const engagement: Array<[string, number]> = [
    [testFlaggedPostId, 6],
    [testPrefixedPostId, 4],
    [normalPostId, 2],
  ];
  const reactionRows: Array<typeof reactions.$inferInsert> = [];
  const reactionIds = await Promise.all(
    Array.from({ length: 12 }, () => generateSnowflakeId())
  );
  let likerIndex = 0;
  for (const [postId, likeCount] of engagement) {
    for (let i = 0; i < likeCount; i += 1) {
      reactionRows.push({
        id: reactionIds[likerIndex]!,
        postId,
        userId: likeUserIds[likerIndex]!,
        type: 'like',
        createdAt: now,
      });
      likerIndex += 1;
    }
  }
  const createdReactions = await db
    .insert(reactions)
    .values(reactionRows)
    .returning({ id: reactions.id });
  owned.reactionIds.push(...createdReactions.map((row) => row.id));
});

afterAll(async () => {
  await deleteOwnedRows(owned);
});

describe('GET /api/feed/hot test-author exclusion', () => {
  it('returns the eligible posts so the fixture is inside the window', async () => {
    const result = await readHot(LIMIT);
    expect(result.success).toBe(true);
    const returnedIds = result.posts.map((post) => post.id);
    expect(returnedIds).toContain(normalPostId);
    expect(returnedIds).toContain(noUserPostId);
    expect(returnedIds).not.toContain(deletedPostId);
    expect(returnedIds).not.toContain(futurePostId);
  });

  it('hides posts by an isTest-flagged author', async () => {
    const result = await readHot(LIMIT);
    expect(result.posts.map((post) => post.id)).not.toContain(
      testFlaggedPostId
    );
  });

  it('hides posts by a test- prefixed author with no user row', async () => {
    const result = await readHot(LIMIT);
    expect(result.posts.map((post) => post.id)).not.toContain(
      testPrefixedPostId
    );
  });

  it('does not let a test-author post take the single visible slot', async () => {
    const result = await readHot(1);
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0]?.authorId).not.toBe(testFlaggedAuthorId);
    expect(result.posts[0]?.authorId).not.toBe(testPrefixedAuthorId);
    expect([testFlaggedPostId, testPrefixedPostId]).not.toContain(
      result.posts[0]?.id
    );
  });
});
