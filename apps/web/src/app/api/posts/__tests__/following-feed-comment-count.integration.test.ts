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
 * The route handler is exercised unmodified; the viewer authenticates with
 * a Steward JWT signed with the test secret, exactly like a real session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

const STEWARD_SECRET = 'f5-test-steward-secret';

type PostsResponse = {
  success: boolean;
  posts: Array<{ id: string; commentCount: number }>;
  source?: string;
};

let viewerId: string;
let authorId: string;
let postId: string;
const allCommentIds: string[] = [];

let GET: typeof import('../route').GET;

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
  process.env.STEWARD_JWT_SECRET = STEWARD_SECRET;
  ({ GET } = await import('../route'));

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

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `test-f5-viewer-${viewerId}`,
      displayName: 'Following Fixture Viewer',
      stewardId: 'f5-viewer-steward',
      updatedAt: now,
    },
    {
      id: authorId,
      username: `test-f5-author-${authorId}`,
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
});

describe('GET /api/posts?following=true comment counts', () => {
  it('does not count soft-deleted (moderated) comments', async () => {
    const token = await new SignJWT({ userId: 'f5-viewer-steward' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(STEWARD_SECRET));

    const { status, body } = await fetchFollowingFeed(token);
    expect(status).toBe(200);
    const post = (body as PostsResponse).posts.find((p) => p.id === postId);
    expect(post).toBeDefined();
    // 2 visible top-level comments + 1 visible reply; the moderated
    // comment is hidden everywhere else and must not inflate the count.
    expect(post?.commentCount).toBe(3);
  });
});
