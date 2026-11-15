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
 * The fix serializes check + insert per key with a transaction-scoped
 * advisory lock — the same pattern as the follow/block pair lock
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

import { db, inArray, posts, reports, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let reporterId: string;
let authorId: string;
const postIds: string[] = [];
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];

let POST: typeof import('../../../apps/web/src/app/api/moderation/reports/route').POST;

function submitReport(postId: string): NextRequest {
  return new NextRequest('http://localhost/api/moderation/reports', {
    method: 'POST',
    body: JSON.stringify({
      reportType: 'post',
      reportedPostId: postId,
      category: 'spam',
      reason: 'Concurrent duplicate report fixture for the dedup test',
    }),
    headers: new Headers({
      'Content-Type': 'application/json',
      'x-dev-user-id': reporterId,
    }),
  });
}

async function postReport(postId: string) {
  const response = await POST(submitReport(postId));
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

async function expectSingleRowUnderConcurrency(postId: string) {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => postReport(postId))
  );
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
  ]);
  reporterId = generated[0]!;
  authorId = generated[1]!;
  postIds.push(generated[2]!, generated[3]!, generated[4]!);

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

  // Three targets: one for the sequential duplicate window, two so the
  // concurrency proof does not depend on a single interleaving.
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
  // an existing row. Only clean batches whose atomic insert succeeded.
  if (ownedPostIds.length > 0) {
    await db
      .delete(reports)
      .where(inArray(reports.reportedPostId, ownedPostIds));
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
    await expectSingleRowUnderConcurrency(postIds[1]!);
  });

  it('leaves one row when eight submissions race (second target)', async () => {
    await expectSingleRowUnderConcurrency(postIds[2]!);
  });
});
