/**
 * Integration test — Favorites feed test-author exclusion
 *
 * @route GET /api/posts/feed/favorites
 *
 * Real-database test: the favorites feed must apply the same test-author
 * exclusion as every sibling feed. The main feed excludes test authors in
 * SQL ("Exclude test authors in SQL before paginating, so pages are full";
 * DatabaseService.getRecentPosts), the following feed "Filters out posts
 * from test users" (CachedDatabaseService.getPostsForFollowing), and an
 * actor's own post list returns empty for a test user
 * (DatabaseService.getPostsByActor). A test author is one whose user row
 * has isTest = true or whose id starts with 'test-'. The favorites feed
 * applied neither check, so posts by a favorited test account filled the
 * viewer's favorites feed and its total while every other feed hid them.
 *
 * Pattern: stub only the `server-only` marker package; DB, auth and the
 * route handler all run for real against PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, sql } from '@feed/db';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../route';

// This route resolves the viewer through optionalAuth, which only accepts
// a Steward JWT (the x-dev-user-id bypass belongs to authenticate()).
// Mint one against the dev secret for the fixture viewer.
const STEWARD_SECRET = ['f17', 'steward', 'dev', 'secret'].join('-');
process.env.STEWARD_JWT_SECRET = STEWARD_SECRET;

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: 'f17-steward-viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(STEWARD_SECRET));
  return { authorization: `Bearer ${token}` };
}

const VIEWER = '900000000000000301';
const NORMAL = '900000000000000302'; // regular favorited author
const TEST_FLAGGED = '900000000000000303'; // favorited author with isTest = true
const TEST_PREFIXED = 'test-f17-actor'; // favorited author with a 'test-' id

const NORMAL_POSTS = ['f17-post-normal-1', 'f17-post-normal-2'];
const TEST_POSTS = ['f17-post-test-1', 'f17-post-test-2', 'f17-post-test-3'];

async function insertFixtures() {
  await db.execute(sql`
    INSERT INTO "User" (id, username, "displayName", "updatedAt", "isTest")
    VALUES
      (${VIEWER}, 'f17viewer', 'F17 Viewer', now(), false),
      (${NORMAL}, 'f17normal', 'F17 Normal', now(), false),
      (${TEST_FLAGGED}, 'f17testflag', 'F17 Test Flagged', now(), true),
      (${TEST_PREFIXED}, 'f17testprefix', 'F17 Test Prefix', now(), false)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE "User" SET "stewardId" = 'f17-steward-viewer' WHERE id = ${VIEWER}
  `);
  await db.execute(sql`
    INSERT INTO "Favorite" (id, "userId", "targetUserId")
    VALUES
      ('f17-fav-1', ${VIEWER}, ${NORMAL}),
      ('f17-fav-2', ${VIEWER}, ${TEST_FLAGGED}),
      ('f17-fav-3', ${VIEWER}, ${TEST_PREFIXED})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp, "createdAt")
    VALUES
      ('f17-post-normal-1', 'normal author post 1', ${NORMAL}, now() - interval '3 hours', now() - interval '3 hours'),
      ('f17-post-normal-2', 'normal author post 2', ${NORMAL}, now() - interval '2 hours', now() - interval '2 hours'),
      ('f17-post-test-1', 'test flagged post 1', ${TEST_FLAGGED}, now() - interval '90 minutes', now() - interval '90 minutes'),
      ('f17-post-test-2', 'test flagged post 2', ${TEST_FLAGGED}, now() - interval '1 hour', now() - interval '1 hour'),
      ('f17-post-test-3', 'test prefixed post', ${TEST_PREFIXED}, now() - interval '30 minutes', now() - interval '30 minutes')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanupFixtures() {
  await db.execute(sql`
    DELETE FROM "Post" WHERE id IN (${sql.join(
      [...NORMAL_POSTS, ...TEST_POSTS].map((id) => sql`${id}`),
      sql`, `
    )})
  `);
  await db.execute(sql`
    DELETE FROM "Favorite" WHERE "userId" = ${VIEWER}
  `);
  await db.execute(sql`
    DELETE FROM "User" WHERE id IN (${VIEWER}, ${NORMAL}, ${TEST_FLAGGED}, ${TEST_PREFIXED})
  `);
}

async function fetchFavoritesFeed() {
  const headers = await viewerAuthHeaders();
  const request = new NextRequest(
    'http://localhost/api/posts/feed/favorites?limit=20&page=1',
    { headers }
  );
  const response = await GET(request);
  const body = await response.json();
  return body as {
    posts: Array<{ id: string; authorId: string }>;
    total: number;
    hasMore: boolean;
  };
}

describe('GET /api/posts/feed/favorites test-author exclusion', () => {
  beforeAll(insertFixtures);
  afterAll(cleanupFixtures);

  it('returns only the non-test favorited author posts and counts only them in total', async () => {
    const data = await fetchFavoritesFeed();
    const ids = data.posts.map((p) => p.id).sort();
    expect(ids).toEqual([...NORMAL_POSTS].sort());
    expect(data.total).toBe(NORMAL_POSTS.length);
  });
});
