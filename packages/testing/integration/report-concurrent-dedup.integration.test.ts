/**
 * POST /api/moderation/reports against a real database: concurrent duplicate
 * submissions for the same reporter, target and category must leave a single
 * report row.
 *
 * The route documents duplicate detection as part of its contract ("Includes
 * duplicate detection"; OpenAPI 400 "Invalid input or duplicate report", code
 * DUPLICATE_REPORT) — a 24-hour window per reporter + target + category. The
 * check was a plain read immediately before the insert with nothing
 * serializing the pair, so two simultaneous POSTs both read "no recent
 * report" and both inserted: duplicate rows stay visible in the reporter's own
 * GET /api/moderation/reports list, double-count in the moderation queue, and
 * for user reports each duplicate would run its own LLM evaluation and
 * auto-ban pass.
 *
 * The fix serializes check + insert with a transaction-scoped advisory lock
 * keyed on reporter + category — wide enough that every payload shape the
 * schema accepts (post-only, user-only, or both targets) contends on the same
 * lock — the same pattern as the follow/block pair lock
 * (`acquireUserBlockPairLock` in packages/db/src/moderation/filters.ts).
 *
 * The fixture reports a post: the evaluator short-circuits when there is no
 * reportedUserId (no model call), so the real route runs end to end without a
 * model key. The request is authenticated with the non-production
 * x-dev-user-id header. The only stub is the `server-only` marker package;
 * every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, inArray, posts, reports, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let reporterId: string;
let authorId: string;
const postIds: string[] = [];
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];

let POST: typeof import('../../../apps/web/src/app/api/moderation/reports/route').POST;

function submitReport(postId: string, bothTargets = false): NextRequest {
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
  ({ POST } = await import(
    '../../../apps/web/src/app/api/moderation/reports/route'
  ));

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
  ownedUserIds.push(reporterId, authorId);

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
  ownedPostIds.push(...postIds);
});

afterAll(async () => {
  // Generated IDs are not ownership: a failed insert may have collided with
  // an existing row. Only clean batches whose atomic insert succeeded, and
  // only this fixture reporter's rows — another reporter's report on the
  // same post is not ours to delete.
  if (ownedPostIds.length > 0) {
    await db
      .delete(reports)
      .where(
        and(
          inArray(reports.reportedPostId, ownedPostIds),
          eq(reports.reporterId, reporterId)
        )
      );
    await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('POST /api/moderation/reports duplicate detection', () => {
  it('rejects a sequential duplicate inside the 24-hour window', async () => {
    expect((await postReport(postIds[0]!)).status).toBe(200);
    const duplicate = await postReport(postIds[0]!);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body?.error).toBe(
      'You have already reported this post for this reason recently'
    );
    expect(await reportCount(postIds[0]!)).toBe(1);
  });

  it('leaves one row when eight submissions race (first target)', async () => {
    await expectSingleRowUnderConcurrency(
      postIds[1]!,
      Array.from({ length: 8 }, () => () => postReport(postIds[1]!))
    );
  });

  it('leaves one row when eight submissions race (second target)', async () => {
    await expectSingleRowUnderConcurrency(
      postIds[2]!,
      Array.from({ length: 8 }, () => () => postReport(postIds[2]!))
    );
  });

  it('leaves one row when post-only and dual-target shapes race together', async () => {
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

  it('a post-only submission waits on the reporter/category lock', async () => {
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
