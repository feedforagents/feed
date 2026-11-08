/**
 * GET /api/users/[userId]/posts?type=replies against a real database: the
 * replies branch must honor the page/limit its own query schema validates.
 *
 * PRD §12 keeps profiles and replies in scope. The route validates `page`
 * and `limit` with UserPostsQuerySchema (which applies to type=replies as
 * well as type=posts), but the replies branch ignored both: every request
 * returned the same latest 100 replies and reported `total` as the length
 * of that truncated list. Open PR #1636 restores the contract for
 * type=posts only — its regression test is scoped to `type: 'posts'` — so
 * the replies branch still repeats page 1 on every page and a user with
 * more than 100 replies has no way to reach the older ones.
 *
 * The route is public, so the requests are anonymous. The only stub is the
 * `server-only` marker package (an empty environment guard that throws
 * outside a Server Component); every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type RepliesResponse = {
  type: 'replies';
  total: number;
  items: Array<{ id: string; content: string }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

let authorId: string;
let parentPostId: string;
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];
/** Visible reply ids in expected order (newest first). */
let expectedOrder: string[] = [];

async function fetchReplies(query: string) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/users/${authorId}/posts?type=replies${query}`
    )
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId: authorId }),
  });
  const raw = (await response.json().catch(() => null)) as
    | { data?: RepliesResponse }
    | RepliesResponse
    | null;
  const body = (
    raw && 'data' in raw && raw.data ? raw.data : raw
  ) as RepliesResponse | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  ));

  authorId = await generateSnowflakeId();
  const parentAuthorId = await generateSnowflakeId();
  ownedUserIds.push(authorId, parentAuthorId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: authorId,
      username: `g9r-${authorId}`,
      displayName: 'Replies Fixture Author',
      updatedAt: now,
    },
    {
      id: parentAuthorId,
      username: `g9p-${parentAuthorId}`,
      displayName: 'Replies Fixture Parent Author',
      updatedAt: now,
    },
  ]);

  parentPostId = await generateSnowflakeId();
  ownedPostIds.push(parentPostId);
  await db.insert(posts).values({
    id: parentPostId,
    content: 'parent post for profile replies',
    authorId: parentAuthorId,
    timestamp: new Date(now.getTime() - 60 * 60_000),
    createdAt: new Date(now.getTime() - 60 * 60_000),
  });

  // Seven visible replies, one minute apart, plus one soft-deleted reply
  // newer than all of them (it must never appear or be counted).
  const base = now.getTime() - 30 * 60_000;
  const rows: Array<typeof comments.$inferInsert> = [];
  for (let i = 0; i < 7; i++) {
    const id = await generateSnowflakeId();
    ownedCommentIds.push(id);
    rows.push({
      id,
      content: `visible reply ${i}`,
      postId: parentPostId,
      authorId,
      createdAt: new Date(base + i * 60_000),
      updatedAt: new Date(base + i * 60_000),
    });
  }
  const deletedId = await generateSnowflakeId();
  ownedCommentIds.push(deletedId);
  rows.push({
    id: deletedId,
    content: 'soft-deleted reply',
    postId: parentPostId,
    authorId,
    createdAt: new Date(base + 7 * 60_000),
    updatedAt: new Date(base + 7 * 60_000),
    deletedAt: new Date(base + 7 * 60_000),
  });
  await db.insert(comments).values(rows);

  // Newest first; the soft-deleted reply (index 7) is excluded.
  expectedOrder = ownedCommentIds.slice(0, 7).reverse();
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, ownedCommentIds));
  await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  await db.delete(users).where(inArray(users.id, ownedUserIds));
});

describe('GET /api/users/[userId]/posts?type=replies pagination', () => {
  it('returns only the requested page and the full visible total', async () => {
    const { status, body } = await fetchReplies('&limit=3&page=1');
    expect(status).toBe(200);
    expect(body).not.toBeNull();
    expect(body!.total).toBe(7);
    expect(body!.items.map((r) => r.id)).toEqual(expectedOrder.slice(0, 3));
  });

  it('returns a different, non-overlapping second page', async () => {
    const { status, body } = await fetchReplies('&limit=3&page=2');
    expect(status).toBe(200);
    expect(body!.total).toBe(7);
    expect(body!.items.map((r) => r.id)).toEqual(expectedOrder.slice(3, 6));
  });

  it('returns the final partial page', async () => {
    const { status, body } = await fetchReplies('&limit=3&page=3');
    expect(status).toBe(200);
    expect(body!.total).toBe(7);
    expect(body!.items.map((r) => r.id)).toEqual(expectedOrder.slice(6, 7));
  });

  it('keeps the default response unchanged (latest replies, full total)', async () => {
    const { status, body } = await fetchReplies('');
    expect(status).toBe(200);
    expect(body!.total).toBe(7);
    expect(body!.items.map((r) => r.id)).toEqual(expectedOrder);
  });
});
