/**
 * GET /api/users/[userId]/posts against a real database: the query schema
 * (UserPostsQuerySchema) accepts `page` and `limit`, so a profile's posts
 * must be returned one page at a time, newest first.
 *
 * Posts the route never shows (a deleted post, and a simple repost of it)
 * sit inside the first page's time window and must not take up its rows.
 *
 * Nothing is mocked; the request is anonymous, and the database and the
 * query run unmodified.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { db, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../route';

type PostsResponse = {
  type: string;
  items: Array<{ id: string }>;
};

const POST_COUNT = 6;
const MINUTE = 60_000;

let authorId: string;
// Visible posts, newest first, the order the route returns.
const postIds: string[] = [];
let deletedId: string;
let repostOfDeletedId: string;

beforeAll(async () => {
  authorId = await generateSnowflakeId();
  deletedId = await generateSnowflakeId();
  repostOfDeletedId = await generateSnowflakeId();
  const now = Date.now();

  await db.insert(users).values({
    id: authorId,
    username: `pp-${authorId}`,
    displayName: 'Profile posts fixture',
    updatedAt: new Date(now),
  });

  const rows = [];
  for (let i = 0; i < POST_COUNT; i++) {
    const id = await generateSnowflakeId();
    postIds.push(id);
    // Distinct past timestamps, one minute apart, so the order is unambiguous.
    const at = new Date(now - (i + 1) * MINUTE);
    rows.push({
      id,
      content: `Profile posts fixture ${i}`,
      authorId,
      timestamp: at,
      createdAt: at,
    });
  }
  // Between the 2nd and 3rd visible posts: a post the author deleted.
  const deletedAt = new Date(now - 2.5 * MINUTE);
  rows.push({
    id: deletedId,
    content: 'Profile posts fixture deleted',
    authorId,
    timestamp: deletedAt,
    createdAt: deletedAt,
    deletedAt,
  });
  // Between the 3rd and 4th visible posts: a simple repost of the deleted post.
  const repostAt = new Date(now - 3.5 * MINUTE);
  rows.push({
    id: repostOfDeletedId,
    content: '',
    authorId,
    originalPostId: deletedId,
    timestamp: repostAt,
    createdAt: repostAt,
  });
  await db.insert(posts).values(rows);
});

async function getPosts(query: string): Promise<string[]> {
  const res = await GET(
    new NextRequest(
      `https://feed.example/api/users/${authorId}/posts?type=posts${query}`
    ),
    { params: Promise.resolve({ userId: authorId }) }
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as PostsResponse;
  expect(body.type).toBe('posts');
  return body.items.map((p) => p.id);
}

describe('GET /api/users/[userId]/posts pagination (real database)', () => {
  it('returns the first page of the requested size', async () => {
    expect(await getPosts('&page=1&limit=5')).toEqual(postIds.slice(0, 5));
  });

  it('returns the remaining post on the second page without overlap', async () => {
    const first = await getPosts('&page=1&limit=5');
    const second = await getPosts('&page=2&limit=5');

    expect(second).toEqual([postIds[5] as string]);
    expect(second.some((id) => first.includes(id))).toBe(false);
  });

  it('returns every visible post when page and limit are omitted', async () => {
    const ids = await getPosts('');

    expect(ids).toEqual(postIds);
    expect(ids).not.toContain(deletedId);
    expect(ids).not.toContain(repostOfDeletedId);
  });

  it('returns no posts for a page past the end', async () => {
    expect(await getPosts('&page=3&limit=5')).toEqual([]);
  });
});
