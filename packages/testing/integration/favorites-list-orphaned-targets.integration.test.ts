/**
 * GET /api/profiles/favorites against a real database: the favorites list
 * must only count and page profiles that still exist.
 *
 * The Favorite table has no foreign key to User (the fresh baseline adds
 * only a unique constraint and indexes), and the account-deletion route
 * (POST /api/users/delete-account) removes the user row without touching
 * Favorite rows — its cleanup relies on cascades that do not exist for
 * this table. So when a favorited account is deleted, the favorite row
 * survives as an orphan: the list endpoint drops the entry from
 * `profiles` (its target lookup misses) but still counts the row in
 * `total` and still spends a pagination slot on it. The list promises
 * profiles the viewer can never see, and a page whose only favorite is
 * orphaned comes back empty while later pages hold real profiles.
 *
 * The request is authenticated with the existing CI synthetic bearer. The
 * only stub is the `server-only` marker package (an empty environment
 * guard that throws outside a Server Component); every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, favorites, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type FavoritesResponse = {
  profiles: Array<{ id: string }>;
  total: number;
  pagination: { total: number; totalPages: number };
};

let viewerId: string;
let authorAId: string;
let authorBId: string;
let ghostId: string;

let GET: typeof import('../../../apps/web/src/app/api/profiles/favorites/route').GET;

async function fetchFavorites(query = '') {
  const request = new NextRequest(
    new Request(`http://localhost/api/profiles/favorites${query}`),
    { headers: { authorization: `Bearer steward:test:${viewerId}` } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FavoritesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body: body as FavoritesResponse };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/profiles/favorites/route'
  ));

  [viewerId, authorAId, authorBId, ghostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = Date.now();
  const t = (msAgo: number) => new Date(now - msAgo);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `g28v-${viewerId}`,
      displayName: 'Orphan Fixture Viewer',
      updatedAt: t(0),
    },
    {
      id: authorAId,
      username: `g28a-${authorAId}`,
      displayName: 'Orphan Fixture Author A',
      updatedAt: t(0),
    },
    {
      id: authorBId,
      username: `g28b-${authorBId}`,
      displayName: 'Orphan Fixture Author B',
      updatedAt: t(0),
    },
    {
      id: ghostId,
      username: `g28g-${ghostId}`,
      displayName: 'Soon Deleted Author',
      updatedAt: t(0),
    },
  ]);

  // Favorite order (newest first): ghost, author A, author B.
  await db.insert(favorites).values([
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorBId,
      createdAt: t(30_000),
    },
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorAId,
      createdAt: t(20_000),
    },
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: ghostId,
      createdAt: t(10_000),
    },
  ]);

  // The ghost deletes its account. Account deletion removes the user row
  // and never touches Favorite (no FK, no explicit cleanup), so the
  // favorite row above survives pointing at a profile that is gone.
  await db.delete(users).where(eq(users.id, ghostId));
});

afterAll(async () => {
  await db.delete(favorites).where(eq(favorites.userId, viewerId));
  await db
    .delete(users)
    .where(inArray(users.id, [viewerId, authorAId, authorBId]));
});

describe('GET /api/profiles/favorites with an orphaned favorite', () => {
  it('counts only favorites whose profile still exists', async () => {
    const { status, body } = await fetchFavorites();
    expect(status).toBe(200);
    expect(body.profiles.map((p) => p.id).sort()).toEqual(
      [authorAId, authorBId].sort()
    );
    // The orphaned favorite must not inflate the totals.
    expect(body.total).toBe(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.totalPages).toBe(1);
  });

  it('pages through exactly the surviving profiles, with no empty page', async () => {
    const seen: string[] = [];
    for (const page of [1, 2]) {
      const { status, body } = await fetchFavorites(`?limit=1&page=${page}`);
      expect(status).toBe(200);
      expect(body.total).toBe(2);
      expect(body.pagination.totalPages).toBe(2);
      expect(body.profiles).toHaveLength(1);
      seen.push(body.profiles[0]!.id);
    }
    // Newest surviving favorite first, and no duplicates across pages.
    expect(seen).toEqual([authorAId, authorBId]);
  });
});
