// A fresh process owns the real memory cache and limiter. PostgreSQL rows are
// acquired with RETURNING; normal JWT verification supplies each caller.
import { mock, spyOn } from 'bun:test';
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');
mock.module('server-only', () => ({}));

const {
  adminAuditLogs,
  and,
  closeDatabase,
  db,
  eq,
  follows,
  inArray,
  posts,
  users,
} = await import('@feed/db');
const { cachedDb, isRedisAvailable, resetRateLimit } = await import(
  '@feed/api'
);
const { generateSnowflakeId } = await import('@feed/shared');
const { SignJWT } = await import('jose');
const { NextRequest } = await import('next/server');
const { GET } = await import('../../../../apps/web/src/app/api/posts/route');
const { DELETE } = await import(
  '../../../../apps/web/src/app/api/posts/[id]/route'
);
const { POST } = await import(
  '../../../../apps/web/src/app/api/admin/content-queue/[contentId]/route'
);
assert.equal(isRedisAvailable(), false);

type Owned = { userIds: string[]; postIds: string[] };
const owned: Owned = { userIds: [], postIds: [] };
let cases = 0;
const passed = (name: string) => {
  cases++;
  console.log(`POST_CACHE_CASE_OK ${name}`);
};

async function insertUsers(
  values: (typeof users.$inferInsert)[],
  scope = owned
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({ id: users.id });
  scope.userIds.push(...rows.map(({ id }) => id));
}

async function insertPost(value: typeof posts.$inferInsert, scope = owned) {
  const [row] = await db
    .insert(posts)
    .values(value)
    .returning({ id: posts.id });
  assert.ok(row);
  scope.postIds.push(row.id);
  return row.id;
}

async function cleanup(scope: Owned) {
  if (scope.userIds.length) {
    // These admins were inserted successfully by this scope. Recover audit
    // children even when a route committed and then failed in cache I/O.
    const audit = await db
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(inArray(adminAuditLogs.adminId, scope.userIds));
    if (audit.length)
      await db.delete(adminAuditLogs).where(
        inArray(
          adminAuditLogs.id,
          audit.map(({ id }) => id)
        )
      );
    assert.equal(
      (
        await db
          .select({ id: adminAuditLogs.id })
          .from(adminAuditLogs)
          .where(inArray(adminAuditLogs.adminId, scope.userIds))
      ).length,
      0
    );
    await db.delete(follows).where(inArray(follows.followerId, scope.userIds));
    for (const id of scope.userIds) {
      await cachedDb.invalidateActorPostsCache(id);
      await resetRateLimit(id, 'public_read_authed');
      await resetRateLimit(id, 'admin_action');
    }
  }
  if (scope.postIds.length) {
    await db.delete(posts).where(inArray(posts.id, scope.postIds));
    assert.equal(
      (
        await db
          .select({ id: posts.id })
          .from(posts)
          .where(inArray(posts.id, scope.postIds))
      ).length,
      0
    );
  }
  if (scope.userIds.length) {
    await db.delete(users).where(inArray(users.id, scope.userIds));
    assert.equal(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, scope.userIds))
      ).length,
      0
    );
  }
}

async function token(id: string) {
  return new SignJWT({ userId: `f118-${id}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('dev-jwt-secret-change-in-prod'));
}

const [authorA, authorB, admin, viewer] = await Promise.all([
  generateSnowflakeId(),
  generateSnowflakeId(),
  generateSnowflakeId(),
  generateSnowflakeId(),
]);
const clientIp = `2001:db8:${viewer.slice(-8, -4)}:${viewer.slice(-4)}::f118`;
const headers = async (id?: string) => ({
  'x-forwarded-for': clientIp,
  ...(id ? { authorization: `Bearer ${await token(id)}` } : {}),
});

async function list(actorId?: string, following = false) {
  const query = new URLSearchParams({ limit: '100' });
  if (actorId) query.set('actorId', actorId);
  if (following) {
    query.set('following', 'true');
    query.set('userId', viewer);
  }
  const response = await GET(
    new NextRequest(`http://localhost/api/posts?${query}`, {
      headers: await headers(following ? viewer : undefined),
    })
  );
  assert.equal(response.status, 200);
  const body: { posts: Array<{ id: string }> } = await response.json();
  return body.posts.map(({ id }) => id);
}

async function remove(postId: string, caller: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/posts/${postId}`, {
      method: 'DELETE',
      headers: await headers(caller),
    }),
    { params: Promise.resolve({ id: postId }) }
  );
}

async function hide(postId: string, caller: string) {
  return POST(
    new NextRequest(`http://localhost/api/admin/content-queue/${postId}`, {
      method: 'POST',
      headers: {
        ...(await headers(caller)),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'hide', contentType: 'post' }),
    }),
    { params: Promise.resolve({ contentId: postId }) }
  );
}

async function stored(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId));
  assert.ok(row);
  return row;
}

async function auditFor(postId: string) {
  return db
    .select()
    .from(adminAuditLogs)
    .where(
      and(
        eq(adminAuditLogs.adminId, admin),
        eq(adminAuditLogs.resourceType, 'post'),
        eq(adminAuditLogs.resourceId, postId)
      )
    );
}

const uniqueViolation = (error: unknown) =>
  error instanceof Error &&
  typeof error.cause === 'object' &&
  error.cause !== null &&
  'code' in error.cause &&
  error.cause.code === '23505';

try {
  await insertUsers(
    [authorA, authorB, admin, viewer].map((id) => ({
      id,
      username: `f118-${id}`,
      stewardId: `f118-${id}`,
      isAdmin: id === admin,
      updatedAt: new Date(),
    }))
  );
  for (const author of [authorA, authorB])
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: viewer,
      followingId: author,
    });
  const now = Date.now();
  const add = async (authorId: string, offset: number, deleted = false) =>
    insertPost({
      id: await generateSnowflakeId(),
      authorId,
      content: 'post-cache fixture',
      timestamp: new Date(now + offset),
      deletedAt: deleted ? new Date() : null,
    });
  const aOld = await add(authorA, -180000);
  const aMid = await add(authorA, -120000);
  const aNew = await add(authorA, -60000);
  await add(authorA, 3600000);
  await add(authorA, -30000, true);
  const bOld = await add(authorB, -120000);
  const bNew = await add(authorB, -60000);

  assert.deepEqual(await list(authorA), [aNew, aMid, aOld]);
  passed('visible-order-and-publication');

  // Preserve this route's existing BusinessLogicError status for non-owners.
  const nonOwner = await remove(aMid, authorB);
  assert.equal(nonOwner.status, 400);
  const denial: { error: string } = await nonOwner.json();
  assert.equal(denial.error, 'Unauthorized to delete this post');
  assert.equal((await hide(bOld, authorA)).status, 403);
  assert.equal((await stored(aMid)).deletedAt, null);
  assert.equal((await stored(bOld)).deletedAt, null);
  passed('non-owner-and-non-admin-refusal');

  assert.ok((await cachedDb.getRecentPosts(100)).some(({ id }) => id === aMid));
  assert.ok((await list(undefined, true)).includes(aMid));
  assert.ok((await list(authorA)).includes(aMid));
  assert.equal((await remove(aMid, authorA)).status, 200);
  assert.ok((await stored(aMid)).deletedAt);
  assert.deepEqual(await list(authorA), [aNew, aOld]);
  assert.ok(
    !(await cachedDb.getRecentPosts(100)).some(({ id }) => id === aMid)
  );
  assert.ok(!(await list(undefined, true)).includes(aMid));
  passed('author-delete-all-cache-families');

  assert.ok((await list(authorB)).includes(bOld));
  assert.ok((await cachedDb.getRecentPosts(100)).some(({ id }) => id === bOld));
  assert.ok((await list(undefined, true)).includes(bOld));
  assert.equal((await hide(bOld, admin)).status, 200);
  assert.ok((await stored(bOld)).deletedAt);
  assert.equal((await auditFor(bOld)).length, 1);
  assert.deepEqual(await list(authorB), [bNew]);
  assert.ok(
    !(await cachedDb.getRecentPosts(100)).some(({ id }) => id === bOld)
  );
  assert.ok(!(await list(undefined, true)).includes(bOld));
  passed('admin-hide-all-cache-families-and-audit');

  const failingPost = await add(authorB, -10000);
  const failure = spyOn(cachedDb, 'invalidatePostsCache').mockRejectedValueOnce(
    new Error('owned cache failure control')
  );
  try {
    assert.equal((await hide(failingPost, admin)).status, 500);
    assert.ok((await stored(failingPost)).deletedAt);
    assert.equal((await auditFor(failingPost)).length, 1);
  } finally {
    failure.mockRestore();
  }
  passed('committed-hide-audited-despite-cache-failure');

  const existing: Owned = { userIds: [], postIds: [] };
  const attempted: Owned = { userIds: [], postIds: [] };
  try {
    const sentinel = await generateSnowflakeId();
    await insertUsers(
      [{ id: sentinel, username: `f118-${sentinel}`, updatedAt: new Date() }],
      existing
    );
    const sentinelPost = await insertPost(
      {
        id: await generateSnowflakeId(),
        authorId: sentinel,
        content: 'retained sentinel',
        timestamp: new Date(),
      },
      existing
    );
    await db.insert(adminAuditLogs).values({
      id: await generateSnowflakeId(),
      adminId: sentinel,
      action: 'MODIFY',
      resourceType: 'post',
      resourceId: sentinelPost,
    });
    const read = async () => ({
      users: await db.select().from(users).where(eq(users.id, sentinel)),
      posts: await db.select().from(posts).where(eq(posts.id, sentinelPost)),
      audit: await db
        .select()
        .from(adminAuditLogs)
        .where(eq(adminAuditLogs.adminId, sentinel)),
    });
    const before = await read();
    await assert.rejects(
      insertUsers([{ id: sentinel, updatedAt: new Date() }], attempted),
      uniqueViolation
    );
    const partial = await generateSnowflakeId();
    await insertUsers(
      [{ id: partial, username: `f118-${partial}`, updatedAt: new Date() }],
      attempted
    );
    await insertPost(
      {
        id: await generateSnowflakeId(),
        authorId: partial,
        content: 'partial',
        timestamp: new Date(),
      },
      attempted
    );
    await assert.rejects(
      insertPost(
        {
          id: sentinelPost,
          authorId: partial,
          content: 'collision',
          timestamp: new Date(),
        },
        attempted
      ),
      uniqueViolation
    );
    await cleanup(attempted);
    assert.deepEqual(await read(), before);
  } finally {
    await cleanup(attempted);
    await cleanup(existing);
  }
  passed('collision-and-partial-setup-preserve-sentinels');
  assert.equal(cases, 6);
} finally {
  await cleanup(owned);
  // Redis is disabled before imports; this process owns both entire namespaces.
  await cachedDb.invalidatePostsCache();
  await resetRateLimit(clientIp, 'public_read');
  await closeDatabase();
}
console.log(`POST_CACHE_MODERATION_OK cases=${cases}`);
process.exit(0);
