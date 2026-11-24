// A fresh process owns the real memory cache. MCP create_post / delete_post
// and A2A social.create_post / social.delete_post must refresh the same post
// list caches the website POST and DELETE routes refresh.
import { mock } from 'bun:test';
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FEED_DISABLE_REDIS, '1');
assert.equal(process.env.REDIS_URL, '');
mock.module('server-only', () => ({}));

const { closeDatabase, db, eq, follows, inArray, posts, users } = await import(
  '@feed/db'
);
const { cachedDb, isRedisAvailable, resetRateLimit } = await import(
  '@feed/api'
);
const { generateSnowflakeId } = await import('@feed/shared');
const { SignJWT } = await import('jose');
const { NextRequest } = await import('next/server');
const { GET } = await import('../../../../apps/web/src/app/api/posts/route');
const { executeCreatePost, executeDeletePost } = await import(
  '../../../mcp/src/handlers/tool-handlers'
);
const { FeedAgentExecutor } = await import(
  '../../../a2a/src/executors/feed-executor'
);
assert.equal(isRedisAvailable(), false);

const owned = { userIds: [] as string[], postIds: [] as string[] };
let cases = 0;
const failed: string[] = [];
/** Run one surface; a failed assertion is reported and the next case runs. */
async function runCase(name: string, body: () => Promise<void>) {
  try {
    await body();
    cases++;
    console.log(`AGENT_POST_CACHE_CASE_OK ${name}`);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    failed.push(name);
    console.log(`AGENT_POST_CACHE_CASE_FAIL ${name}: ${error.message}`);
  }
}

async function token(id: string) {
  return new SignJWT({ userId: `apc-${id}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(
      new TextEncoder().encode(
        process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
      )
    );
}

const [mcpAuthor, a2aAuthor, viewer] = await Promise.all([
  generateSnowflakeId(),
  generateSnowflakeId(),
  generateSnowflakeId(),
]);
const clientIp = `2001:db8:${viewer.slice(-8, -4)}:${viewer.slice(-4)}::a9c`;

/** Read a post list through the real GET /api/posts handler. */
async function list(actorId?: string, following = false) {
  const query = new URLSearchParams({ limit: '100' });
  if (actorId) query.set('actorId', actorId);
  if (following) {
    query.set('following', 'true');
    query.set('userId', viewer);
  }
  const response = await GET(
    new NextRequest(`http://localhost/api/posts?${query}`, {
      headers: {
        'x-forwarded-for': clientIp,
        ...(following
          ? { authorization: `Bearer ${await token(viewer)}` }
          : {}),
      },
    })
  );
  assert.equal(response.status, 200);
  const body: { posts: Array<{ id: string }> } = await response.json();
  return body.posts.map(({ id }) => id);
}

/** Warm and read all three cached list families for one author. */
async function families(authorId: string) {
  return {
    actor: await list(authorId),
    recent: await list(),
    following: await list(undefined, true),
  };
}

function assertInAll(lists: Record<string, string[]>, postId: string) {
  const missing = Object.keys(lists).filter((k) => !lists[k]?.includes(postId));
  assert.deepEqual(missing, [], `lists missing the new post: ${missing}`);
}

function assertInNone(lists: Record<string, string[]>, postId: string) {
  const stale = Object.keys(lists).filter((k) => lists[k]?.includes(postId));
  assert.deepEqual(stale, [], `lists still serving the deleted post: ${stale}`);
}

async function addPost(authorId: string) {
  const [row] = await db
    .insert(posts)
    .values({
      id: await generateSnowflakeId(),
      authorId,
      content: 'agent post cache fixture',
      timestamp: new Date(Date.now() - 60_000),
    })
    .returning({ id: posts.id });
  assert.ok(row);
  owned.postIds.push(row.id);
  // Fixture rows bypass every write path; start each case from fresh lists.
  await cachedDb.invalidatePostsCache();
  await cachedDb.invalidateActorPostsCache(authorId);
  return row.id;
}

async function deletedAt(postId: string) {
  const [row] = await db
    .select({ deletedAt: posts.deletedAt })
    .from(posts)
    .where(eq(posts.id, postId));
  assert.ok(row);
  return row.deletedAt;
}

try {
  const inserted = await db
    .insert(users)
    .values(
      [mcpAuthor, a2aAuthor, viewer].map((id) => ({
        id,
        username: `apc-${id}`,
        stewardId: `apc-${id}`,
        updatedAt: new Date(),
      }))
    )
    .returning({ id: users.id });
  owned.userIds.push(...inserted.map(({ id }) => id));
  for (const author of [mcpAuthor, a2aAuthor])
    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: viewer,
      followingId: author,
    });

  // MCP delete_post: warm every list with the post, delete it, read again.
  await runCase('mcp-delete-post-all-cache-families', async () => {
    const mcpExisting = await addPost(mcpAuthor);
    assertInAll(await families(mcpAuthor), mcpExisting);
    assert.deepEqual(
      await executeDeletePost(
        { agentId: mcpAuthor, userId: mcpAuthor },
        { postId: mcpExisting }
      ),
      { success: true }
    );
    assert.ok(await deletedAt(mcpExisting));
    assertInNone(await families(mcpAuthor), mcpExisting);
  });

  // MCP delete_post on an already-deleted post is refused like the website
  // route and does not clear the warmed lists. A row inserted straight into
  // the database after warming shows up only if Recent was rebuilt.
  await runCase('mcp-repeat-delete-refused-keeps-cache', async () => {
    const gone = await addPost(mcpAuthor);
    await executeDeletePost(
      { agentId: mcpAuthor, userId: mcpAuthor },
      { postId: gone }
    );
    const firstDeletedAt = await deletedAt(gone);
    assert.ok(firstDeletedAt);
    await families(mcpAuthor);
    const [probe] = await db
      .insert(posts)
      .values({
        id: await generateSnowflakeId(),
        authorId: mcpAuthor,
        content: 'agent post cache probe',
        timestamp: new Date(Date.now() - 30_000),
      })
      .returning({ id: posts.id });
    assert.ok(probe);
    owned.postIds.push(probe.id);
    await assert.rejects(
      executeDeletePost(
        { agentId: mcpAuthor, userId: mcpAuthor },
        { postId: gone }
      ),
      /Post already deleted/
    );
    assert.deepEqual(await deletedAt(gone), firstDeletedAt);
    assert.ok(
      !(await list()).includes(probe.id),
      'Recent was rebuilt after the repeat delete'
    );
  });

  // MCP create_post: warm every list, publish, read again.
  await runCase('mcp-create-post-all-cache-families', async () => {
    await families(mcpAuthor);
    const created = await executeCreatePost(
      { agentId: mcpAuthor, userId: mcpAuthor },
      { content: 'published through MCP' }
    );
    owned.postIds.push(created.postId);
    assertInAll(await families(mcpAuthor), created.postId);
  });

  // A2A social.delete_post.
  await runCase('a2a-delete-post-all-cache-families', async () => {
    const a2aExisting = await addPost(a2aAuthor);
    assertInAll(await families(a2aAuthor), a2aExisting);
    const removed = (await FeedAgentExecutor.executeDirectly(
      'social.delete_post',
      { postId: a2aExisting },
      a2aAuthor
    )) as unknown as { success: boolean };
    assert.equal(removed.success, true);
    assert.ok(await deletedAt(a2aExisting));
    assertInNone(await families(a2aAuthor), a2aExisting);
  });

  // A2A social.create_post.
  await runCase('a2a-create-post-all-cache-families', async () => {
    await families(a2aAuthor);
    const published = (await FeedAgentExecutor.executeDirectly(
      'social.create_post',
      { content: 'published through A2A' },
      a2aAuthor
    )) as unknown as { success: boolean; postId: string };
    assert.equal(published.success, true);
    owned.postIds.push(published.postId);
    assertInAll(await families(a2aAuthor), published.postId);
  });

  // A refused delete (not the author) changes nothing.
  await runCase('non-author-delete-refused', async () => {
    const kept = await addPost(a2aAuthor);
    await assert.rejects(
      executeDeletePost({ agentId: viewer, userId: viewer }, { postId: kept }),
      /only delete your own posts/
    );
    await assert.rejects(
      FeedAgentExecutor.executeDirectly(
        'social.delete_post',
        { postId: kept },
        viewer
      ),
      /only delete your own posts/
    );
    assert.equal(await deletedAt(kept), null);
    assertInAll(await families(a2aAuthor), kept);
  });
} finally {
  if (owned.postIds.length)
    await db.delete(posts).where(inArray(posts.id, owned.postIds));
  if (owned.userIds.length) {
    await db.delete(follows).where(inArray(follows.followerId, owned.userIds));
    for (const id of owned.userIds) {
      await cachedDb.invalidateActorPostsCache(id);
      await resetRateLimit(id, 'public_read_authed');
    }
    await db.delete(users).where(inArray(users.id, owned.userIds));
  }
  // Redis is disabled before imports; this process owns both namespaces.
  await cachedDb.invalidatePostsCache();
  await resetRateLimit(clientIp, 'public_read');
  await closeDatabase();
}
console.log(`AGENT_POST_CACHE_RESULT pass=${cases} fail=${failed.length}`);
if (failed.length === 0) console.log(`AGENT_POST_CACHE_OK cases=${cases}`);
process.exit(failed.length === 0 ? 0 : 1);
