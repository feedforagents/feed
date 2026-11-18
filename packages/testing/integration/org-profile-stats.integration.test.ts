/**
 * Organization profile stats against a real database: the header "Posts"
 * count on an organization profile (/orgs/[id]) must count the posts that
 * same page lists.
 *
 * One user action: open an organization profile. ProfilePageClient renders
 * the posts tab from `GET /api/posts?actorId={org.id}` — posts authored
 * under the organization id, which is a real production path
 * (generateOrgPost writes `authorId: org.id`) — and the header counts from
 * `GET /api/actors/[actorId]/stats` with that same org id.
 *
 * The stats route resolves the org id to the organization's shadow actor
 * (orgs share a username with their official-voice actor, e.g. org
 * `teslai` vs actor `org-teslai`) and counts posts under the actor id
 * instead. The two reads are keyed differently, so the header count can
 * never describe the list below it: org-authored posts are not counted,
 * and shadow-actor posts the page never lists are. Follows are keyed by
 * the resolved actor id on both the write path (the follow route resolves
 * the same way) and this route, so the follower counts already agree and
 * are asserted unchanged.
 *
 * The identifiers are canonical registry entries, so the database may
 * already hold posts and follows for them. Assertions are therefore
 * baseline-relative: the pre-existing stats are captured through the
 * route before any fixture row is inserted, and each test expects exactly
 * the baseline plus the relations the fixture actually added. No
 * pre-existing record is deleted or reset to make the counts fit.
 *
 * Fixture rows are registered only after their INSERT succeeds
 * (RETURNING for users and posts; a follow pair that already exists is
 * reported as pre-existing instead of being claimed). Cleanup deletes
 * only owned rows and is safe after a partial setup: whatever was
 * registered is removed, nothing else. A collision control at the end
 * proves a failed insert registers nothing.
 *
 * The public stats route is exercised over real loopback HTTP with the
 * actual static registry and database. Full physical receipts, transactional
 * guards and a separate control lease preserve unrelated rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';

import {
  actorFollows,
  and,
  db,
  eq,
  gameOnboarding,
  inArray,
  posts,
  sql,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const database = new URL(DATABASE_URL);
const databasePort = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (databasePort === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      databasePort === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== DATABASE_URL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(BASE_URL);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
for (const configured of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (configured && new URL(configured).origin !== server.origin)
    throw new Error('Fixture HTTP origins must agree');
const StatsSchema = z.object({
  followers: z.number().int().nonnegative(),
  following: z.number().int().nonnegative(),
  posts: z.number().int().nonnegative(),
  actorFollowers: z.number().int().nonnegative(),
  userFollowers: z.number().int().nonnegative(),
});
const StatsResponseSchema = z.object({ stats: StatsSchema.optional() });
type StatsSnapshot = z.infer<typeof StatsSchema>;
const owned = {
  posts: new Map<string, string>(),
  userActorFollows: new Map<string, string>(),
  actorFollows: new Map<string, string>(),
  users: new Map<string, string>(),
};
const controls = {
  posts: new Map<string, string>(),
  userActorFollows: new Map<string, string>(),
  actorFollows: new Map<string, string>(),
  users: new Map<string, string>(),
};
const dependents = new Map<string, string>();
let viewerToken = '';
const viewerStewardId = crypto.randomUUID();

let orgId: string;
let shadowActorId: string;
let controlActorId: string;
let followerUserId: string;
let npcFollowerId: string;

// Only successful full physical RETURNING receipts enter these maps.
const ownedPostIds = owned.posts;
const ownedUserActorFollowIds = owned.userActorFollows;
const ownedActorFollowIds = owned.actorFollows;
const ownedUserIds = owned.users;

let baseOrgStats: StatsSnapshot;
let baseShadowStats: StatsSnapshot;
let baseControlStats: StatsSnapshot;
let orgActorFollowersAdded = 0;

async function fetchStats(identifier: string, token?: string) {
  const response = await fetch(
    `${BASE_URL}/api/actors/${encodeURIComponent(identifier)}/stats`,
    {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }
  );
  return {
    status: response.status,
    body: StatsResponseSchema.parse(await response.json()),
  };
}

async function snapshotStats(identifier: string): Promise<StatsSnapshot> {
  const { status, body } = await fetchStats(identifier);
  expect(status).toBe(200);
  if (!body?.stats) {
    throw new Error(`Stats snapshot for ${identifier} returned no stats`);
  }
  return body.stats;
}

async function insertPost(values: {
  content: string;
  authorId: string;
  timestamp: Date;
  createdAt: Date;
  deletedAt?: Date;
}): Promise<string> {
  const [created] = await db
    .insert(posts)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({
      id: posts.id,
      canonical: sql<string>`to_jsonb(${posts})::text`,
    });
  if (!created) {
    throw new Error('Fixture post insert returned no row');
  }
  ownedPostIds.set(created.id, created.canonical);
  return created.id;
}

async function insertUserActorFollow(values: {
  userId: string;
  actorId: string;
  createdAt: Date;
}): Promise<void> {
  const [created] = await db
    .insert(userActorFollows)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({
      id: userActorFollows.id,
      canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
    });
  if (!created) {
    throw new Error('Fixture user-actor follow insert returned no row');
  }
  ownedUserActorFollowIds.set(created.id, created.canonical);
}

/**
 * Insert an ActorFollow unless the pair already exists. Returns 'added'
 * when this call inserted (and registered) the row, 'existing' when a
 * pre-existing row already proves the relation — that row is not owned
 * and is left untouched by cleanup.
 */
async function insertActorFollow(values: {
  followerId: string;
  followingId: string;
  createdAt: Date;
}): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: actorFollows.id })
    .from(actorFollows)
    .where(
      and(
        eq(actorFollows.followerId, values.followerId),
        eq(actorFollows.followingId, values.followingId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const [created] = await db
    .insert(actorFollows)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({
      id: actorFollows.id,
      canonical: sql<string>`to_jsonb(${actorFollows})::text`,
    });
  if (!created) {
    throw new Error('Fixture actor follow insert returned no row');
  }
  ownedActorFollowIds.set(created.id, created.canonical);
  return 'added';
}

async function releaseDependents() {
  for (const [id, canonical] of dependents) {
    const removed = await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, id),
          sql`to_jsonb(${gameOnboarding}) = ${canonical}::text::jsonb`
        )
      )
      .returning({ id: gameOnboarding.id });
    if (removed.length !== 1)
      throw new Error('Owned onboarding cleanup refused');
    dependents.delete(id);
  }
}

async function cleanupOwnedFixtures(target = owned): Promise<void> {
  await db.transaction(async (tx) => {
    // Drain earlier FK writers before each guarded parent DELETE snapshot.
    for (const [table, receipts] of [
      [users, target.users],
      [posts, target.posts],
    ] as const) {
      const ids = [...receipts.keys()].sort();
      if (ids.length)
        await tx
          .select({ id: table.id })
          .from(table)
          .where(inArray(table.id, ids))
          .orderBy(table.id)
          .for('update');
    }
    for (const [table, receipts, label] of [
      [userActorFollows, target.userActorFollows, 'UserActorFollow'],
      [actorFollows, target.actorFollows, 'ActorFollow'],
      [posts, target.posts, 'Post'],
      [users, target.users, 'User'],
    ] as const) {
      for (const [id, canonical] of receipts) {
        const guard =
          table === users
            ? sql`NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"=${users.id})
            AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"=${users.id})
            AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"=${users.id} OR x."grantedBy"=${users.id})
            AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"=${users.id})
            AND NOT EXISTS(SELECT 1 FROM "UserActorFollow" x WHERE x."userId"=${users.id})
            AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"=${users.id})`
            : table === posts
              ? sql`NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."postId"=${posts.id})
              AND NOT EXISTS(SELECT 1 FROM "Reaction" x WHERE x."postId"=${posts.id})
              AND NOT EXISTS(SELECT 1 FROM "Share" x WHERE x."postId"=${posts.id})
              AND NOT EXISTS(SELECT 1 FROM "PostTag" x WHERE x."postId"=${posts.id})
              AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."originalPostId"=${posts.id} OR x."commentOnPostId"=${posts.id} OR x."parentCommentId"=${posts.id})`
              : sql`true`;
        const removed = await tx
          .delete(table)
          .where(
            and(
              eq(table.id, id),
              sql`to_jsonb(${table}) = ${canonical}::text::jsonb`,
              guard
            )
          )
          .returning({ id: table.id });
        if (removed.length !== 1)
          throw new Error(`Owned ${label} cleanup refused`);
      }
    }
  });
  for (const receipts of Object.values(target)) receipts.clear();
}

beforeAll(async () => {
  const org =
    StaticDataRegistry.getOrganization('teslai') ??
    StaticDataRegistry.getAllOrganizations()[0];
  if (!org) throw new Error('static registry returned no organization');
  orgId = org.id;

  // The org's official-voice actor: the route resolves the org id to this
  // actor through the shared username.
  const shadow = StaticDataRegistry.getActor(orgId);
  if (!shadow) throw new Error('org has no shadow actor in the registry');
  shadowActorId = shadow.id;

  const controlActor = StaticDataRegistry.getAllActors().find(
    (a) => a.id !== shadowActorId
  );
  if (!controlActor) throw new Error('static registry returned no actor');
  controlActorId = controlActor.id;
  npcFollowerId =
    StaticDataRegistry.getAllActors().find(
      (a) => a.id !== shadowActorId && a.id !== controlActorId
    )?.id ?? '';
  if (!npcFollowerId)
    throw new Error('Static registry returned no NPC follower');

  // Baselines: whatever the canonical identifiers already have in this
  // database is captured before the fixture adds anything.
  baseOrgStats = await snapshotStats(orgId);
  baseShadowStats = await snapshotStats(shadowActorId);
  baseControlStats = await snapshotStats(controlActorId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  const followerCandidateId = await generateSnowflakeId();
  const [createdFollower] = await db
    .insert(users)
    .values({
      id: followerCandidateId,
      stewardId: viewerStewardId,
      username: `f55-${followerCandidateId}`,
      displayName: 'F55 Fixture Follower',
      updatedAt: now,
    })
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  if (!createdFollower) {
    throw new Error('Fixture follower insert returned no row');
  }
  ownedUserIds.set(createdFollower.id, createdFollower.canonical);
  viewerToken = await createStewardTestToken(viewerStewardId);
  followerUserId = createdFollower.id;

  // Posts authored under the organization id (the generateOrgPost path):
  // two visible, one soft-deleted, one future-dated. The org page's posts
  // tab can only ever show the two visible ones.
  await insertPost({
    content: 'org visible post one',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
  });
  await insertPost({
    content: 'org visible post two',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
  });
  await insertPost({
    content: 'org soft-deleted post',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
    deletedAt: past,
  });
  await insertPost({
    content: 'org future post that must not be hinted at',
    authorId: orgId,
    timestamp: future,
    createdAt: past,
  });

  // One visible post authored under the shadow actor id. It belongs to
  // the actor profile (/actors/{shadowId}), not to the org page's list.
  await insertPost({
    content: 'shadow actor visible post',
    authorId: shadowActorId,
    timestamp: past,
    createdAt: past,
  });

  // Follows of the org's account land on the resolved (shadow) actor id —
  // the follow route resolves the org id the same way — one user follow
  // and one NPC follow.
  await insertUserActorFollow({
    userId: followerUserId,
    actorId: shadowActorId,
    createdAt: past,
  });
  if (
    (await insertActorFollow({
      followerId: npcFollowerId,
      followingId: shadowActorId,
      createdAt: past,
    })) === 'added'
  ) {
    orgActorFollowersAdded += 1;
  }

  // Control: an unrelated actor authored one visible post and has the
  // same user following it. Actor stats already work and must not change.
  await insertPost({
    content: 'control actor visible post',
    authorId: controlActorId,
    timestamp: past,
    createdAt: past,
  });
  await insertUserActorFollow({
    userId: followerUserId,
    actorId: controlActorId,
    createdAt: past,
  });
});

afterAll(async () => {
  await releaseDependents();
  await cleanupOwnedFixtures();
  await cleanupOwnedFixtures(controls);
});

describe('organization profile stats', () => {
  it('counts the posts the organization page lists, under the org id', async () => {
    const { status, body } = await fetchStats(orgId);
    expect(status).toBe(200);
    // The org page lists the two visible org-authored posts on top of
    // whatever the org already had; the header must not report the
    // shadow actor's count instead.
    expect(body?.stats?.posts).toBe(baseOrgStats.posts + 2);
    const signedViewer = await fetchStats(orgId, viewerToken);
    expect(signedViewer.status).toBe(200);
    expect(signedViewer.body).toEqual(body);
    // Follows already agree (both paths key by the resolved actor id).
    expect(body?.stats?.userFollowers).toBe(baseOrgStats.userFollowers + 1);
    expect(body?.stats?.actorFollowers).toBe(
      baseOrgStats.actorFollowers + orgActorFollowersAdded
    );
    expect(body?.stats?.followers).toBe(
      baseOrgStats.followers + 1 + orgActorFollowersAdded
    );
    expect(body?.stats?.following).toBe(baseOrgStats.following);
  });

  it('still returns the shadow actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(shadowActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(baseShadowStats.posts + 1);
    expect(body?.stats?.followers).toBe(
      baseShadowStats.followers + 1 + orgActorFollowersAdded
    );
  });

  it('still returns unrelated actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(controlActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(baseControlStats.posts + 1);
    expect(body?.stats?.userFollowers).toBe(baseControlStats.userFollowers + 1);
    expect(body?.stats?.followers).toBe(baseControlStats.followers + 1);
  });

  it('still errors for an unknown identifier (control)', async () => {
    const { status, body } = await fetchStats('f55-no-such-entity');
    expect(status).toBe(400);
    expect(body?.stats).toBeUndefined();
  });

  it('fixture ownership: colliding inserts register nothing and cleanup leaves pre-existing rows untouched', async () => {
    const victimAuthorId = await generateSnowflakeId();
    const [author] = await db
      .insert(users)
      .values({
        id: victimAuthorId,
        username: `f55-victim-${victimAuthorId}`,
        updatedAt: new Date(),
      })
      .returning({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      });
    if (!author) throw new Error('Control User RETURNING missing');
    controls.users.set(author.id, author.canonical);
    const [post] = await db
      .insert(posts)
      .values({
        id: await generateSnowflakeId(),
        authorId: author.id,
        content: 'f55 pre-existing post',
        timestamp: new Date(),
        createdAt: new Date(),
      })
      .returning({
        id: posts.id,
        canonical: sql<string>`to_jsonb(${posts})::text`,
      });
    if (!post) throw new Error('Control Post RETURNING missing');
    controls.posts.set(post.id, post.canonical);
    const [follow] = await db
      .insert(userActorFollows)
      .values({
        id: await generateSnowflakeId(),
        userId: author.id,
        actorId: controlActorId,
      })
      .returning({
        id: userActorFollows.id,
        canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
      });
    if (!follow) throw new Error('Control Follow RETURNING missing');
    controls.userActorFollows.set(follow.id, follow.canonical);
    const userBefore = [...ownedUserIds];
    try {
      await assert.rejects(
        async () => {
          await db
            .insert(posts)
            .values({
              id: post.id,
              authorId: author.id,
              content: 'collision',
              timestamp: new Date(),
            })
            .returning({ id: posts.id });
        },
        (error: Error) => {
          const cause = 'cause' in error ? error.cause : error;
          return (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === '23505' &&
            'constraint_name' in cause &&
            cause.constraint_name === 'Post_pkey'
          );
        }
      );
      expect(ownedPostIds.has(post.id)).toBe(false);
      await assert.rejects(
        async () => {
          await db
            .insert(userActorFollows)
            .values({
              id: follow.id,
              userId: author.id,
              actorId: shadowActorId,
            })
            .returning({ id: userActorFollows.id });
        },
        (error: Error) => {
          const cause = 'cause' in error ? error.cause : error;
          return (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            cause.code === '23505' &&
            'constraint_name' in cause &&
            cause.constraint_name === 'UserActorFollow_pkey'
          );
        }
      );
      expect(ownedUserActorFollowIds.has(follow.id)).toBe(false);
      const [child] = await db
        .insert(gameOnboarding)
        .values({ id: await generateSnowflakeId(), userId: followerUserId })
        .returning({
          id: gameOnboarding.id,
          canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
        });
      if (!child) throw new Error('Control onboarding RETURNING missing');
      dependents.set(child.id, child.canonical);
      await expect(cleanupOwnedFixtures()).rejects.toThrow(
        'Owned User cleanup refused'
      );
      expect([...ownedUserIds]).toEqual(userBefore);
      const remainingFollow = await db
        .select({ id: userActorFollows.id })
        .from(userActorFollows)
        .where(
          inArray(userActorFollows.id, [...ownedUserActorFollowIds.keys()])
        );
      expect(remainingFollow).toHaveLength(ownedUserActorFollowIds.size);
      const [retainedChild] = await db
        .select({ canonical: sql<string>`to_jsonb(${gameOnboarding})::text` })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, child.id));
      expect(retainedChild?.canonical).toBe(child.canonical);
      await releaseDependents();
      await cleanupOwnedFixtures();
      for (const [table, receipt] of [
        [users, author],
        [posts, post],
        [userActorFollows, follow],
      ] as const) {
        const [current] = await db
          .select({ canonical: sql<string>`to_jsonb(${table})::text` })
          .from(table)
          .where(eq(table.id, receipt.id));
        expect(current?.canonical).toBe(receipt.canonical);
      }
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, followerUserId))
      ).toEqual([]);
    } finally {
      await releaseDependents();
      await cleanupOwnedFixtures(controls);
    }
  });
});
