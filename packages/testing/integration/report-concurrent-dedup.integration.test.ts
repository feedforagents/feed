/** PRD §12 / MVP Phase 5: one retained moderation report for duplicate submissions. */
import { beforeAll, describe, expect, it, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'POST /api/moderation/reports duplicate detection';
const cases = {
  sequential: 'rejects a sequential duplicate inside the 24-hour window',
  firstTarget: 'leaves one row when eight submissions race (first target)',
  secondTarget: 'leaves one row when eight submissions race (second target)',
  mixed: 'leaves one row when post-only and dual-target shapes race together',
  lock: 'a post-only submission waits on the reporter/category lock',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks report deduplication in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'report-concurrent-dedup',
      file: 'packages/testing/integration/report-concurrent-dedup.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  mock.module('server-only', () => ({}));
  // A dual-target report can reach the evaluator. Isolate only the provider
  // call so these database cases never send synthetic account data to a model.
  mock.module('../../api/src/services/claude-service', () => ({
    callClaudeDirect: async () =>
      JSON.stringify({
        outcome: 'insufficient_evidence',
        confidence: 0,
        reasoning: 'Synthetic report fixture',
        recommendedActions: [],
      }),
  }));

  const { db, posts, sql, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST } = await import(
    '../../../apps/web/src/app/api/moderation/reports/route'
  );

  let reporterId: string;
  let authorId: string;
  const postIds: string[] = [];

  function submitReport(postId: string, bothTargets = false) {
    const payload: Record<string, unknown> = {
      reportType: 'post',
      reportedPostId: postId,
      category: 'spam',
      reason: 'Concurrent duplicate report fixture for the dedup test',
    };
    if (bothTargets) {
      // CreateReportSchema accepts reportedUserId and reportedPostId together;
      // the route validates both and the duplicate checks touch the post
      // predicate under whatever lock key the payload produces.
      payload.reportedUserId = authorId;
    }
    return new NextRequest('http://localhost/api/moderation/reports', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: new Headers({
        'Content-Type': 'application/json',
        'x-dev-user-id': reporterId,
      }),
    });
  }

  async function postReport(postId: string, bothTargets = false) {
    const response = await POST(submitReport(postId, bothTargets));
    const body = (await response.json().catch(() => null)) as {
      data?: unknown;
      error?: string;
    } | null;
    return { status: response.status, body };
  }

  async function reportCount(postId: string): Promise<number> {
    return db.report.count({
      where: { reporterId, reportedPostId: postId },
    });
  }

  async function expectSingleRowUnderConcurrency(
    postId: string,
    requests: Array<() => Promise<{ status: number; body: unknown }>>
  ) {
    const responses = await Promise.all(requests.map((run) => run()));
    expect(await reportCount(postId)).toBe(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(
      responses.length - 1
    );
  }

  beforeAll(async () => {
    const generated = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    reporterId = generated[0]!;
    authorId = generated[1]!;
    postIds.push(
      generated[2]!,
      generated[3]!,
      generated[4]!,
      generated[5]!,
      generated[6]!
    );

    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60_000);

    await db.insert(users).values([
      {
        id: reporterId,
        username: `test-rdr-${reporterId}`,
        displayName: 'Report Dedup Fixture Reporter',
        updatedAt: now,
      },
      {
        id: authorId,
        username: `test-rdr-author-${authorId}`,
        displayName: 'Report Dedup Fixture Author',
        updatedAt: now,
      },
    ]);

    // Five targets: one for the sequential duplicate window, two for the
    // single-shape race rounds, one for the mixed post-only / dual-target
    // race, and one reserved for the deterministic lock-contention check.
    await db.insert(posts).values(
      postIds.map((id, index) => ({
        id,
        content: `Report dedup fixture post ${index}`,
        authorId,
        timestamp: past,
        createdAt: past,
      }))
    );
  });

  describe(suite, () => {
    it(cases.sequential, async () => {
      expect((await postReport(postIds[0]!)).status).toBe(200);
      const duplicate = await postReport(postIds[0]!);
      expect(duplicate.status).toBe(400);
      expect(duplicate.body?.error).toBe(
        'You have already reported this post for this reason recently'
      );
      expect(await reportCount(postIds[0]!)).toBe(1);
    });

    it(cases.firstTarget, async () => {
      await expectSingleRowUnderConcurrency(
        postIds[1]!,
        Array.from({ length: 8 }, () => () => postReport(postIds[1]!))
      );
    });

    it(cases.secondTarget, async () => {
      await expectSingleRowUnderConcurrency(
        postIds[2]!,
        Array.from({ length: 8 }, () => () => postReport(postIds[2]!))
      );
    });

    it(cases.mixed, async () => {
      // A per-target lock key would split this round across two locks: the
      // dual-target payload contends on the user key while the post-only
      // payloads contend on the post key, yet both run the post duplicate
      // query. One reporter/category lock keeps every shape in line.
      await expectSingleRowUnderConcurrency(
        postIds[3]!,
        Array.from({ length: 16 }, (_, index) =>
          index % 2 === 0
            ? () => postReport(postIds[3]!)
            : () => postReport(postIds[3]!, true)
        )
      );
    });

    it(cases.lock, async () => {
      // Deterministic cross-shape contention: hold exactly the lock the route
      // takes for every payload shape, then submit a post-only request. Under
      // the reporter/category key the request must block until we commit; a
      // per-target key would let it run on its own post key and finish while
      // we hold this one.
      const postId = postIds[4]!;
      let pending: Promise<{ status: number; body: unknown }> | undefined;
      await db.$transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'report-dedup:' + reporterId + ':spam'}))`
        );
        pending = postReport(postId);
        const outcome = await Promise.race([
          pending.then((response) => ({
            completed: true as const,
            response,
          })),
          new Promise<{ completed: false }>((resolve) => {
            setTimeout(() => resolve({ completed: false }), 1500);
          }),
        ]);
        expect(outcome.completed).toBe(false);
      });
      const response = await pending!;
      expect(response.status).toBe(200);
      expect(await reportCount(postId)).toBe(1);
    });
  });
}
