/**
 * GET /api/registry (the public user/agent directory) against a real
 * database: paging through the directory must reach every member the
 * reported total promises, exactly once.
 *
 * The route sorts by a single key — `sortBy` is one of createdAt (the
 * default), username, or nftTokenId (RegistryQuerySchema) — and cuts
 * pages with offset/limit. Two of those keys tie in ordinary data:
 *
 * - createdAt: users created in one batch share one timestamp. A single
 *   multi-row insert gets one Postgres `now()` (the transaction time),
 *   which is exactly how seed/operator batch creation writes rows. The
 *   fixture below inserts 30 users in one statement and asserts they
 *   share a single createdAt.
 * - nftTokenId: null for every account that never registered on-chain —
 *   the default state of nearly every account — so sorting by it pages
 *   through one large tie group.
 *
 * A single-key ORDER BY does not order tied rows, so each page's top-N
 * sort may pick a different subset of the tie group: some members appear
 * on two pages and some on none, while `pagination.total` still counts
 * them all. Sibling paged lists already carry a total order for this
 * reason — chat history pages by (createdAt, id) (#1690), the admin
 * group-messages list orders by [{ createdAt: 'desc' }, { id: 'desc' }],
 * and the favorites feed fixes carry the same tie-breaker.
 *
 * The route is exercised unmodified, imported directly. It is a public
 * route (publicRateLimit only), so no auth header is needed; rate
 * limiting is disabled through the supported test switch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

process.env.DISABLE_RATE_LIMITING = 'true';

type RegistryBody = {
  users: Array<{ id: string; username: string | null }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

let GET: typeof import('../../../apps/web/src/app/api/registry/route').GET;

async function fetchRegistry(qs: string): Promise<RegistryBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/registry?${qs}`)
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as RegistryBody;
}

/** Page through the whole directory at `limit`, collecting ids in order. */
async function traverse(qs: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const body = await fetchRegistry(`${qs}&limit=${limit}&offset=${offset}`);
    ids.push(...body.users.map((u) => u.id));
    if (!body.pagination.hasMore) break;
    offset += limit;
  }
  return ids;
}

const tieIds: string[] = [];

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/registry/route'));

  const raw = await Promise.all(
    Array.from({ length: 30 }, () => generateSnowflakeId())
  );
  tieIds.push(...raw);
  const now = new Date();
  // One multi-row insert: one statement, one transaction timestamp, so
  // every row shares createdAt — the batch-creation shape.
  await db.insert(users).values(
    raw.map((id, i) => ({
      id,
      username: `g31dir-${String(i).padStart(2, '0')}-${id.slice(-4)}`,
      updatedAt: now,
    }))
  );

  const rows = await db
    .select({ createdAt: users.createdAt, nftTokenId: users.nftTokenId })
    .from(users)
    .where(inArray(users.id, raw));
  // Fixture sanity: the tie groups the tests rely on really are ties.
  expect(new Set(rows.map((r) => r.createdAt.toISOString())).size).toBe(1);
  expect(rows.every((r) => r.nftTokenId === null)).toBe(true);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, tieIds));
});

describe('GET /api/registry — directory pagination reaches every member', () => {
  it('createdAt order: a full traversal returns each tied member exactly once and matches total', async () => {
    const first = await fetchRegistry(
      'sortBy=createdAt&sortOrder=desc&limit=5&offset=0'
    );
    const ids = await traverse('sortBy=createdAt&sortOrder=desc', 5);
    // The traversal is a partition of the directory the total describes.
    expect(ids.length).toBe(first.pagination.total);
    expect(new Set(ids).size).toBe(first.pagination.total);
    // In particular every batch-created (tied) member is reached.
    const seen = new Set(ids);
    for (const id of tieIds) expect(seen.has(id)).toBe(true);
  });

  it('nftTokenId order: paging through the null tie group reaches every member exactly once', async () => {
    const first = await fetchRegistry(
      'sortBy=nftTokenId&sortOrder=asc&limit=5&offset=0'
    );
    const ids = await traverse('sortBy=nftTokenId&sortOrder=asc', 5);
    expect(ids.length).toBe(first.pagination.total);
    expect(new Set(ids).size).toBe(first.pagination.total);
    const seen = new Set(ids);
    for (const id of tieIds) expect(seen.has(id)).toBe(true);
  });

  it('username order (unique key, control): traversal is complete', async () => {
    const ids = await traverse('sortBy=username&sortOrder=asc', 5);
    const seen = new Set(ids);
    expect(seen.size).toBe(ids.length);
    for (const id of tieIds) expect(seen.has(id)).toBe(true);
  });
});
