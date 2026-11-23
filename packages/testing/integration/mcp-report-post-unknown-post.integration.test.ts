/** MCP post-report target checks. PRD §§8.1/12, MVP Phases 3/5. */
import { beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const unknownCase = 'rejects an unknown post without writing a report';
const realCase = 'queues a report on an existing post';
const deletedCase = 'queues a report on a soft-deleted post';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks report targets in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-report-post-unknown-post',
      file: 'packages/testing/integration/mcp-report-post-unknown-post.integration.test.ts',
      cases: [unknownCase, realCase, deletedCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { db, eq, posts, reports, users } = await import('@feed/db');
  const { executeReportPost } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const reporterId = crypto.randomUUID();
  const authorId = crypto.randomUUID();
  const missingPostId = crypto.randomUUID();
  const realPostId = crypto.randomUUID();
  const deletedPostId = crypto.randomUUID();
  const agent = { agentId: 'agent', userId: reporterId };

  beforeAll(async () => {
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(users).values(
        [reporterId, authorId].map((id) => ({
          id,
          username: `f182_${id.slice(-10)}`,
          isActor: false,
          updatedAt: now,
        }))
      );
      await tx.insert(posts).values(
        [
          { id: realPostId, deletedAt: null },
          { id: deletedPostId, deletedAt: now },
        ].map((post) => ({
          ...post,
          content: 'Report target fixture post',
          authorId,
          type: 'post',
          timestamp: now,
        }))
      );
    });
    const missingPosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, missingPostId));
    expect(missingPosts).toHaveLength(0);
  });

  // Only the lease owner drops the verified disposable database. Row-level
  // teardown here could cascade to rows this suite did not create.
  function reportRowsFor(postId: string) {
    return db
      .select({ id: reports.id, status: reports.status })
      .from(reports)
      .where(eq(reports.reportedPostId, postId));
  }

  test(unknownCase, async () => {
    await assert.rejects(
      executeReportPost(agent, { postId: missingPostId, reason: 'spam' }),
      /not found/
    );
    expect(await reportRowsFor(missingPostId)).toHaveLength(0);
  });

  test(realCase, async () => {
    const result = await executeReportPost(agent, {
      postId: realPostId,
      reason: 'spam',
    });
    expect(result.success).toBe(true);
    expect(await reportRowsFor(realPostId)).toEqual([
      { id: result.reportId, status: 'pending' },
    ]);
  });

  test(deletedCase, async () => {
    // The web report route checks existence, including soft-deleted posts.
    const result = await executeReportPost(agent, {
      postId: deletedPostId,
      reason: 'spam',
    });
    expect(result.success).toBe(true);
    expect(await reportRowsFor(deletedPostId)).toEqual([
      { id: result.reportId, status: 'pending' },
    ]);
  });
}
