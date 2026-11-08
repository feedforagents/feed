/**
 * GET /api/trending/group against a real database: the grouped trending
 * list must not expose posts written by test authors.
 *
 * Finding posts by topic is one action with two arrivals: the single-tag
 * page goes through getPostsByTag, and a grouped topic (more than one
 * tag) lands here. Every sibling post list excludes test authors in SQL
 * — the main feed ("Exclude test authors in SQL before paginating, so
 * pages are full", DatabaseService.getRecentPosts), the following feed,
 * an actor's own post list, and the single-tag page (#1685). A test
 * author is an account flagged isTest in the users table or an author
 * id starting with 'test-'. This grouped route filtered only
 * soft-deleted and future-dated posts, so test-author posts were
 * returned in full and could crowd real posts out of the
 * fetch-then-deduplicate window (limit * 2 relations, then slice).
 *
 * Authors with no user row and a non-test id (NPC actors, organizations)
 * are legitimate authors on this surface and must stay visible.
 *
 * Reads use the real route and database; no module is mocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type GroupResponse = {
  success: boolean;
  posts: Array<{ id: string; content: string; authorId: string }>;
  tags: Array<{ id: string; name: string }>;
};

let suffix: string;
let normalAuthorId: string;
let testFlaggedAuthorId: string;
let testPrefixedAuthorId: string;
let actorAuthorId: string;
let tagAId: string;
let tagBId: string;
let tagGammaId: string;
let normalPostId: string;
let actorPostId: string;
let testFlaggedPostId: string;
let testPrefixedPostId: string;
let deletedPostId: string;
let futurePostId: string;
let gammaNormalPostId: string;
let gammaTestPostIds: string[] = [];
let clientIp: string;
const allPostIds: string[] = [];
const allUserIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/trending/group/route').GET;

async function fetchGroup(tagsParam: string, limit: number) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/trending/group?tags=${tagsParam}&limit=${limit}`,
      { headers: { 'x-forwarded-for': clientIp } }
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | GroupResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/trending/group/route'
  ));

  [
    suffix,
    normalAuthorId,
    testFlaggedAuthorId,
    actorAuthorId,
    tagAId,
    tagBId,
    tagGammaId,
    normalPostId,
    actorPostId,
    testFlaggedPostId,
    testPrefixedPostId,
    deletedPostId,
    futurePostId,
    gammaNormalPostId,
  ] = await Promise.all(
    Array.from({ length: 14 }, () => generateSnowflakeId())
  );
  testPrefixedAuthorId = `test-f1-${suffix}`;
  gammaTestPostIds = [
    `f1-gamma-test-1-${suffix}`,
    `f1-gamma-test-2-${suffix}`,
    `f1-gamma-test-3-${suffix}`,
  ];
  allPostIds.push(
    normalPostId,
    actorPostId,
    testFlaggedPostId,
    testPrefixedPostId,
    deletedPostId,
    futurePostId,
    gammaNormalPostId,
    ...gammaTestPostIds
  );
  allUserIds.push(normalAuthorId, testFlaggedAuthorId);
  clientIp = `2001:db8:77f1:0:${BigInt(suffix)
    .toString(16)
    .padStart(16, '0')
    .match(/.{4}/g)!
    .join(':')}`;

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);
  const minute = 60_000;

  await db.insert(users).values([
    {
      id: normalAuthorId,
      username: `f1normal${suffix}`,
      displayName: 'F1 Normal Author',
      isTest: false,
      updatedAt: now,
    },
    {
      id: testFlaggedAuthorId,
      username: `f1testflag${suffix}`,
      displayName: 'F1 Test Flagged Author',
      isTest: true,
      updatedAt: now,
    },
  ]);

  await db.insert(tags).values([
    {
      id: tagAId,
      name: `f1-alpha-${suffix}`,
      displayName: 'F1 Alpha',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    },
    {
      id: tagBId,
      name: `f1-beta-${suffix}`,
      displayName: 'F1 Beta',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    },
    {
      id: tagGammaId,
      name: `f1-gamma-${suffix}`,
      displayName: 'F1 Gamma',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    },
  ]);

  // The normal author's post carries both group tags (dedupe control).
  // The actor-like author has no user row and a non-test id, like the
  // NPC actors and organizations this route resolves outside the users
  // table. The test-prefixed author also has no user row; only its id
  // marks it as a test author.
  await db.insert(posts).values([
    {
      id: normalPostId,
      content: 'f1 visible post by a normal author',
      authorId: normalAuthorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: actorPostId,
      content: 'f1 visible post by an actor author',
      authorId: actorAuthorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: testFlaggedPostId,
      content: 'f1 post by an isTest-flagged author',
      authorId: testFlaggedAuthorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: testPrefixedPostId,
      content: 'f1 post by a test- prefixed author',
      authorId: testPrefixedAuthorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: deletedPostId,
      content: 'f1 soft-deleted post',
      authorId: normalAuthorId,
      timestamp: past,
      createdAt: past,
      deletedAt: past,
    },
    {
      id: futurePostId,
      content: 'f1 future-dated post',
      authorId: normalAuthorId,
      timestamp: future,
      createdAt: past,
    },
    {
      id: gammaNormalPostId,
      content: 'f1 gamma visible post by a normal author',
      authorId: normalAuthorId,
      timestamp: past,
      createdAt: past,
    },
    ...gammaTestPostIds.map((id, i) => ({
      id,
      content: `f1 gamma test-author post ${i + 1}`,
      authorId: i % 2 === 0 ? testFlaggedAuthorId : testPrefixedAuthorId,
      timestamp: past,
      createdAt: past,
    })),
  ]);

  const relIds = await Promise.all(
    Array.from({ length: 11 }, () => generateSnowflakeId())
  );
  const rel = (i: number, postId: string, tagId: string, at: Date) => ({
    id: relIds[i]!,
    postId,
    tagId,
    createdAt: at,
  });
  await db.insert(postTags).values([
    rel(0, normalPostId, tagAId, past),
    rel(1, normalPostId, tagBId, past),
    rel(2, actorPostId, tagBId, past),
    rel(3, testFlaggedPostId, tagAId, past),
    rel(4, testPrefixedPostId, tagBId, past),
    rel(5, deletedPostId, tagAId, past),
    rel(6, futurePostId, tagBId, past),
    // Gamma: the three test-author relations are the newest, so an
    // unfiltered limit * 2 fetch window holds only test-author posts.
    rel(7, gammaNormalPostId, tagGammaId, new Date(past.getTime())),
    rel(8, gammaTestPostIds[0]!, tagGammaId, new Date(past.getTime() + minute)),
    rel(
      9,
      gammaTestPostIds[1]!,
      tagGammaId,
      new Date(past.getTime() + 2 * minute)
    ),
    rel(
      10,
      gammaTestPostIds[2]!,
      tagGammaId,
      new Date(past.getTime() + 3 * minute)
    ),
  ]);
});

afterAll(async () => {
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagAId, tagBId, tagGammaId]));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/trending/group test-author exclusion', () => {
  it('returns the visible posts (normal author, actor author, deduped)', async () => {
    const { status, body } = await fetchGroup(
      `f1-alpha-${suffix},f1-beta-${suffix}`,
      10
    );
    expect(status).toBe(200);
    const ids = (body as GroupResponse).posts.map((p) => p.id);
    expect(ids).toContain(normalPostId);
    expect(ids).toContain(actorPostId);
    expect(ids.filter((id) => id === normalPostId)).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });

  it('hides posts by an isTest-flagged author', async () => {
    const { body } = await fetchGroup(
      `f1-alpha-${suffix},f1-beta-${suffix}`,
      10
    );
    const group = body as GroupResponse;
    expect(group.posts.map((p) => p.id)).not.toContain(testFlaggedPostId);
    expect(JSON.stringify(group.posts)).not.toContain(
      'post by an isTest-flagged author'
    );
  });

  it('hides posts by a test- prefixed author with no user row', async () => {
    const { body } = await fetchGroup(
      `f1-alpha-${suffix},f1-beta-${suffix}`,
      10
    );
    const group = body as GroupResponse;
    expect(group.posts.map((p) => p.id)).not.toContain(testPrefixedPostId);
    expect(JSON.stringify(group.posts)).not.toContain(
      'post by a test- prefixed author'
    );
  });

  it('still excludes soft-deleted and future-dated posts (controls)', async () => {
    const { body } = await fetchGroup(
      `f1-alpha-${suffix},f1-beta-${suffix}`,
      10
    );
    const ids = (body as GroupResponse).posts.map((p) => p.id);
    expect(ids).not.toContain(deletedPostId);
    expect(ids).not.toContain(futurePostId);
  });

  it('keeps the visible post reachable when test posts are newest (limit window)', async () => {
    const { status, body } = await fetchGroup(`f1-gamma-${suffix}`, 1);
    expect(status).toBe(200);
    const ids = (body as GroupResponse).posts.map((p) => p.id);
    expect(ids).toEqual([gammaNormalPostId]);
  });
});
