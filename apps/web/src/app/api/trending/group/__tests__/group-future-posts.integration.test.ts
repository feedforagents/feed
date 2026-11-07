/**
 * GET /api/trending/group against a real database: a grouped trending
 * topic must not expose posts whose timestamp is still in the future.
 *
 * The single-tag trending page enforces this through getPostsByTag
 * ("Deleted and future-dated posts are excluded from both the page and
 * the total"), the trending widget filters `lte(posts.timestamp, now)`,
 * and the time-filtering suite states the rule for the whole API:
 * "APIs should not expose future posts or events." The grouped route —
 * reached from the same Trending panel click when a topic has more
 * than one tag — only filtered soft-deleted posts, so a future-dated
 * post tagged with any of the group's tags was returned in full.
 *
 * The request is anonymous (no token), so no module is mocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, eq, inArray, posts, postTags, tags, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type GroupResponse = {
  success: boolean;
  posts: Array<{ id: string; content: string }>;
  tags: Array<{ id: string; name: string }>;
};

let authorId: string;
let tagAId: string;
let tagBId: string;
let visiblePostId: string;
let futurePostId: string;
let deletedPostId: string;
const allPostIds: string[] = [];

let GET: typeof import('../route').GET;

async function fetchGroup() {
  const request = new NextRequest(
    new Request(
      'http://localhost/api/trending/group?tags=f4-alpha,f4-beta&limit=10'
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
  ({ GET } = await import('../route'));

  [authorId, tagAId, tagBId, visiblePostId, futurePostId, deletedPostId] =
    await Promise.all(Array.from({ length: 6 }, () => generateSnowflakeId()));
  allPostIds.push(visiblePostId, futurePostId, deletedPostId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  await db.insert(users).values({
    id: authorId,
    username: `test-f4-${authorId}`,
    displayName: 'Trending Fixture Author',
    updatedAt: now,
  });

  await db.insert(tags).values([
    {
      id: tagAId,
      name: 'f4-alpha',
      displayName: 'F4 Alpha',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    },
    {
      id: tagBId,
      name: 'f4-beta',
      displayName: 'F4 Beta',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    },
  ]);

  // One already-published post, one post whose timestamp is two hours
  // in the future (not yet published anywhere else in the app), and one
  // soft-deleted post as a control for the existing deletedAt filter.
  await db.insert(posts).values([
    {
      id: visiblePostId,
      content: 'visible trending post',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: futurePostId,
      content: 'future post that must not leak early',
      authorId,
      timestamp: future,
      createdAt: past,
    },
    {
      id: deletedPostId,
      content: 'soft-deleted trending post',
      authorId,
      timestamp: past,
      createdAt: past,
      deletedAt: past,
    },
  ]);

  const postTagIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(postTags).values([
    {
      id: postTagIds[0]!,
      postId: visiblePostId,
      tagId: tagAId,
      createdAt: past,
    },
    {
      id: postTagIds[1]!,
      postId: futurePostId,
      tagId: tagBId,
      createdAt: past,
    },
    {
      id: postTagIds[2]!,
      postId: deletedPostId,
      tagId: tagAId,
      createdAt: past,
    },
  ]);
});

afterAll(async () => {
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagAId, tagBId]));
  await db.delete(users).where(eq(users.id, authorId));
});

describe('GET /api/trending/group future posts', () => {
  it('returns the published post but not the future-dated one', async () => {
    const { status, body } = await fetchGroup();
    expect(status).toBe(200);
    const group = body as GroupResponse;
    const ids = group.posts.map((p) => p.id);
    expect(ids).toContain(visiblePostId);
    expect(ids).not.toContain(futurePostId);
    expect(JSON.stringify(group.posts)).not.toContain(
      'future post that must not leak early'
    );
  });

  it('still excludes the soft-deleted post', async () => {
    const { status, body } = await fetchGroup();
    expect(status).toBe(200);
    const group = body as GroupResponse;
    const ids = group.posts.map((p) => p.id);
    expect(ids).not.toContain(deletedPostId);
  });
});
