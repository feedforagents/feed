/** PRD §12, MVP Phase 5: organization aliases share canonical follow reads. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  actorFollows,
  and,
  db,
  eq,
  follows,
  gameOnboarding,
  inArray,
  sql,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import { z } from 'zod';

const databaseUrl = process.env.DATABASE_URL ?? '';
const database = new URL(databaseUrl);
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
  process.env.DIRECT_DATABASE_URL !== databaseUrl ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(base);
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
const getFollowers = 'followers';
const getFollowing = 'following';
function registry() {
  return {
    users: new Map<string, string>(),
    follows: new Map<string, string>(),
    userActorFollows: new Map<string, string>(),
    actorFollows: new Map<string, string>(),
  };
}
const owned = registry();
async function fresh() {
  const id = await generateSnowflakeId();
  if (!isValidSnowflakeId(id)) throw new Error('Invalid generated fixture ID');
  return id;
}
beforeAll(async () => {
  const identity = z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        port: z.coerce.number(),
        primary: z.boolean(),
      })
    )
    .parse(
      Array.from(
        await db.execute(sql`
      SELECT current_database() AS name,current_user AS role,
        inet_server_port() AS port,NOT pg_is_in_recovery() AS primary
    `)
      )
    )[0];
  if (
    !identity ||
    identity.name !== database.pathname.slice(1) ||
    identity.role !== database.username ||
    identity.port !== Number(databasePort) ||
    !identity.primary
  )
    throw new Error('Disposable database identity mismatch');
});
// Organization whose shadow actor username ('amAIzon') differs from the org
// ID, so the list routes cannot resolve it; its stats still resolve through
// the stats route's actor-name fallback (actor name 'AImazon').
const ORG_LIST_BROKEN = 'aimazon';
const ORG_LIST_BROKEN_ACTOR = 'org-aimazon';
// Organization that fails even the stats route's name fallback
// (actor username 'AIrk', actor name does not lowercase to the org ID).
const ORG_ALL_BROKEN = 'airk-invest';
const ORG_ALL_BROKEN_ACTOR = 'org-airk-invest';
// Control organization whose shadow actor username ('teslAI') happens to
// equal the org ID, so every surface already resolves on the base.
const ORG_OK = 'teslai';
const ORG_OK_ACTOR = 'org-teslai';

const ACTOR_FOLLOWER = 'ailon-musk';

let runId: string;
const humanIds: string[] = [];
const actorFollowIds: string[] = [];
const userActorFollowIds: string[] = [];
const followIds: string[] = [];
const createdNpcUserIds: string[] = [];

async function insertHuman(usernameSuffix: string): Promise<string> {
  const [created] = await db
    .insert(users)
    .values({
      id: await fresh(),
      username: `of69-${runId.slice(-10)}-${usernameSuffix}`,
      displayName: 'Org follow fixture',
      updatedAt: new Date(),
    })
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  if (!created) {
    throw new Error('Fixture user insert returned no row');
  }
  owned.users.set(created.id, created.canonical);
  humanIds.push(created.id);
  return created.id;
}

/**
 * Insert a UserActorFollow unless the pair already exists. Returns 'added'
 * when this call inserted (and registered) the row, 'existing' when a
 * pre-existing row already proves the relation — that row is not owned and
 * is left untouched by cleanup.
 */
async function userFollowsActor(
  userId: string,
  actorId: string
): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: userActorFollows.id })
    .from(userActorFollows)
    .where(
      and(
        eq(userActorFollows.userId, userId),
        eq(userActorFollows.actorId, actorId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const id = `uaf-${runId}-${userActorFollowIds.length}`;
  const [created] = await db
    .insert(userActorFollows)
    .values({ id, userId, actorId })
    .returning({
      id: userActorFollows.id,
      canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
    });
  if (!created) throw new Error('Fixture follow insert returned no row');
  owned.userActorFollows.set(created.id, created.canonical);
  userActorFollowIds.push(id);
  return 'added';
}

/** Same ownership contract as userFollowsActor, for ActorFollow pairs. */
async function actorFollowsActor(
  followerId: string,
  followingId: string
): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: actorFollows.id })
    .from(actorFollows)
    .where(
      and(
        eq(actorFollows.followerId, followerId),
        eq(actorFollows.followingId, followingId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const id = `af-${runId}-${actorFollowIds.length}`;
  const [created] = await db
    .insert(actorFollows)
    .values({ id, followerId, followingId })
    .returning({
      id: actorFollows.id,
      canonical: sql<string>`to_jsonb(${actorFollows})::text`,
    });
  if (!created) throw new Error('Fixture actor follow insert returned no row');
  owned.actorFollows.set(created.id, created.canonical);
  actorFollowIds.push(id);
  return 'added';
}

interface ListPayload {
  count?: number;
  followers?: Array<{ id: string }>;
  following?: Array<{ id: string }>;
}

const listSchema = z.object({
  count: z.number().int().nonnegative(),
  followers: z.array(z.object({ id: z.string() })).optional(),
  following: z.array(z.object({ id: z.string() })).optional(),
});
async function readList(
  handler: 'followers' | 'following',
  identifier: string,
  kind: 'followers' | 'following'
): Promise<{ status: number; payload: ListPayload }> {
  if (handler !== kind) throw new Error('Fixture list handler mismatch');
  const entries: Array<{ id: string }> = [];
  let total: number | null = null;
  // Follow the existing page contract so pre-existing members beyond page1
  // do not become a false fixture mismatch after adding owned relations.
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetch(
      `${base}/api/users/${encodeURIComponent(identifier)}/${kind}?page=${page}&limit=100`,
      {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      }
    );
    if (response.status !== 200)
      return { status: response.status, payload: {} };
    const body = z
      .union([z.object({ data: listSchema }), listSchema])
      .parse(await response.json());
    const payload = 'data' in body ? body.data : body;
    total ??= payload.count;
    if (payload.count !== total)
      throw new Error('Follow fixture membership changed during page walk');
    const current =
      kind === 'followers' ? payload.followers : payload.following;
    if (!current) throw new Error('Follow fixture response omitted list');
    entries.push(...current);
    if (entries.length === total)
      return {
        status: response.status,
        payload:
          kind === 'followers'
            ? { count: total, followers: entries }
            : { count: total, following: entries },
      };
    if (!current.length || entries.length > total)
      throw new Error('Follow fixture pagination mismatch');
  }
  throw new Error('Disposable follow fixture exceeded bounded page walk');
}

interface ListSnapshot {
  count: number;
  ids: string[];
}

async function snapshotList(
  handler: 'followers' | 'following',
  identifier: string,
  kind: 'followers' | 'following'
): Promise<ListSnapshot> {
  const { status, payload } = await readList(handler, identifier, kind);
  expect(status).toBe(200);
  const entries = kind === 'followers' ? payload.followers : payload.following;
  return { count: payload.count ?? 0, ids: (entries ?? []).map((e) => e.id) };
}

async function readStats(
  identifier: string
): Promise<{ status: number; followers?: number; following?: number }> {
  const response = await fetch(
    `${base}/api/actors/${encodeURIComponent(identifier)}/stats`,
    { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) }
  );
  if (response.status !== 200) return { status: response.status };
  const stats = z.object({ followers: z.number(), following: z.number() });
  const body = z
    .union([z.object({ data: z.object({ stats }) }), z.object({ stats })])
    .parse(await response.json());
  return {
    status: response.status,
    ...('data' in body ? body.data.stats : body.stats),
  };
}

function expectListEquals(
  payload: ListPayload,
  kind: 'followers' | 'following',
  expected: ListSnapshot
) {
  const entries = kind === 'followers' ? payload.followers : payload.following;
  const ids = (entries ?? []).map((e) => e.id);
  expect(payload.count).toBe(expected.count);
  expect(new Set(ids)).toEqual(new Set(expected.ids));
}

function plusRelations(
  base: ListSnapshot,
  addedCount: number,
  memberIds: string[]
): ListSnapshot {
  return {
    count: base.count + addedCount,
    ids: [...new Set([...base.ids, ...memberIds])],
  };
}

async function cleanup(target = owned): Promise<void> {
  if (!Object.values(target).some((rows) => rows.size)) return;
  await db.transaction(async (tx) => {
    const ids = [...target.users.keys()].sort();
    if (ids.length)
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, ids))
        .orderBy(users.id)
        .for('update');
    for (const [table, receipts, label] of [
      [userActorFollows, target.userActorFollows, 'UserActorFollow'],
      [actorFollows, target.actorFollows, 'ActorFollow'],
      [follows, target.follows, 'Follow'],
      [users, target.users, 'User'],
    ] as const)
      for (const [id, canonical] of receipts) {
        const guard =
          table === users
            ? sql`NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"=${users.id} OR x."grantedBy"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "UserActorFollow" x WHERE x."userId"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "Follow" x WHERE x."followerId"=${users.id} OR x."followingId"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "FollowStatus" x WHERE x."userId"=${users.id})
          AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"=${users.id})`
            : sql`true`;
        const removed = await tx
          .delete(table)
          .where(
            and(
              eq(table.id, id),
              sql`to_jsonb(${table})=${canonical}::text::jsonb`,
              guard
            )
          )
          .returning({ id: table.id });
        if (removed.length !== 1)
          throw new Error(`Owned ${label} cleanup refused`);
      }
  });
  for (const rows of Object.values(target)) rows.clear();
}
afterAll(async () => {
  await cleanup();
});

describe('organization follow lists by organization ID', () => {
  let aimazonHumanA: string;
  let aimazonHumanB: string;
  let airkHuman: string;
  let teslaiHuman: string;

  let baseAimazonFollowers: ListSnapshot;
  let baseAimazonFollowing: ListSnapshot;
  let baseAimazonStats: { followers: number; following: number };
  let baseAirkStatsFollowers: number;
  let baseAirkFollowers: ListSnapshot;
  let baseTeslaiFollowers: ListSnapshot;

  let aimazonFollowersAdded = 0;
  let aimazonFollowingAdded = 0;
  let teslaiFollowersAdded = 0;

  beforeAll(async () => {
    runId = await fresh();

    // Fixture actors must exist in the static registry (the list routes enrich
    // actor relations from it and drop unknown actors).
    for (const actorId of [
      ORG_LIST_BROKEN_ACTOR,
      ORG_ALL_BROKEN_ACTOR,
      ORG_OK_ACTOR,
      ACTOR_FOLLOWER,
    ]) {
      if (!StaticDataRegistry.getActor(actorId)) {
        throw new Error(
          `Fixture actor ${actorId} missing from static registry`
        );
      }
    }
    if (!StaticDataRegistry.getOrganization(ORG_LIST_BROKEN)) {
      throw new Error(`Fixture organization ${ORG_LIST_BROKEN} missing`);
    }
    if (!StaticDataRegistry.getOrganization(ORG_ALL_BROKEN)) {
      throw new Error(`Fixture organization ${ORG_ALL_BROKEN} missing`);
    }

    // Baselines: whatever relations already exist for these canonical
    // actors in this database are captured before the fixture adds its own.
    baseAimazonFollowers = await snapshotList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    baseAimazonFollowing = await snapshotList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );
    const aimazonStats = await readStats(ORG_LIST_BROKEN_ACTOR);
    expect(aimazonStats.status).toBe(200);
    baseAimazonStats = {
      followers: aimazonStats.followers ?? 0,
      following: aimazonStats.following ?? 0,
    };
    const airkStats = await readStats(ORG_ALL_BROKEN_ACTOR);
    expect(airkStats.status).toBe(200);
    baseAirkStatsFollowers = airkStats.followers ?? 0;
    baseAirkFollowers = await snapshotList(
      getFollowers,
      ORG_ALL_BROKEN_ACTOR,
      'followers'
    );
    baseTeslaiFollowers = await snapshotList(
      getFollowers,
      ORG_OK_ACTOR,
      'followers'
    );

    aimazonHumanA = await insertHuman('ha');
    aimazonHumanB = await insertHuman('hb');
    airkHuman = await insertHuman('hc');
    teslaiHuman = await insertHuman('hd');

    // Followers of the aimazon shadow actor: 2 humans + 2 actors.
    if (
      (await userFollowsActor(aimazonHumanA, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await userFollowsActor(aimazonHumanB, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_OK_ACTOR, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await actorFollowsActor(ACTOR_FOLLOWER, ORG_LIST_BROKEN_ACTOR)) ===
      'added'
    ) {
      aimazonFollowersAdded += 1;
    }

    // The aimazon shadow actor follows 2 actors.
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ACTOR_FOLLOWER)) ===
      'added'
    ) {
      aimazonFollowingAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ORG_OK_ACTOR)) === 'added'
    ) {
      aimazonFollowingAdded += 1;
      teslaiFollowersAdded += 1;
    }

    // One human follower for the other two organizations.
    await userFollowsActor(airkHuman, ORG_ALL_BROKEN_ACTOR);
    if ((await userFollowsActor(teslaiHuman, ORG_OK_ACTOR)) === 'added') {
      teslaiFollowersAdded += 1;
    }
  });

  it('ground truth: the shadow actor ID itself lists the followers', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAimazonFollowers, aimazonFollowersAdded, [
        aimazonHumanA,
        aimazonHumanB,
        ORG_OK_ACTOR,
        ACTOR_FOLLOWER,
      ])
    );
  });

  it('followers list loads by organization ID with the same members', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAimazonFollowers, aimazonFollowersAdded, [
        aimazonHumanA,
        aimazonHumanB,
        ORG_OK_ACTOR,
        ACTOR_FOLLOWER,
      ])
    );
  });

  it('following list loads by organization ID', async () => {
    const { status, payload } = await readList(
      getFollowing,
      ORG_LIST_BROKEN,
      'following'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'following',
      plusRelations(baseAimazonFollowing, aimazonFollowingAdded, [
        ACTOR_FOLLOWER,
        ORG_OK_ACTOR,
      ])
    );
  });

  it('header stats agree with the lists for the same organization', async () => {
    const stats = await readStats(ORG_LIST_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(
      baseAimazonStats.followers + aimazonFollowersAdded
    );
    expect(stats.following).toBe(
      baseAimazonStats.following + aimazonFollowingAdded
    );
  });

  it('stats and list both resolve for an organization without a name match', async () => {
    const stats = await readStats(ORG_ALL_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(baseAirkStatsFollowers + 1);

    const { status, payload } = await readList(
      getFollowers,
      ORG_ALL_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAirkFollowers, 1, [airkHuman])
    );
  });

  it('control: an organization that already resolves keeps working', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_OK,
      'followers'
    );
    expect(status).toBe(200);
    // The baseline members plus the fixture's additions: the human fixture
    // and the aimazon shadow actor, which follows this organization.
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseTeslaiFollowers, teslaiFollowersAdded, [
        teslaiHuman,
        ORG_LIST_BROKEN_ACTOR,
      ])
    );
  });

  it('unknown identifiers still return 404', async () => {
    const { status } = await readList(
      getFollowers,
      'no-such-org-or-user-69',
      'followers'
    );
    expect(status).toBe(404);
  });
});

describe('canonical NPC user row dispatch', () => {
  let baseFollowers: ListSnapshot;
  let baseFollowing: ListSnapshot;
  let dispatchHuman: string;
  let dispatchHumanFollower: string;
  let followerAdded = 0;
  let followingAdded = 0;

  beforeAll(async () => {
    // Pre-fixture state for the shadow actor, read through the routes. The
    // first describe's fixtures are part of this baseline; expectations
    // below are relative to it.
    baseFollowers = await snapshotList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    baseFollowing = await snapshotList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );

    // Ensure the canonical NPC User row exists, in the exact shape game
    // bootstrap creates (id and username are the actor ID, isActor set).
    // When the row already exists it is canonical data: it is used as-is
    // and never deleted by this fixture.
    const actor = StaticDataRegistry.getActor(ORG_LIST_BROKEN_ACTOR);
    if (!actor) {
      throw new Error(`Fixture actor ${ORG_LIST_BROKEN_ACTOR} missing`);
    }
    const [existingNpcRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);
    if (!existingNpcRow) {
      const now = new Date();
      const [created] = await db
        .insert(users)
        .values({
          id: actor.id,
          username: actor.id,
          displayName: actor.name,
          isActor: true,
          virtualBalance: '10000',
          totalDeposited: '10000',
          totalWithdrawn: '0',
          lifetimePnL: '0',
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: users.id,
          canonical: sql<string>`to_jsonb(${users})::text`,
        });
      if (!created) {
        throw new Error('Fixture NPC user insert returned no row');
      }
      owned.users.set(created.id, created.canonical);
      createdNpcUserIds.push(created.id);
    }

    dispatchHuman = await insertHuman('np');
    if (
      (await userFollowsActor(dispatchHuman, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      followerAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ORG_ALL_BROKEN_ACTOR)) ===
      'added'
    ) {
      followingAdded += 1;
    }

    // Ordinary human control: one fixture human follows another through the
    // plain Follow table.
    const humanFollower = await insertHuman('nh');
    const followId = `f-${runId}-dispatch`;
    const [createdFollow] = await db
      .insert(follows)
      .values({
        id: followId,
        followerId: humanFollower,
        followingId: dispatchHuman,
      })
      .returning({
        id: follows.id,
        canonical: sql<string>`to_jsonb(${follows})::text`,
      });
    if (!createdFollow)
      throw new Error('Fixture human follow insert returned no row');
    owned.follows.set(createdFollow.id, createdFollow.canonical);
    followIds.push(followId);
    dispatchHumanFollower = humanFollower;
  });

  it('followers by shadow actor ID use the actor branch with the NPC row present', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseFollowers, followerAdded, [dispatchHuman])
    );
  });

  it('following by shadow actor ID uses the actor branch with the NPC row present', async () => {
    const { status, payload } = await readList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'following',
      plusRelations(baseFollowing, followingAdded, [ORG_ALL_BROKEN_ACTOR])
    );
  });

  it('followers by actor username resolve without a matching user row', async () => {
    const actor = StaticDataRegistry.getActor(ORG_LIST_BROKEN_ACTOR);
    if (!actor?.username) {
      throw new Error('Fixture actor has no username');
    }
    // The canonical NPC row's username is the actor ID, so this identifier
    // matches no users-table row and must fall through to the registry.
    const { status, payload } = await readList(
      getFollowers,
      actor.username,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseFollowers, followerAdded, [dispatchHuman])
    );
  });

  it('ordinary human accounts keep the human follow branches', async () => {
    const followersResult = await readList(
      getFollowers,
      dispatchHuman,
      'followers'
    );
    expect(followersResult.status).toBe(200);
    expect(followersResult.payload.count).toBe(1);
    expect(
      (followersResult.payload.followers ?? []).map((f) => f.id)
    ).toContain(dispatchHumanFollower);

    const followingResult = await readList(
      getFollowing,
      dispatchHumanFollower,
      'following'
    );
    expect(followingResult.status).toBe(200);
    expect(followingResult.payload.count).toBe(1);
    expect(
      (followingResult.payload.following ?? []).map((f) => f.id)
    ).toContain(dispatchHuman);
  });
});

describe('organization follow fixture ownership', () => {
  it('retains colliding rows, foreign children and changed physical tuples', async () => {
    const target = registry();
    const attempt = registry();
    const userId = await fresh();
    const foreignId = await fresh();
    let foreignCanonical: string | null = null;
    let changedCanonical: string | null = null;
    const originalName = 'Owned follow cleanup control';
    const [createdUser] = await db
      .insert(users)
      .values({
        id: userId,
        username: `of69-control-${userId.slice(-10)}`,
        displayName: originalName,
        updatedAt: new Date(),
      })
      .returning({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      });
    if (!createdUser) throw new Error('Control user acquisition failed');
    target.users.set(createdUser.id, createdUser.canonical);
    const relationId = await fresh();
    try {
      let collision = false;
      try {
        const [inserted] = await db
          .insert(users)
          .values({
            id: userId,
            username: `of69-collision-${userId.slice(-10)}`,
            updatedAt: new Date(),
          })
          .returning({
            id: users.id,
            canonical: sql<string>`to_jsonb(${users})::text`,
          });
        if (inserted) attempt.users.set(inserted.id, inserted.canonical);
      } catch (error) {
        const direct = z.object({ code: z.literal('23505') }).safeParse(error);
        const wrapped = z
          .object({ cause: z.object({ code: z.literal('23505') }) })
          .safeParse(error);
        if (!direct.success && !wrapped.success) throw error;
        collision = true;
      }
      expect(collision).toBe(true);
      expect(attempt.users.size).toBe(0);
      await cleanup(attempt);
      const [createdRelation] = await db
        .insert(userActorFollows)
        .values({
          id: relationId,
          userId,
          actorId: ORG_LIST_BROKEN_ACTOR,
        })
        .returning({
          id: userActorFollows.id,
          canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
        });
      if (!createdRelation)
        throw new Error('Control relation acquisition failed');
      target.userActorFollows.set(
        createdRelation.id,
        createdRelation.canonical
      );
      const [foreign] = await db
        .insert(gameOnboarding)
        .values({
          id: foreignId,
          userId,
        })
        .returning({
          id: gameOnboarding.id,
          canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
        });
      if (!foreign) throw new Error('Foreign child control acquisition failed');
      foreignCanonical = foreign.canonical;
      await expect(cleanup(target)).rejects.toThrow(
        'Owned User cleanup refused'
      );
      const [userAfterRefusal] = await db
        .select({
          canonical: sql<string>`to_jsonb(${users})::text`,
        })
        .from(users)
        .where(eq(users.id, userId));
      const [relationAfterRefusal] = await db
        .select({
          canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
        })
        .from(userActorFollows)
        .where(eq(userActorFollows.id, relationId));
      const [foreignAfterRefusal] = await db
        .select({
          canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
        })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignId));
      expect(userAfterRefusal?.canonical).toBe(createdUser.canonical);
      expect(relationAfterRefusal?.canonical).toBe(createdRelation.canonical);
      expect(foreignAfterRefusal?.canonical).toBe(foreign.canonical);
      const removed = await db
        .delete(gameOnboarding)
        .where(
          and(
            eq(gameOnboarding.id, foreignId),
            sql`to_jsonb(${gameOnboarding})=${foreignCanonical}::text::jsonb`
          )
        )
        .returning({ id: gameOnboarding.id });
      if (removed.length !== 1)
        throw new Error('Foreign control cleanup refused');
      foreignCanonical = null;
      const [changed] = await db
        .update(users)
        .set({
          displayName: 'Changed own control tuple',
        })
        .where(
          and(
            eq(users.id, userId),
            sql`to_jsonb(${users})=${createdUser.canonical}::text::jsonb`
          )
        )
        .returning({ canonical: sql<string>`to_jsonb(${users})::text` });
      if (!changed) throw new Error('Owned control drift acquisition failed');
      changedCanonical = changed.canonical;
      await expect(cleanup(target)).rejects.toThrow(
        'Owned User cleanup refused'
      );
      const [retained] = await db
        .select({
          canonical: sql<string>`to_jsonb(${users})::text`,
        })
        .from(users)
        .where(eq(users.id, userId));
      expect(retained?.canonical).toBe(changedCanonical);
      const [retainedRelation] = await db
        .select({
          canonical: sql<string>`to_jsonb(${userActorFollows})::text`,
        })
        .from(userActorFollows)
        .where(eq(userActorFollows.id, relationId));
      expect(retainedRelation?.canonical).toBe(createdRelation.canonical);
    } finally {
      if (foreignCanonical) {
        const removed = await db
          .delete(gameOnboarding)
          .where(
            and(
              eq(gameOnboarding.id, foreignId),
              sql`to_jsonb(${gameOnboarding})=${foreignCanonical}::text::jsonb`
            )
          )
          .returning({ id: gameOnboarding.id });
        if (removed.length !== 1)
          throw new Error('Foreign control cleanup refused');
      }
      if (changedCanonical) {
        const [restored] = await db
          .update(users)
          .set({ displayName: originalName })
          .where(
            and(
              eq(users.id, userId),
              sql`to_jsonb(${users})=${changedCanonical}::text::jsonb`
            )
          )
          .returning({ canonical: sql<string>`to_jsonb(${users})::text` });
        if (restored?.canonical !== createdUser.canonical)
          throw new Error('Owned control restoration refused');
      }
      await cleanup(target);
    }
  });
});
