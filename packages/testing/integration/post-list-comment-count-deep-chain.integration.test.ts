/**
 * Batched reachable counts must stay scoped to one post at a time.
 * hermesagent's review on #2100 showed the old batched walk scanning the
 * whole page's eligible rows at every recursion level: one 1000-deep chain
 * on a 100-post page cost ~8s at 50k rows (and ~31s in a second local
 * run), while the same page without the deep post cost ~80ms. The fix
 * runs the walk per post (LATERAL), so the cost is the sum over posts of
 * (depth x that post's rows). This test pins both the counts and the
 * timing on a full page with one deep chain.
 */
import { beforeAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const deepChainCase =
  'batched count stays fast with one 1000-deep chain on a full page';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs deep-chain batched count case in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-list-comment-count-deep-chain',
      file: 'packages/testing/integration/post-list-comment-count-deep-chain.integration.test.ts',
      cases: [deepChainCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { db, posts, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { countReachablePostCommentsForPosts } = await import('@feed/api');
  const { sql } = await import('@feed/db');

  let authorId: string;
  let postIds: string[];
  let deepPostId: string;

  beforeAll(async () => {
    authorId = await generateSnowflakeId();
    const now = new Date();
    await db.insert(users).values({
      id: authorId,
      username: `deep-chain-${authorId}`,
      stewardId: null,
      updatedAt: now,
    });
    postIds = [];
    for (let i = 0; i < 100; i += 1) {
      const id = await generateSnowflakeId();
      postIds.push(id);
      if (i === 0) deepPostId = id;
    }
    const earlier = new Date(now.getTime() - 1000);
    await db.insert(posts).values(
      postIds.map((id) => ({
        id,
        authorId,
        content: 'Deep chain fixture',
        createdAt: earlier,
        timestamp: earlier,
      }))
    );
    // Bulk seed with raw SQL: 100 posts x 500 flat comments, plus a
    // 1000-deep reply chain on the first post. 51,000 rows total.
    const postIdsArray = sql`ARRAY[${sql.join(
      postIds.map((id) => sql`${id}`),
      sql`, `
    )}]::text[]`;
    const earlierIso = earlier.toISOString();
    await db.execute(sql`
      INSERT INTO "Comment" (id, content, "postId", "authorId", "parentCommentId", "createdAt", "updatedAt")
      SELECT 'flat-' || p."postId" || '-' || g, 'Deep chain fixture', p."postId", ${authorId}, NULL, ${earlierIso}, ${earlierIso}
      FROM unnest(${postIdsArray}) AS p("postId")
      CROSS JOIN generate_series(1, 500) g
    `);
    await db.execute(sql`
      INSERT INTO "Comment" (id, content, "postId", "authorId", "parentCommentId", "createdAt", "updatedAt")
      SELECT 'chain-' || g, 'Deep chain fixture', ${deepPostId}, ${authorId},
        CASE WHEN g = 1 THEN NULL ELSE 'chain-' || (g - 1) END, ${earlierIso}, ${earlierIso}
      FROM generate_series(1, 1000) g
    `);
  });

  test(deepChainCase, async () => {
    // Warm run (plan + cache), then the timed run.
    const warm = await countReachablePostCommentsForPosts(postIds, []);
    expect(warm.get(deepPostId)).toBe(1500);
    expect(warm.size).toBe(100);
    const startedAt = Date.now();
    const counts = await countReachablePostCommentsForPosts(postIds, []);
    const elapsedMs = Date.now() - startedAt;
    expect(counts.size).toBe(100);
    expect(counts.get(deepPostId)).toBe(1500);
    for (const postId of postIds.slice(1)) {
      expect(counts.get(postId)).toBe(500);
    }
    // The old batched walk took ~8-32s on this fixture; the per-post
    // walk takes ~1s. 5s leaves headroom for a slow host while still
    // failing the old shape by a wide margin.
    expect(elapsedMs).toBeLessThan(5000);
  });
}
