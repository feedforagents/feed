// Invoked only in a fresh process by follow-lists-reachability.integration.test.ts.
//
// Premise: the profile follow-list API was rebuilt (merged commits 35218f25b,
// 1dde4811d, 7ca20474a) to page the full relation set: `count` is documented
// as the total across all pages and every member must be reachable exactly
// once by paging, even when many relations share one timestamp. This fixture
// seeds >100 followers and >100 following for one user through the real
// database, walks both real routes page by page, and reports what the sole
// web consumer (FollowListModal, which fetches page 1 with limit=100 only)
// would show versus what the API offers.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');

mock.module('server-only', () => ({}));

const {
  closeDatabase,
  db,
  followStatuses,
  follows,
  inArray,
  userActorFollows,
  users,
} = await import('@feed/db');
const { StaticDataRegistry } = await import('@feed/engine');
const { generateSnowflakeId } = await import('@feed/shared');
const { NextRequest } = await import('next/server');
const { GET: getFollowers } = await import(
  '../../../../apps/web/src/app/api/users/[userId]/followers/route'
);
const { GET: getFollowing } = await import(
  '../../../../apps/web/src/app/api/users/[userId]/following/route'
);

const runId = crypto.randomUUID().slice(0, 8);
const minute = 60 * 1000;
const now = Date.now();

const targetId = await generateSnowflakeId();
const followerIds: string[] = [];
const followingUserIds: string[] = [];
const followRowIds: string[] = [];
const followStatusIds: string[] = [];
const userActorFollowIds: string[] = [];
const allUserIds: string[] = [targetId];

const actors = StaticDataRegistry.getAllActors();
assert.ok(actors.length >= 30, `registry actors: ${actors.length}`);
const npcFollowerIds = actors.slice(0, 5).map((a) => a.id);
const followedActorIds = actors.slice(0, 30).map((a) => a.id);

interface ListPage {
  count: number;
  hasMore: boolean;
  followers?: Array<{ id: string }>;
  following?: Array<{ id: string }>;
}

async function fetchPage(
  kind: 'followers' | 'following',
  page: number,
  limit: number
): Promise<ListPage> {
  const url = `http://localhost/api/users/${targetId}/${kind}?page=${page}&limit=${limit}`;
  const get = kind === 'followers' ? getFollowers : getFollowing;
  const response = await get(new NextRequest(url), {
    params: Promise.resolve({ userId: targetId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as ListPage;
}

async function traverse(
  kind: 'followers' | 'following',
  limit: number
): Promise<{ ids: string[]; count: number }> {
  const ids: string[] = [];
  let count = -1;
  for (let page = 1; page <= 40; page++) {
    const body = await fetchPage(kind, page, limit);
    const rows = (kind === 'followers' ? body.followers : body.following) ?? [];
    if (count === -1) count = body.count;
    assert.equal(body.count, count, `${kind} count changed across pages`);
    ids.push(...rows.map((r) => r.id));
    if (!body.hasMore) return { ids, count };
    assert.ok(rows.length > 0, `${kind} hasMore with empty page ${page}`);
  }
  throw new Error(`${kind} traversal did not terminate`);
}

try {
  // --- seed users -------------------------------------------------------
  const userRows: Array<{ id: string; username: string; updatedAt: Date }> = [
    {
      id: targetId,
      username: `f115-target-${runId}`,
      updatedAt: new Date(now),
    },
  ];
  for (let i = 0; i < 150; i++) {
    const id = await generateSnowflakeId();
    followerIds.push(id);
    allUserIds.push(id);
    userRows.push({
      id,
      username: `f115-fan-${runId}-${i}`,
      updatedAt: new Date(now),
    });
  }
  for (let i = 0; i < 120; i++) {
    const id = await generateSnowflakeId();
    followingUserIds.push(id);
    allUserIds.push(id);
    userRows.push({
      id,
      username: `f115-star-${runId}-${i}`,
      updatedAt: new Date(now),
    });
  }
  await db.insert(users).values(userRows);

  // --- seed followers of target: 150 humans + 5 NPCs --------------------
  const tieTs = new Date(now - 10 * minute);
  const followRows: Array<{
    id: string;
    followerId: string;
    followingId: string;
    createdAt: Date;
  }> = [];
  for (let i = 0; i < 150; i++) {
    const id = await generateSnowflakeId();
    followRowIds.push(id);
    followRows.push({
      id,
      followerId: followerIds[i]!,
      followingId: targetId,
      // 75 distinct timestamps, then 75 rows sharing one identical timestamp
      createdAt: i < 75 ? new Date(now - (i + 20) * minute) : tieTs,
    });
  }
  await db.insert(follows).values(followRows);

  const statusRows: Array<{
    id: string;
    userId: string;
    npcId: string;
    isActive: boolean;
    followReason: string;
    followedAt: Date;
  }> = [];
  for (let i = 0; i < npcFollowerIds.length; i++) {
    const id = await generateSnowflakeId();
    followStatusIds.push(id);
    statusRows.push({
      id,
      userId: targetId,
      npcId: npcFollowerIds[i]!,
      isActive: true,
      followReason: 'organic',
      followedAt: new Date(now - (300 + i) * minute),
    });
  }
  await db.insert(followStatuses).values(statusRows);

  // --- seed following of target: 120 users + 30 actors ------------------
  const outRows: Array<{
    id: string;
    followerId: string;
    followingId: string;
    createdAt: Date;
  }> = [];
  for (let i = 0; i < 120; i++) {
    const id = await generateSnowflakeId();
    followRowIds.push(id);
    outRows.push({
      id,
      followerId: targetId,
      followingId: followingUserIds[i]!,
      // 60 distinct timestamps, then 60 rows sharing one identical timestamp
      createdAt: i < 60 ? new Date(now - (i + 20) * minute) : tieTs,
    });
  }
  await db.insert(follows).values(outRows);

  const uafRows: Array<{
    id: string;
    userId: string;
    actorId: string;
    createdAt: Date;
  }> = [];
  for (let i = 0; i < followedActorIds.length; i++) {
    const id = await generateSnowflakeId();
    userActorFollowIds.push(id);
    uafRows.push({
      id,
      userId: targetId,
      actorId: followedActorIds[i]!,
      createdAt: new Date(now - (400 + i) * minute),
    });
  }
  await db.insert(userActorFollows).values(uafRows);

  // --- expectations -----------------------------------------------------
  const expectedFollowers = new Set([...followerIds, ...npcFollowerIds]);
  const expectedFollowing = new Set([...followingUserIds, ...followedActorIds]);
  assert.equal(expectedFollowers.size, 155);
  assert.equal(expectedFollowing.size, 150);

  for (const kind of ['followers', 'following'] as const) {
    const expected =
      kind === 'followers' ? expectedFollowers : expectedFollowing;
    // Traversal at the modal's page size, plus a small page size, twice each.
    for (const limit of [100, 7]) {
      const first = await traverse(kind, limit);
      const second = await traverse(kind, limit);
      assert.equal(first.count, expected.size, `${kind} count`);
      assert.equal(first.ids.length, expected.size, `${kind} delivered rows`);
      assert.equal(
        new Set(first.ids).size,
        expected.size,
        `${kind} duplicates`
      );
      assert.deepEqual(
        [...first.ids].sort(),
        [...expected].sort(),
        `${kind} roster mismatch`
      );
      assert.deepEqual(
        second.ids,
        first.ids,
        `${kind} unstable order (limit=${limit})`
      );
    }
    const page1 = await fetchPage(kind, 1, 100);
    const page1Rows =
      (kind === 'followers' ? page1.followers : page1.following) ?? [];
    console.log(
      `FOLLOW_LIST ${kind} api_count=${page1.count} page1_limit100_rows=${page1Rows.length} hasMore=${page1.hasMore} total=${expected.size}`
    );
  }

  console.log('FOLLOW_LISTS_FIXTURE_OK reachability');
} finally {
  if (followRowIds.length > 0)
    await db.delete(follows).where(inArray(follows.id, followRowIds));
  if (followStatusIds.length > 0)
    await db
      .delete(followStatuses)
      .where(inArray(followStatuses.id, followStatusIds));
  if (userActorFollowIds.length > 0)
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, userActorFollowIds));
  if (allUserIds.length > 0)
    await db.delete(users).where(inArray(users.id, allUserIds));
  await closeDatabase();
  // Background flushers keep the event loop alive after the work is done.
  process.exit(0);
}
