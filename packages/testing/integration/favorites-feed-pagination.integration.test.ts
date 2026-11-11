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

import {
  and,
  db,
  eq,
  favorites,
  gameOnboarding,
  inArray,
  posts,
  sql,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/posts/feed/favorites/route';
import { createStewardTestToken } from './helpers/steward-auth';

let viewerId: string;
let authorA: string;
let authorB: string;
let stewardUserId: string;
const tieIds: string[] = [];
const distinctIds: string[] = [];
const expectedOrder: string[] = [];

function ownership() {
  return {
    posts: new Map<string, typeof posts.$inferSelect>(),
    favorites: new Map<string, typeof favorites.$inferSelect>(),
    users: new Map<string, typeof users.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

function fixtureUser(
  id: string,
  label: string,
  stewardId: string | null = null
) {
  // Explicit millisecond timestamps round-trip through INSERT RETURNING.
  const now = new Date();
  return {
    id,
    username: 'g' + id,
    displayName: label,
    stewardId,
    isTest: false,
    isBanned: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(users).values(values).returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}

async function insertFavorites(
  values: Array<typeof favorites.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(favorites).values(values).returning();
  for (const row of rows) receipt.favorites.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Favorite RETURNING');
  return rows;
}

async function insertPosts(
  values: Array<typeof posts.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(posts).values(values).returning();
  for (const row of rows) receipt.posts.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Post RETURNING');
  return rows;
}

async function cleanup(receipt: Ownership) {
  // Delete only acquired, unchanged tuples, child-first. A conflicting insert
  // never enters these maps, and a failed child cleanup keeps its parent alive.
  for (const row of receipt.posts.values()) {
    await db
      .delete(posts)
      .where(
        and(
          eq(posts.id, row.id),
          sql`to_jsonb(${posts}) = to_jsonb(jsonb_populate_record(NULL::"Post", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, row.id));
    if (remaining.length) throw new Error(`Owned Post remains: ${row.id}`);
    receipt.posts.delete(row.id);
  }
  for (const row of receipt.favorites.values()) {
    await db
      .delete(favorites)
      .where(
        and(
          eq(favorites.id, row.id),
          sql`to_jsonb(${favorites}) = to_jsonb(jsonb_populate_record(NULL::"Favorite", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: favorites.id })
      .from(favorites)
      .where(eq(favorites.id, row.id));
    if (remaining.length) throw new Error(`Owned Favorite remains: ${row.id}`);
    receipt.favorites.delete(row.id);
  }
  for (const row of receipt.users.values()) {
    await db.delete(users).where(
      and(
        eq(users.id, row.id),
        sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${JSON.stringify(row)}::jsonb))`,
        sql`NOT EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.authorId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${favorites} WHERE ${favorites.userId} = ${row.id} OR ${favorites.targetUserId} = ${row.id})`,
        // Baseline User FKs can cascade-delete foreign rows or null their
        // attribution. Refuse every destructive reference before the DELETE.
        sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.grantedBy} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`
      )
    );
    const remaining = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, row.id));
    if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
    receipt.users.delete(row.id);
  }
}

type FeedPage = { ids: string[]; total: number; hasMore: boolean };

async function fetchPage(limit: number, page: number): Promise<FeedPage> {
  const token = await createStewardTestToken(stewardUserId);
  const request = new NextRequest(
    `http://localhost/api/posts/feed/favorites?limit=${limit}&page=${page}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data?: { posts: Array<{ id: string }>; total: number; hasMore: boolean };
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
  viewerId = await generateSnowflakeId();
  authorA = await generateSnowflakeId();
  authorB = await generateSnowflakeId();
  stewardUserId = 'g25-steward-' + viewerId;
  await insertUsers([
    fixtureUser(viewerId, 'G25 Viewer', stewardUserId),
    fixtureUser(authorA, 'G25 Author A'),
    fixtureUser(authorB, 'G25 Author B'),
  ]);
  const now = new Date();
  await insertFavorites([
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorA,
      createdAt: now,
    },
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorB,
      createdAt: now,
    },
  ]);
  for (let i = 0; i < 7; i++) tieIds.push(await generateSnowflakeId());
  for (let i = 0; i < 5; i++) distinctIds.push(await generateSnowflakeId());
  expectedOrder.push(...[...tieIds].sort().reverse(), ...distinctIds);
  const tieAt = new Date(now.getTime() - 2 * 60 * 60_000);
  const scrambled = [
    tieIds[3]!,
    tieIds[0]!,
    tieIds[6]!,
    tieIds[2]!,
    tieIds[5]!,
    tieIds[1]!,
    tieIds[4]!,
  ];
  await insertPosts(
    scrambled.map((id) => ({
      id,
      content: 'tie post ' + id,
      authorId: authorA,
      timestamp: tieAt,
      createdAt: tieAt,
    }))
  );
  await insertPosts(
    distinctIds.map((id, i) => {
      const at = new Date(tieAt.getTime() - (10 + i * 10) * 60_000);
      return {
        id,
        content: 'distinct post ' + id,
        authorId: authorB,
        timestamp: at,
        createdAt: at,
      };
    })
  );
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  await insertPosts([
    {
      id: await generateSnowflakeId(),
      content: 'deleted post',
      authorId: authorA,
      timestamp: hourAgo,
      createdAt: hourAgo,
      deletedAt: now,
    },
    {
      id: await generateSnowflakeId(),
      content: 'future post',
      authorId: authorA,
      timestamp: new Date(now.getTime() + 2 * 60 * 60_000),
      createdAt: hourAgo,
    },
  ]);
}

async function cleanupFixtures() {
  await cleanup(owned);
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
    expect(flat).toEqual(expectedOrder);
    expect(new Set(flat).size).toBe(12);
  });

  it('returns every visible post exactly once with pages of 2', async () => {
    const pages = await pageThrough(2);
    const flat = pages.flatMap((p) => p.ids);
    expect(pages).toHaveLength(6);
    expect(flat).toEqual(expectedOrder);
    expect(new Set(flat).size).toBe(12);
  });

  it('keeps total and hasMore truthful on a single full page and past the end', async () => {
    const full = await fetchPage(20, 1);
    expect(full.ids).toEqual(expectedOrder);
    expect(full.total).toBe(12);
    expect(full.hasMore).toBe(false);

    const pastEnd = await fetchPage(3, 9);
    expect(pastEnd.ids).toEqual([]);
    expect(pastEnd.total).toBe(12);
    expect(pastEnd.hasMore).toBe(false);
  });

  it('cleans partial setup without deleting colliding control rows', async () => {
    const existing = ownership();
    const partial = ownership();
    try {
      const sentinelUserId = await generateSnowflakeId();
      const partialUserId = await generateSnowflakeId();
      const [sentinelUser] = await insertUsers(
        [fixtureUser(sentinelUserId, 'G25 sentinel')],
        existing
      );
      const now = new Date();
      const [sentinelFavorite] = await insertFavorites(
        [
          {
            id: await generateSnowflakeId(),
            userId: sentinelUserId,
            targetUserId: authorA,
            createdAt: now,
          },
        ],
        existing
      );
      const [sentinelPost] = await insertPosts(
        [
          {
            id: await generateSnowflakeId(),
            authorId: sentinelUserId,
            content: 'G25 pre-existing post',
            timestamp: now,
            createdAt: now,
          },
        ],
        existing
      );
      if (!sentinelUser || !sentinelFavorite || !sentinelPost)
        throw new Error('Missing collision control');

      await insertUsers(
        [fixtureUser(partialUserId, 'G25 partial setup')],
        partial
      );
      const [partialFavorite] = await insertFavorites(
        [
          {
            id: await generateSnowflakeId(),
            userId: partialUserId,
            targetUserId: authorA,
            createdAt: now,
          },
        ],
        partial
      );
      const firstBatch = await insertPosts(
        [
          {
            id: await generateSnowflakeId(),
            authorId: partialUserId,
            content: 'G25 acquired first batch A',
            timestamp: now,
            createdAt: now,
          },
          {
            id: await generateSnowflakeId(),
            authorId: partialUserId,
            content: 'G25 acquired first batch B',
            timestamp: now,
            createdAt: now,
          },
        ],
        partial
      );
      if (!partialFavorite) throw new Error('Missing partial setup favorite');

      // Exercise the actual acquisition helpers, not a copy of their logic.
      // Each later insert has distinct non-ID unique fields; its proposed ID
      // is the only conflict, and successful earlier inserts remain owned.
      await expect(
        insertPosts(
          [
            {
              ...sentinelPost,
              authorId: partialUserId,
              content: 'Rejected second batch',
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertFavorites(
          [
            {
              ...sentinelFavorite,
              userId: partialUserId,
              targetUserId: authorB,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertUsers(
          [{ ...sentinelUser, username: 'g' + (await generateSnowflakeId()) }],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });

      await cleanup(partial);
      expect(
        await db
          .select()
          .from(posts)
          .where(
            inArray(
              posts.id,
              firstBatch.map((row) => row.id)
            )
          )
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(favorites)
          .where(eq(favorites.id, partialFavorite.id))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, partialUserId))
      ).toEqual([]);
      expect(
        await db.select().from(posts).where(eq(posts.id, sentinelPost.id))
      ).toEqual([sentinelPost]);
      expect(
        await db
          .select()
          .from(favorites)
          .where(eq(favorites.id, sentinelFavorite.id))
      ).toEqual([sentinelFavorite]);
      expect(
        await db.select().from(users).where(eq(users.id, sentinelUser.id))
      ).toEqual([sentinelUser]);
    } finally {
      try {
        await cleanup(partial);
      } finally {
        await cleanup(existing);
      }
    }
  });

  it('refuses User cleanup across every destructive foreign reference', async () => {
    // These four control rows belong to separate receipts, not to any subject
    // User receipt. User cleanup must preserve both cascades and attribution.
    const subjects = Array.from({ length: 5 }, () => ownership());
    const subjectRows: Array<typeof users.$inferSelect> = [];
    const controls = {
      onboarding: new Map<string, typeof gameOnboarding.$inferSelect>(),
      snapshots: new Map<string, typeof userPnLSnapshots.$inferSelect>(),
      whitelist: new Map<string, typeof whitelist.$inferSelect>(),
      config: new Map<string, typeof whitelistConfig.$inferSelect>(),
    };
    function acquire<T extends { id: string }>(
      receipt: Map<string, T>,
      rows: T[]
    ) {
      for (const row of rows) receipt.set(row.id, row);
      if (rows.length !== 1)
        throw new Error('Incomplete foreign control RETURNING');
    }
    async function expectControlsUnchanged() {
      expect(
        await db
          .select()
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.id, [...controls.onboarding.keys()]))
      ).toEqual([...controls.onboarding.values()]);
      expect(
        await db
          .select()
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.id, [...controls.snapshots.keys()]))
      ).toEqual([...controls.snapshots.values()]);
      expect(
        await db
          .select()
          .from(whitelist)
          .where(inArray(whitelist.id, [...controls.whitelist.keys()]))
      ).toEqual([...controls.whitelist.values()]);
      expect(
        await db
          .select()
          .from(whitelistConfig)
          .where(inArray(whitelistConfig.id, [...controls.config.keys()]))
      ).toEqual([...controls.config.values()]);
    }
    async function cleanupControls() {
      for (const row of controls.onboarding.values()) {
        await db
          .delete(gameOnboarding)
          .where(
            and(
              eq(gameOnboarding.id, row.id),
              sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${JSON.stringify(row)}::jsonb))`
            )
          );
        const remaining = await db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, row.id));
        if (remaining.length)
          throw new Error(
            `Foreign GameOnboarding control changed or remains: ${row.id}`
          );
        controls.onboarding.delete(row.id);
      }
      for (const row of controls.snapshots.values()) {
        await db
          .delete(userPnLSnapshots)
          .where(
            and(
              eq(userPnLSnapshots.id, row.id),
              sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${JSON.stringify(row)}::jsonb))`
            )
          );
        const remaining = await db
          .select({ id: userPnLSnapshots.id })
          .from(userPnLSnapshots)
          .where(eq(userPnLSnapshots.id, row.id));
        if (remaining.length)
          throw new Error(
            `Foreign UserPnLSnapshot control changed or remains: ${row.id}`
          );
        controls.snapshots.delete(row.id);
      }
      for (const row of controls.whitelist.values()) {
        await db
          .delete(whitelist)
          .where(
            and(
              eq(whitelist.id, row.id),
              sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${JSON.stringify(row)}::jsonb))`
            )
          );
        const remaining = await db
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(eq(whitelist.id, row.id));
        if (remaining.length)
          throw new Error(
            `Foreign Whitelist control changed or remains: ${row.id}`
          );
        controls.whitelist.delete(row.id);
      }
      for (const row of controls.config.values()) {
        await db
          .delete(whitelistConfig)
          .where(
            and(
              eq(whitelistConfig.id, row.id),
              sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${JSON.stringify(row)}::jsonb))`
            )
          );
        const remaining = await db
          .select({ id: whitelistConfig.id })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.id, row.id));
        if (remaining.length)
          throw new Error(
            `Foreign WhitelistConfig control changed or remains: ${row.id}`
          );
        controls.config.delete(row.id);
      }
    }
    try {
      for (const [index, receipt] of subjects.entries()) {
        const [row] = await insertUsers(
          [
            fixtureUser(
              await generateSnowflakeId(),
              'G25 referenced subject ' + index
            ),
          ],
          receipt
        );
        if (!row) throw new Error('Missing referenced subject RETURNING');
        subjectRows.push(row);
      }
      const now = new Date();
      acquire(
        controls.onboarding,
        await db
          .insert(gameOnboarding)
          .values({
            id: await generateSnowflakeId(),
            userId: subjectRows[0]!.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      );
      acquire(
        controls.snapshots,
        await db
          .insert(userPnLSnapshots)
          .values({
            id: await generateSnowflakeId(),
            userId: subjectRows[1]!.id,
            snapshotAt: now,
            createdAt: now,
          })
          .returning()
      );
      acquire(
        controls.whitelist,
        await db
          .insert(whitelist)
          .values({
            id: await generateSnowflakeId(),
            userId: subjectRows[2]!.id,
            grantedBy: subjectRows[3]!.id,
            source: 'admin_manual',
            reason: 'G25 separate foreign control',
            grantedAt: now,
          })
          .returning()
      );
      // A generated ID leaves the application singleton 'default' untouched.
      acquire(
        controls.config,
        await db
          .insert(whitelistConfig)
          .values({
            id: await generateSnowflakeId(),
            updatedBy: subjectRows[4]!.id,
            updatedAt: now,
          })
          .returning()
      );
      for (const [index, receipt] of subjects.entries()) {
        const row = subjectRows[index]!;
        await expect(cleanup(receipt)).rejects.toThrow(
          `Owned User remains: ${row.id}`
        );
        expect(receipt.users.get(row.id)).toEqual(row);
        expect(
          await db.select().from(users).where(eq(users.id, row.id))
        ).toEqual([row]);
        await expectControlsUnchanged();
      }
    } finally {
      // Prove the separately acquired controls are gone before deleting any
      // subjects. An uncertain control cleanup preserves all subject parents.
      await cleanupControls();
      for (const receipt of subjects) await cleanup(receipt);
    }
  });
});
