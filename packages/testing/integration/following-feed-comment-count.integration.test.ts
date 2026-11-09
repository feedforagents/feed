/**
 * GET /api/posts?following=true against a real database: the comment count
 * shown on a Following-feed card must count only comments that are actually
 * visible on the post. Comments that moderation soft-deleted
 * (comments.deletedAt set by the admin content queue "hide" action) are
 * never returned by the post comment list ("Soft-deleted (moderated)
 * comments must never be returned"), and every sibling count — the main
 * feed branch of this same route, GET /api/posts/[id], and
 * GET /api/posts/[id]/interactions — filters deletedAt. The Following
 * branch must agree, or the card promises comments that do not exist.
 *
 * The real route and database use a short-lived synthetic test JWT. Only
 * the server-only environment marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  and,
  comments,
  db,
  eq,
  follows,
  inArray,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type PostsResponse = {
  success: boolean;
  posts: Array<{ id: string; commentCount: number }>;
  source?: string;
};

let viewerId: string;
let authorId: string;
let postId: string;
let token: string;
const allCommentIds: string[] = [];

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/route';

async function fetchFollowingFeed(token: string) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/posts?following=true&userId=${viewerId}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | PostsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  [viewerId, authorId, postId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const commentIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  allCommentIds.push(...commentIds);
  const [visibleA, visibleB, visibleReply, deletedComment] = commentIds as [
    string,
    string,
    string,
    string,
  ];

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  token = await new SignJWT({ userId: `following-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(secret));

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f5v-${viewerId}`,
      displayName: 'Following Fixture Viewer',
      stewardId: `following-${viewerId}`,
      updatedAt: now,
    },
    {
      id: authorId,
      username: `f5a-${authorId}`,
      displayName: 'Following Fixture Author',
      updatedAt: now,
    },
  ]);

  await db.insert(follows).values({
    id: await generateSnowflakeId(),
    followerId: viewerId,
    followingId: authorId,
    createdAt: earlier,
  });

  await db.insert(posts).values({
    id: postId,
    content: 'fixture post for following feed counts',
    authorId,
    timestamp: earlier,
    createdAt: earlier,
  });

  // Two visible top-level comments, one visible reply, and one comment
  // that moderation hid (soft-deleted). Visible total is 3; the hidden
  // comment must not be counted.
  await db.insert(comments).values([
    {
      id: visibleA,
      content: 'visible comment a',
      postId,
      authorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleB,
      content: 'visible comment b',
      postId,
      authorId: viewerId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleReply,
      content: 'visible reply',
      postId,
      authorId,
      parentCommentId: visibleA,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: deletedComment,
      content: 'hidden moderated comment',
      postId,
      authorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db
    .delete(follows)
    .where(
      and(eq(follows.followerId, viewerId), eq(follows.followingId, authorId))
    );
  await db.delete(users).where(inArray(users.id, [viewerId, authorId]));
  token = '';
});

describe('GET /api/posts?following=true comment counts', () => {
  it('does not count soft-deleted (moderated) comments', async () => {
    const { status, body } = await fetchFollowingFeed(token);
    expect(status).toBe(200);
    expect((body as PostsResponse).source).toBe('following');
    const post = (body as PostsResponse).posts.find((p) => p.id === postId);
    expect(post).toBeDefined();
    // 2 visible top-level comments + 1 visible reply; the moderated
    // comment is hidden everywhere else and must not inflate the count.
    expect(post?.commentCount).toBe(3);
  });
});

describe('Following feed moderated count transitions', () => {
  it('returns zero when every owned comment is hidden', async () => {
    try {
      await db
        .update(comments)
        .set({ deletedAt: new Date() })
        .where(inArray(comments.id, allCommentIds));
      const { status, body } = await fetchFollowingFeed(token);
      expect(status).toBe(200);
      expect((body as PostsResponse).source).toBe('following');
      expect(
        (body as PostsResponse).posts.find((p) => p.id === postId)?.commentCount
      ).toBe(0);
    } finally {
      await db
        .update(comments)
        .set({ deletedAt: null })
        .where(inArray(comments.id, allCommentIds.slice(0, 3)));
    }
  });

  it('counts a previously hidden comment again when restored', async () => {
    try {
      await db
        .update(comments)
        .set({ deletedAt: null })
        .where(eq(comments.id, allCommentIds[3]!));
      const { status, body } = await fetchFollowingFeed(token);
      expect(status).toBe(200);
      expect((body as PostsResponse).source).toBe('following');
      expect(
        (body as PostsResponse).posts.find((p) => p.id === postId)?.commentCount
      ).toBe(4);
    } finally {
      await db
        .update(comments)
        .set({ deletedAt: new Date() })
        .where(eq(comments.id, allCommentIds[3]!));
    }
  });
});
