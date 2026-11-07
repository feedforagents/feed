/**
 * Integration test — Trending Posts widget comment counts
 *
 * @route GET /api/feed/widgets/trending-posts
 *
 * Real-database test: the widget's comment counts must exclude soft-deleted
 * (moderated) comments, matching every sibling surface (main feed, narrative
 * feed, post detail/interactions, embed) which all count comments with
 * `deletedAt IS NULL`.
 *
 * Pattern: stub only the `server-only` marker package; DB, auth and the
 * route handler all run for real against PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, sql } from '@feed/db';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const AUTHOR = '900000000000000101';
const VIEWER = '900000000000000102';
const LIKERS = [
  '900000000000000111',
  '900000000000000112',
  '900000000000000113',
  '900000000000000114',
  '900000000000000115',
];
const POST_A = 'f13-post-a'; // 2 visible comments + 2 soft-deleted comments
const POST_B = 'f13-post-b'; // 3 visible comments, none deleted (control)

async function insertFixtures() {
  const userIds = [AUTHOR, VIEWER, ...LIKERS];
  for (const id of userIds) {
    await db.execute(sql`
      INSERT INTO "User" (id, username, "displayName", "updatedAt")
      VALUES (${id}, ${'f13user' + id.slice(-3)}, ${'F13 User ' + id.slice(-3)}, now())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp)
    VALUES
      (${POST_A}, 'f13 trending post A', ${AUTHOR}, now() - interval '1 hour'),
      (${POST_B}, 'f13 trending post B', ${AUTHOR}, now() - interval '1 hour')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "Comment" (id, content, "postId", "authorId", "updatedAt", "deletedAt")
    VALUES
      ('f13-ca-1', 'visible 1', ${POST_A}, ${AUTHOR}, now(), NULL),
      ('f13-ca-2', 'visible 2', ${POST_A}, ${AUTHOR}, now(), NULL),
      ('f13-ca-3', 'moderated 1', ${POST_A}, ${AUTHOR}, now(), now()),
      ('f13-ca-4', 'moderated 2', ${POST_A}, ${AUTHOR}, now(), now()),
      ('f13-cb-1', 'visible 1', ${POST_B}, ${AUTHOR}, now(), NULL),
      ('f13-cb-2', 'visible 2', ${POST_B}, ${AUTHOR}, now(), NULL),
      ('f13-cb-3', 'visible 3', ${POST_B}, ${AUTHOR}, now(), NULL)
    ON CONFLICT (id) DO NOTHING
  `);
  for (const [i, liker] of LIKERS.entries()) {
    await db.execute(sql`
      INSERT INTO "Reaction" (id, "postId", "userId", type)
      VALUES (${'f13-ra-' + i}, ${POST_A}, ${liker}, 'like'),
             (${'f13-rb-' + i}, ${POST_B}, ${liker}, 'like')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function cleanupFixtures() {
  await db.execute(sql`DELETE FROM "Reaction" WHERE id LIKE 'f13-%'`);
  await db.execute(sql`DELETE FROM "Comment" WHERE id LIKE 'f13-%'`);
  await db.execute(sql`DELETE FROM "Post" WHERE id LIKE 'f13-%'`);
  await db.execute(sql`DELETE FROM "User" WHERE id LIKE '9000000000000001%'`);
}

async function fetchTrending(headers?: Record<string, string>) {
  const request = new NextRequest(
    'http://localhost/api/feed/widgets/trending-posts?limit=10',
    { headers }
  );
  const response = await GET(request);
  const body = (await response.json()) as {
    success: boolean;
    posts: Array<{ id: string; commentCount: number; likeCount: number }>;
  };
  return body.posts;
}

describe('GET /api/feed/widgets/trending-posts comment counts', () => {
  beforeAll(insertFixtures);
  afterAll(cleanupFixtures);

  it('excludes soft-deleted comments (public branch)', async () => {
    const posts = await fetchTrending();
    const a = posts.find((p) => p.id === POST_A);
    const b = posts.find((p) => p.id === POST_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.likeCount).toBe(5);
    expect(a!.commentCount).toBe(2);
    expect(b!.commentCount).toBe(3);
  });

  it('excludes soft-deleted comments (signed-in branch)', async () => {
    const posts = await fetchTrending({ 'x-dev-user-id': VIEWER });
    const a = posts.find((p) => p.id === POST_A);
    const b = posts.find((p) => p.id === POST_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.commentCount).toBe(2);
    expect(b!.commentCount).toBe(3);
  });
});
