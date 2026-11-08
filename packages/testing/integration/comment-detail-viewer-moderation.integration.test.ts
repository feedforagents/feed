/**
 * GET /api/comments/[id] against a real database: the comment permalink
 * must apply the viewer's own moderation policy to the reply list, the
 * reply counts and the parent chain.
 *
 * Every sibling read surface already does this — the post feeds, the
 * favorites feed, for-you/stories, web notifications and user search all
 * exclude authors the viewer blocked or muted, and authors who blocked
 * the viewer (see apps/web/src/app/api/feed/_lib/viewer-moderation.ts:
 * "Authors the viewer must not see"). The post comment list applies the
 * same rule. The detail route is exercised unmodified; the viewer is a
 * real Steward JWT principal (optionalAuth accepts nothing else), and
 * anonymous reads are the unfiltered control.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { comments, db, eq, inArray, posts, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type CommentDetailResponse = {
  comment: {
    id: string;
    replyCount: number;
    parentComment: { id: string } | null;
  };
  replies: Array<{ id: string; content: string; replyCount: number }>;
  parentChain: Array<{ id: string; content: string }>;
  post: { id: string } | null;
};

const STEWARD_SECRET = 'test-steward-secret-for-integration';
process.env.STEWARD_JWT_SECRET = STEWARD_SECRET;

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: 'f75-steward-viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(STEWARD_SECRET));
  return { authorization: `Bearer ${token}` };
}

let postAuthor: string;
let viewer: string;
let normal: string;
let blocked: string;
let muted: string;
let blocker: string;
let postId: string;
let mainCommentId: string;
let replyNormalId: string;
let replyBlockedId: string;
let replyMutedId: string;
let replyBlockerId: string;
let childOfBlockedId: string;
let childOfNormalId: string;
let childCommentId: string;
const allUserIds: string[] = [];
const allCommentIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/comments/[id]/route').GET;

async function fetchComment(id: string, headers?: Record<string, string>) {
  const request = new NextRequest(`http://localhost/api/comments/${id}`, {
    headers,
  });
  const response = await GET(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/comments/[id]/route'));

  [
    postAuthor,
    viewer,
    normal,
    blocked,
    muted,
    blocker,
    postId,
    mainCommentId,
    replyNormalId,
    replyBlockedId,
    replyMutedId,
    replyBlockerId,
    childOfBlockedId,
    childOfNormalId,
    childCommentId,
  ] = await Promise.all(
    Array.from({ length: 15 }, () => generateSnowflakeId())
  );
  allUserIds.push(postAuthor, viewer, normal, blocked, muted, blocker);
  allCommentIds.push(
    mainCommentId,
    replyNormalId,
    replyBlockedId,
    replyMutedId,
    replyBlockerId,
    childOfBlockedId,
    childOfNormalId,
    childCommentId
  );

  const now = new Date();
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const earlier = new Date(now.getTime() - 3_600_000);

  await db.insert(users).values([
    {
      id: postAuthor,
      username: `test-f75-p-${postAuthor}`,
      displayName: 'F75 Post Author',
      updatedAt: now,
    },
    {
      id: viewer,
      username: `test-f75-v-${viewer}`,
      displayName: 'F75 Viewer',
      updatedAt: now,
    },
    {
      id: normal,
      username: `test-f75-n-${normal}`,
      displayName: 'F75 Normal',
      updatedAt: now,
    },
    {
      id: blocked,
      username: `test-f75-b-${blocked}`,
      displayName: 'F75 Blocked',
      updatedAt: now,
    },
    {
      id: muted,
      username: `test-f75-m-${muted}`,
      displayName: 'F75 Muted',
      updatedAt: now,
    },
    {
      id: blocker,
      username: `test-f75-r-${blocker}`,
      displayName: 'F75 Blocker',
      updatedAt: now,
    },
  ]);
  await db
    .update(users)
    .set({ stewardId: 'f75-steward-viewer' })
    .where(eq(users.id, viewer));

  await db.insert(posts).values({
    id: postId,
    content: 'f75 fixture post',
    authorId: postAuthor,
    timestamp: earlier,
    createdAt: earlier,
  });

  // Thread under the post:
  //   main (normal)
  //   ├─ replyNormal (normal)
  //   │    └─ childOfNormal (blocked author)
  //   ├─ replyBlocked (blocked author)
  //   │    └─ childOfBlocked (normal)
  //   ├─ replyMuted (muted author)
  //   └─ replyBlocker (author who blocked the viewer)
  //   childComment (normal) hangs under replyBlocked, for the parent chain.
  await db.insert(comments).values([
    {
      id: mainCommentId,
      content: 'f75 main comment',
      postId,
      authorId: normal,
      parentCommentId: null,
      createdAt: at(0),
      updatedAt: at(0),
      deletedAt: null,
    },
    {
      id: replyNormalId,
      content: 'f75 reply by normal author',
      postId,
      authorId: normal,
      parentCommentId: mainCommentId,
      createdAt: at(10),
      updatedAt: at(10),
      deletedAt: null,
    },
    {
      id: replyBlockedId,
      content: 'f75 reply by blocked author',
      postId,
      authorId: blocked,
      parentCommentId: mainCommentId,
      createdAt: at(20),
      updatedAt: at(20),
      deletedAt: null,
    },
    {
      id: replyMutedId,
      content: 'f75 reply by muted author',
      postId,
      authorId: muted,
      parentCommentId: mainCommentId,
      createdAt: at(30),
      updatedAt: at(30),
      deletedAt: null,
    },
    {
      id: replyBlockerId,
      content: 'f75 reply by blocking author',
      postId,
      authorId: blocker,
      parentCommentId: mainCommentId,
      createdAt: at(40),
      updatedAt: at(40),
      deletedAt: null,
    },
    {
      id: childOfBlockedId,
      content: 'f75 visible reply under blocked root',
      postId,
      authorId: normal,
      parentCommentId: replyBlockedId,
      createdAt: at(50),
      updatedAt: at(50),
      deletedAt: null,
    },
    {
      id: childOfNormalId,
      content: 'f75 blocked reply under normal root',
      postId,
      authorId: blocked,
      parentCommentId: replyNormalId,
      createdAt: at(60),
      updatedAt: at(60),
      deletedAt: null,
    },
    {
      id: childCommentId,
      content: 'f75 child of blocked reply',
      postId,
      authorId: normal,
      parentCommentId: replyBlockedId,
      createdAt: at(70),
      updatedAt: at(70),
      deletedAt: null,
    },
  ]);

  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  await db.execute(sql`
    INSERT INTO "UserBlock" (id, "blockerId", "blockedId")
    VALUES (${blockRowA}, ${viewer}, ${blocked}),
           (${blockRowB}, ${blocker}, ${viewer})
  `);
  await db.execute(sql`
    INSERT INTO "UserMute" (id, "muterId", "mutedId")
    VALUES (${muteRow}, ${viewer}, ${muted})
  `);
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM "UserBlock" WHERE "blockerId" = ${viewer} OR "blockedId" = ${viewer}`
  );
  await db.execute(sql`DELETE FROM "UserMute" WHERE "muterId" = ${viewer}`);
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/comments/[id] viewer moderation', () => {
  it('returns every reply to an anonymous reader (control)', async () => {
    const { status, body } = await fetchComment(mainCommentId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.replies.map((r) => r.id)).toEqual([
      replyNormalId,
      replyBlockedId,
      replyMutedId,
      replyBlockerId,
    ]);
    // All seven descendants count, including the three nested replies.
    expect(detail.comment.replyCount).toBe(7);
    const normalReply = detail.replies.find((r) => r.id === replyNormalId);
    expect(normalReply?.replyCount).toBe(1);
  });

  it('hides blocked, muted and blocking authors from the signed-in viewer', async () => {
    const { status, body } = await fetchComment(
      mainCommentId,
      await viewerAuthHeaders()
    );
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.replies.map((r) => r.id)).toEqual([replyNormalId]);
    expect(JSON.stringify(detail.replies)).not.toContain('by blocked author');
    expect(JSON.stringify(detail.replies)).not.toContain('by muted author');
    expect(JSON.stringify(detail.replies)).not.toContain('by blocking author');
    // Only the visible authors' descendants count: replyNormal plus the
    // two normal-author replies under the blocked root — counted exactly
    // as visible replies under soft-deleted parents already are on this
    // route. The blocked author's reply under the normal root drops out,
    // so the normal reply's own count is 0 as well.
    expect(detail.comment.replyCount).toBe(3);
    const normalReply = detail.replies.find((r) => r.id === replyNormalId);
    expect(normalReply?.replyCount).toBe(0);
  });

  it('does not leak an excluded author through the parent chain', async () => {
    const { status, body } = await fetchComment(
      childCommentId,
      await viewerAuthHeaders()
    );
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    // The blocked parent is skipped like a soft-deleted parent is; the
    // visible grandparent (the main comment) still shows, and the reply
    // is not attributed to it.
    expect(detail.parentChain.map((p) => p.id)).toEqual([mainCommentId]);
    expect(detail.comment.parentComment).toBeNull();
    expect(JSON.stringify(detail.parentChain)).not.toContain(
      'by blocked author'
    );
  });
});
