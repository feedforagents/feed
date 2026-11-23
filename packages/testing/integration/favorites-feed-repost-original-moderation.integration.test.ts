/**
 * Integration test — Favorites feed hides reposts of excluded originals
 *
 * @route GET /api/posts/feed/favorites
 *
 * Real-database test: a simple repost is only its original, so when the
 * viewer blocked or muted the original author (or the original author
 * blocked the viewer), the repost must not appear in the viewer's
 * favorites feed — the same rule the main feed applies in SQL before the
 * page is cut (postFeedVisibilityConditions, excludeModeratedReposts;
 * PRD §12, MVP Phase 5). Quotes keep their row: the viewer wrote their
 * own commentary, so only the original is hidden. A simple repost of a
 * soft-deleted original is excluded too (excludeDeadReposts), matching
 * the main feed. The total count must cover exactly the visible rows, so
 * the same conditions apply to the count query.
 *
 * Fixture: the viewer favorites one author (owner). Owner posts one
 * visible post, simple reposts of a blocked / muted / blocking author's
 * originals, a quote of the blocked author's original, a simple repost
 * of a visible author's original, and a simple repost of a soft-deleted
 * original. Only the visible post, the quote and the visible repost may
 * be returned, and total must be 3.
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
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/posts/feed/favorites/route';
import { fixtureRowJson } from './helpers/fixture-row-json';
import { createStewardTestToken } from './helpers/steward-auth';

let viewerId: string;
let ownerId: string;
let stewardUserId: string;

function ownership() {
  return {
    posts: new Map<string, typeof posts.$inferSelect>(),
    favorites: new Map<string, typeof favorites.$inferSelect>(),
    userBlocks: new Map<string, typeof userBlocks.$inferSelect>(),
    userMutes: new Map<string, typeof userMutes.$inferSelect>(),
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

async function insertBlocks(
  values: Array<typeof userBlocks.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userBlocks).values(values).returning();
  for (const row of rows) receipt.userBlocks.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserBlock RETURNING');
  return rows;
}

async function insertMutes(
  values: Array<typeof userMutes.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userMutes).values(values).returning();
  for (const row of rows) receipt.userMutes.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserMute RETURNING');
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
    if (remaining.length)
      throw new Error(`Owned Favorite remains: ${row.id}`);
    receipt.favorites.delete(row.id);
  }
  // Block/mute rows carry unique snowflake ids created by this fixture;
  // delete by id (no other test can own the same id).
  for (const row of receipt.userBlocks.values()) {
    await db.delete(userBlocks).where(eq(userBlocks.id, row.id));
    const remaining = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(eq(userBlocks.id, row.id));
    if (remaining.length)
      throw new Error(`Owned UserBlock remains: ${row.id}`);
    receipt.userBlocks.delete(row.id);
  }
  for (const row of receipt.userMutes.values()) {
    await db.delete(userMutes).where(eq(userMutes.id, row.id));
    const remaining = await db
      .select({ id: userMutes.id })
      .from(userMutes)
      .where(eq(userMutes.id, row.id));
    if (remaining.length)
      throw new Error(`Owned UserMute remains: ${row.id}`);
    receipt.userMutes.delete(row.id);
  }
  for (const row of receipt.users.values()) {
    await db.delete(users).where(
      and(
        eq(users.id, row.id),
        sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${fixtureRowJson('User', row)}::jsonb))`,
        sql`NOT EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.authorId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${favorites} WHERE ${favorites.userId} = ${row.id} OR ${favorites.targetUserId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE ${userBlocks.blockerId} = ${row.id} OR ${userBlocks.blockedId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userMutes} WHERE ${userMutes.muterId} = ${row.id} OR ${userMutes.mutedId} = ${row.id})`,
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

async function insertFixtures() {
  viewerId = await generateSnowflakeId();
  ownerId = await generateSnowflakeId();
  const normalId = await generateSnowflakeId();
  const blockedId = await generateSnowflakeId();
  const mutedId = await generateSnowflakeId();
  const blockingId = await generateSnowflakeId();
  stewardUserId = 'ffav-steward-' + viewerId;
  await insertUsers([
    fixtureUser(viewerId, 'FFav Viewer', stewardUserId),
    fixtureUser(ownerId, 'FFav Owner'),
    fixtureUser(normalId, 'FFav Normal'),
    fixtureUser(blockedId, 'FFav Blocked'),
    fixtureUser(mutedId, 'FFav Muted'),
    fixtureUser(blockingId, 'FFav Blocking'),
  ]);
  const now = new Date();
  await insertFavorites([
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: ownerId,
      createdAt: now,
    },
  ]);
  await insertBlocks([
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId,
    },
    {
      id: await generateSnowflakeId(),
      blockerId: blockingId,
      blockedId: viewerId,
    },
  ]);
  await insertMutes([
    {
      id: await generateSnowflakeId(),
      muterId: viewerId,
      mutedId,
    },
  ]);
  const older = new Date(now.getTime() - 3_600_000);
  await insertPosts([
    {
      id: 'normal-original',
      content: 'Fixture original by visible author',
      authorId: normalId,
      timestamp: new Date(older.getTime() - 1000),
      createdAt: new Date(older.getTime() - 1000),
    },
    {
      id: 'blocked-original',
      content: 'Fixture original by blocked author',
      authorId: blockedId,
      timestamp: new Date(older.getTime() - 2000),
      createdAt: new Date(older.getTime() - 2000),
    },
    {
      id: 'muted-original',
      content: 'Fixture original by muted author',
      authorId: mutedId,
      timestamp: new Date(older.getTime() - 3000),
      createdAt: new Date(older.getTime() - 3000),
    },
    {
      id: 'blocking-original',
      content: 'Fixture original by blocking author',
      authorId: blockingId,
      timestamp: new Date(older.getTime() - 4000),
      createdAt: new Date(older.getTime() - 4000),
    },
    {
      id: 'dead-original',
      content: 'Fixture original, later deleted',
      authorId: normalId,
      timestamp: new Date(older.getTime() - 5000),
      createdAt: new Date(older.getTime() - 5000),
      deletedAt: now,
    },
  ]);
  const ownerPosts = [
    { id: 'visible-post', content: 'Visible post' },
    { id: 'blocked-repost', content: '', originalPostId: 'blocked-original' },
    { id: 'muted-repost', content: '', originalPostId: 'muted-original' },
    {
      id: 'blocking-repost',
      content: '',
      originalPostId: 'blocking-original',
    },
    {
      id: 'blocked-quote',
      content: 'Visible quote commentary',
      originalPostId: 'blocked-original',
    },
    { id: 'normal-repost', content: '', originalPostId: 'normal-original' },
    { id: 'dead-repost', content: '', originalPostId: 'dead-original' },
  ];
  await insertPosts(
    ownerPosts.map((row, index) => {
      const at = new Date(now.getTime() - (index + 1) * 1000);
      return {
        ...row,
        authorId: ownerId,
        timestamp: at,
        createdAt: at,
      };
    })
  );
}

async function cleanupFixtures() {
  await cleanup(owned);
}

describe('GET /api/posts/feed/favorites repost moderation', () => {
  beforeAll(insertFixtures);
  afterAll(cleanupFixtures);

  it('hides simple reposts of excluded and deleted originals but keeps quotes and visible reposts', async () => {
    const page = await fetchPage(20, 1);
    expect(page.ids).toContain('visible-post');
    expect(page.ids).toContain('blocked-quote');
    expect(page.ids).toContain('normal-repost');
    expect(page.ids).not.toContain('blocked-repost');
    expect(page.ids).not.toContain('muted-repost');
    expect(page.ids).not.toContain('blocking-repost');
    expect(page.ids).not.toContain('dead-repost');
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
  });
});
