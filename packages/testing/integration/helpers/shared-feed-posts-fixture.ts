import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { z } from 'zod';

assert.equal(process.env.NODE_ENV, 'test');
// The integration wrapper disables quotas for general fixtures. This isolated
// subprocess explicitly exercises the real quota and duplicate policy.
process.env.DISABLE_RATE_LIMITING = 'false';
mock.module('server-only', () => ({}));

const {
  cachedDb,
  clearAllDuplicates,
  clearAllRateLimits,
  createFeedPost,
  FeedPostCreationError,
  getPostsFeed,
  getPublicPost,
} = await import('@feed/api');
const {
  closeDatabase,
  dbWrite: db,
  eq,
  inArray,
  notifications,
  posts,
  userBlocks,
  userMutes,
  users,
} = await import('@feed/db');
const { generateSnowflakeId } = await import('@feed/shared');
const { GET, POST } = await import(
  '../../../../apps/web/src/app/api/posts/route'
);

const scenario = process.argv[2];
const run = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const author = crypto.randomUUID();
const viewer = crypto.randomUUID();
const recipient = crypto.randomUUID();
const testAuthor = crypto.randomUUID();
const ownerIds = [author, viewer, recipient, testAuthor];
const subject = `steward_${run}`;
const username = `shared_${run}`;
const recipientName = `mention_${run}`;
const secret = process.env.STEWARD_JWT_SECRET;
assert.ok(
  secret,
  'STEWARD_JWT_SECRET is required for real route authentication'
);
const jwt = await new SignJWT({
  userId: subject,
  tenantId: process.env.STEWARD_TENANT_ID || 'feed',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('steward')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(secret));

await db.insert(users).values(
  ownerIds.map((id, i) => ({
    id,
    stewardId: id === author ? subject : `steward_${id}`,
    username:
      i === 0 ? username : i === 2 ? recipientName : `shared_${run}_${i}`,
    displayName: 'Shared post fixture',
    profileComplete: true,
    tosAcceptedAt: new Date(),
    updatedAt: new Date(),
    isTest: id === testAuthor,
  }))
);

async function clearModeration() {
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, ownerIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, ownerIds));
}

async function clearPolicy() {
  clearAllRateLimits();
  clearAllDuplicates();
}

try {
  if (scenario === 'write-policy') {
    await clearPolicy();
    const text = `Shared service @${recipientName} ${run}`;
    let observed: string | undefined;
    const service = await createFeedPost(
      { content: `  ${text}  ` },
      {
        accountId: author,
        observeMutation: async (transaction, postId) => {
          const [stored] = await transaction
            .select({ authorId: posts.authorId })
            .from(posts)
            .where(eq(posts.id, postId));
          assert.equal(stored?.authorId, author);
          observed = postId;
        },
      }
    );
    assert.equal(service.post.content, text);
    assert.equal(service.post.authorId, author);
    assert.equal(observed, service.post.id);
    const readback = await getPublicPost(service.post.id, author);
    assert.equal(readback.content, text);
    assert.equal(readback.authorId, author);
    const mentions = await db
      .select()
      .from(notifications)
      .where(eq(notifications.postId, service.post.id));
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.userId, recipient);
    assert.equal(mentions[0]?.actorId, author);

    const duplicate = await POST(
      new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: text, authorId: viewer }),
      })
    );
    assert.equal(duplicate.status, 409);
    assert.equal(
      z.object({ error: z.string() }).parse(await duplicate.json()).error,
      'Duplicate content'
    );

    const webText = `Web canonical identity ${run}`;
    const web = await POST(
      new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: webText, authorId: viewer }),
      })
    );
    assert.equal(web.status, 200);
    const result = z
      .object({
        post: z.object({
          id: z.string(),
          authorId: z.string(),
          content: z.string(),
        }),
      })
      .parse(await web.json());
    assert.equal(result.post.authorId, author);
    assert.notEqual(result.post.authorId, subject);
    assert.equal(result.post.content, webText);
    await assert.rejects(
      createFeedPost({ content: `Quota ${run}` }, { accountId: author }),
      (error) =>
        error instanceof FeedPostCreationError && error.kind === 'rate_limit'
    );

    await clearPolicy();
    const rollbackText = `Rollback ${run}`;
    let rollbackId: string | undefined;
    await assert.rejects(
      createFeedPost(
        { content: rollbackText },
        {
          accountId: author,
          observeMutation: async (transaction, postId) => {
            rollbackId = postId;
            await transaction.insert(notifications).values({
              id: crypto.randomUUID(),
              userId: recipient,
              actorId: author,
              postId,
              type: 'system',
              title: 'Rollback',
              message: 'Must roll back',
            });
            throw new Error('Expected observer rollback');
          },
        }
      ),
      /Expected observer rollback/
    );
    assert.ok(rollbackId);
    assert.equal(
      (await db.select().from(posts).where(eq(posts.id, rollbackId))).length,
      0
    );
    assert.equal(
      (
        await db
          .select()
          .from(notifications)
          .where(eq(notifications.postId, rollbackId))
      ).length,
      0
    );

    const before = (
      await db.select().from(posts).where(eq(posts.authorId, author))
    ).length;
    await assert.rejects(
      createFeedPost({ content: 'x'.repeat(5001) }, { accountId: author })
    );
    await db.update(users).set({ isBanned: true }).where(eq(users.id, author));
    await assert.rejects(
      createFeedPost({ content: `Banned ${run}` }, { accountId: author }),
      /Account access denied/
    );
    assert.equal(
      (await db.select().from(posts).where(eq(posts.authorId, author))).length,
      before
    );
  } else if (scenario === 'primary-readback') {
    assert.ok(
      process.env.DATABASE_READ_REPLICA_URL,
      'Configure a separate stale replica database for this routing proof'
    );
    assert.notEqual(
      process.env.DATABASE_READ_REPLICA_URL,
      process.env.DATABASE_URL
    );
    await clearPolicy();
    const created = await createFeedPost(
      { content: `Primary-only write ${run}` },
      { accountId: author }
    );
    const readback = await getPublicPost(created.post.id, author);
    assert.equal(readback.content, created.post.content);
    assert.equal(readback.authorId, author);
    // The separate read database deliberately has no corresponding row. This is
    // a real connection-routing fixture, not a measurement of replication lag.
    await assert.rejects(getPublicPost(created.post.id), /not found/);
  } else if (scenario === 'visibility-pagination') {
    const at = new Date(Date.now() - 1000);
    const postIds = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    await db.insert(posts).values(
      postIds.map((id) => ({
        id,
        authorId: author,
        content: `Visible ${run}`,
        timestamp: at,
      }))
    );
    const quoteId = await generateSnowflakeId();
    const testPostId = await generateSnowflakeId();
    await db.insert(posts).values([
      {
        id: quoteId,
        authorId: viewer,
        content: 'Visible commentary',
        originalPostId: postIds[0],
        timestamp: new Date(at.getTime() - 1000),
      },
      {
        id: testPostId,
        authorId: testAuthor,
        content: 'Hidden test author',
        timestamp: new Date(at.getTime() + 500),
      },
    ]);
    await cachedDb.invalidatePostsCache();
    const first = await getPostsFeed({ limit: 2 });
    assert.equal(first.posts.length, 2);
    assert.ok(first.cursor);
    const second = await getPostsFeed({ limit: 2, cursor: first.cursor });
    const encountered = [...first.posts, ...second.posts].map(
      (post) => post.id
    );
    assert.equal(new Set(encountered).size, encountered.length);
    assert.ok(postIds.every((id) => encountered.includes(id)));
    assert.ok(!encountered.includes(testPostId));
    const web = await GET(
      new NextRequest('http://localhost/api/posts?limit=2')
    );
    assert.equal(web.status, 200);
    const webData = z
      .object({ posts: z.array(z.object({ id: z.string() })) })
      .parse(await web.json());
    assert.deepEqual(
      webData.posts.map((post) => post.id),
      first.posts.map((post) => post.id)
    );

    await db.insert(userBlocks).values({
      id: crypto.randomUUID(),
      blockerId: viewer,
      blockedId: author,
    });
    const hiddenWindow = await getPostsFeed({ limit: 2, viewerId: viewer });
    assert.equal(hiddenWindow.posts.length, 0);
    assert.ok(
      hiddenWindow.cursor,
      'A fully hidden window must preserve keyset continuation'
    );
    assert.equal(hiddenWindow.hasMore, true);
    const afterHidden = await getPostsFeed({
      limit: 2,
      cursor: hiddenWindow.cursor,
      viewerId: viewer,
    });
    assert.ok(afterHidden.posts.some((post) => post.id === quoteId));
    const blocked = await getPostsFeed({ limit: 20, viewerId: viewer });
    assert.ok(blocked.posts.every((post) => !postIds.includes(post.id)));
    const quote = blocked.posts.find((post) => post.id === quoteId);
    assert.ok(quote);
    assert.equal(
      'originalPost' in quote ? quote.originalPost : undefined,
      null
    );
    await assert.rejects(getPublicPost(postIds[0]!, viewer), /not found/);
    assert.equal((await getPublicPost(postIds[0]!)).authorId, author);
    await assert.rejects(getPublicPost(testPostId), /not found/);
    await clearModeration();
    await db.insert(userBlocks).values({
      id: crypto.randomUUID(),
      blockerId: author,
      blockedId: viewer,
    });
    assert.ok(
      (await getPostsFeed({ limit: 20, viewerId: viewer })).posts.every(
        (post) => !postIds.includes(post.id)
      )
    );
    await clearModeration();
    await db
      .insert(userMutes)
      .values({ id: crypto.randomUUID(), muterId: viewer, mutedId: author });
    assert.ok(
      (await getPostsFeed({ limit: 20, viewerId: viewer })).posts.every(
        (post) => !postIds.includes(post.id)
      )
    );
  } else throw new Error('Unknown fixture scenario');
  console.log(
    JSON.stringify({
      scenario,
      realDatabase: true,
      realRoutes: true,
      complete: true,
    })
  );
} finally {
  await clearModeration();
  await db.delete(notifications).where(inArray(notifications.userId, ownerIds));
  await db.delete(posts).where(inArray(posts.authorId, ownerIds));
  await db.delete(users).where(inArray(users.id, ownerIds));
  await cachedDb.invalidatePostsCache();
  await closeDatabase();
}
process.exit(0);
