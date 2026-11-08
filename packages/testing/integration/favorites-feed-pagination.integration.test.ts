/**
 * Integration test — Favorites feed pagination across equal timestamps
 *
 * @route GET /api/posts/feed/favorites
 *
 * Real-database test: paging through the favorites feed must return every
 * visible post exactly once. The route orders posts by `createdAt` alone,
 * which does not determine an order when several posts share one
 * `createdAt` — and equal values are ordinary data here, not an edge
 * invention: `createdAt` defaults to the database transaction timestamp
 * (`defaultNow()`), and engine post creation (post-generation helpers,
 * article persistence) also stamps posts from millisecond-precision JS
 * `Date` values inside tight batch loops. With OFFSET paging, Postgres'
 * top-N sort then hands each page a different tie order, so a tied post
 * can be returned on two pages while another tied post is returned on
 * none, even though `total` stays correct.
 *
 * Fixture: the viewer favorites two authors. One author has 7 posts that
 * all share a single `createdAt`; the other has 5 posts at distinct older
 * times. One soft-deleted post and one future-dated post are included as
 * controls — they must stay invisible and uncounted on every page.
 *
 * Pattern: stub only the `server-only` marker package; DB, auth and the
 * route handler all run for real against PostgreSQL. The viewer is signed
 * in with a real Steward JWT (this route resolves the viewer through
 * optionalAuth, which accepts only a Steward JWT or an agent session).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, sql } from '@feed/db';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/posts/feed/favorites/route';

const STEWARD_SECRET = 'g25-pagination-test-secret';
process.env.STEWARD_JWT_SECRET = STEWARD_SECRET;

const VIEWER = '900000000000000401';
const AUTHOR_A = '900000000000000402';
const AUTHOR_B = '900000000000000403';

const TIE_IDS = [
  'g25-tie-01',
  'g25-tie-02',
  'g25-tie-03',
  'g25-tie-04',
  'g25-tie-05',
  'g25-tie-06',
  'g25-tie-07',
];
const DISTINCT_IDS = [
  'g25-dist-01',
  'g25-dist-02',
  'g25-dist-03',
  'g25-dist-04',
  'g25-dist-05',
];
const HIDDEN_IDS = ['g25-hidden-deleted', 'g25-hidden-future'];
// After the fix the order is fully determined: createdAt desc, id desc.
const EXPECTED_ORDER = [...[...TIE_IDS].reverse(), ...DISTINCT_IDS];

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: 'g25-steward-viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(STEWARD_SECRET));
  return { authorization: `Bearer ${token}` };
}

type FeedPage = {
  ids: string[];
  total: number;
  hasMore: boolean;
};

async function fetchPage(limit: number, page: number): Promise<FeedPage> {
  const headers = await viewerAuthHeaders();
  const request = new NextRequest(
    `http://localhost/api/posts/feed/favorites?limit=${limit}&page=${page}`,
    { headers }
  );
  const response = await GET(request);
  const body = (await response.json()) as {
    data?: {
      posts: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    posts?: Array<{ id: string }>;
    total?: number;
    hasMore?: boolean;
  };
  const data = body.data ?? {
    posts: body.posts ?? [],
    total: body.total ?? 0,
    hasMore: body.hasMore ?? false,
  };
  return {
    ids: data.posts.map((p) => p.id),
    total: data.total,
    hasMore: data.hasMore,
  };
}

async function pageThrough(limit: number): Promise<FeedPage[]> {
  const pages: FeedPage[] = [];
  for (let page = 1; page <= 12; page++) {
    const result = await fetchPage(limit, page);
    pages.push(result);
    if (!result.hasMore) break;
  }
  return pages;
}

async function insertFixtures() {
  const tieAt = new Date(Date.now() - 2 * 60 * 60_000);
  await db.execute(sql`
    INSERT INTO "User" (id, username, "displayName", "updatedAt", "isTest", "stewardId")
    VALUES
      (${VIEWER}, 'g25viewer', 'G25 Viewer', now(), false, 'g25-steward-viewer'),
      (${AUTHOR_A}, 'g25authora', 'G25 Author A', now(), false, null),
      (${AUTHOR_B}, 'g25authorb', 'G25 Author B', now(), false, null)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "Favorite" (id, "userId", "targetUserId")
    VALUES
      ('g25-fav-a', ${VIEWER}, ${AUTHOR_A}),
      ('g25-fav-b', ${VIEWER}, ${AUTHOR_B})
    ON CONFLICT (id) DO NOTHING
  `);
  // 7 posts sharing one createdAt (inserted in scrambled order).
  const scrambled = [
    TIE_IDS[3]!,
    TIE_IDS[0]!,
    TIE_IDS[6]!,
    TIE_IDS[2]!,
    TIE_IDS[5]!,
    TIE_IDS[1]!,
    TIE_IDS[4]!,
  ];
  for (const id of scrambled) {
    await db.execute(sql`
      INSERT INTO "Post" (id, content, "authorId", timestamp, "createdAt")
      VALUES (${id}, ${'tie post ' + id}, ${AUTHOR_A}, ${tieAt.toISOString()}, ${tieAt.toISOString()})
      ON CONFLICT (id) DO NOTHING
    `);
  }
  // 5 posts at distinct older times, dist-01 newest of the five.
  for (let i = 0; i < DISTINCT_IDS.length; i++) {
    const at = new Date(tieAt.getTime() - (10 + i * 10) * 60_000);
    await db.execute(sql`
      INSERT INTO "Post" (id, content, "authorId", timestamp, "createdAt")
      VALUES (${DISTINCT_IDS[i]!}, ${'distinct post ' + DISTINCT_IDS[i]!}, ${AUTHOR_B}, ${at.toISOString()}, ${at.toISOString()})
      ON CONFLICT (id) DO NOTHING
    `);
  }
  // Controls: one soft-deleted (newest of all), one future-dated.
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const future = new Date(Date.now() + 2 * 60 * 60_000);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp, "createdAt", "deletedAt")
    VALUES ('g25-hidden-deleted', 'deleted post', ${AUTHOR_A}, ${hourAgo.toISOString()}, ${hourAgo.toISOString()}, now())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO "Post" (id, content, "authorId", timestamp, "createdAt")
    VALUES ('g25-hidden-future', 'future post', ${AUTHOR_A}, ${future.toISOString()}, ${hourAgo.toISOString()})
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanupFixtures() {
  for (const id of [...TIE_IDS, ...DISTINCT_IDS, ...HIDDEN_IDS]) {
    await db.execute(sql`DELETE FROM "Post" WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM "Favorite" WHERE "userId" = ${VIEWER}`);
  await db.execute(
    sql`DELETE FROM "User" WHERE id IN (${VIEWER}, ${AUTHOR_A}, ${AUTHOR_B})`
  );
}

describe('GET /api/posts/feed/favorites pagination', () => {
  beforeAll(insertFixtures);
  afterAll(cleanupFixtures);

  it('returns every visible post exactly once when a tied block straddles pages of 3', async () => {
    const pages = await pageThrough(3);
    const flat = pages.flatMap((p) => p.ids);
    expect(pages).toHaveLength(4);
    for (const page of pages) {
      expect(page.total).toBe(12);
    }
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, true, false]);
    expect(flat).toEqual(EXPECTED_ORDER);
    expect(new Set(flat).size).toBe(12);
  });

  it('returns every visible post exactly once with pages of 2', async () => {
    const pages = await pageThrough(2);
    const flat = pages.flatMap((p) => p.ids);
    expect(pages).toHaveLength(6);
    expect(flat).toEqual(EXPECTED_ORDER);
    expect(new Set(flat).size).toBe(12);
  });

  it('keeps total and hasMore truthful on a single full page and past the end', async () => {
    const full = await fetchPage(20, 1);
    expect(full.ids).toEqual(EXPECTED_ORDER);
    expect(full.total).toBe(12);
    expect(full.hasMore).toBe(false);

    const pastEnd = await fetchPage(3, 9);
    expect(pastEnd.ids).toEqual([]);
    expect(pastEnd.total).toBe(12);
    expect(pastEnd.hasMore).toBe(false);
  });
});
