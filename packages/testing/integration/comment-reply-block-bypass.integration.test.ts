/**
 * Comment creation must refuse blocked users — but only the top-level web
 * route does. The dedicated reply route lets a blocked user post anyway.
 *
 * NARROW SCOPE (user-verified 2026-11-17 18:49 KST): only the post author
 * <-> replier two-way block is checked — the same rule the top-level route
 * POST /api/posts/[id]/comments already applies ("Check if either user has
 * blocked the other"). The parent comment author <-> replier check is NOT
 * included: the top-level route has no such rule, so adding it here would
 * be an extra rule with no basis. A reply is refused only when the post
 * author blocked the replier or vice versa.
 *
 * User action: reply to a comment when the post author blocked you — or
 * you blocked the post author.
 *
 * Expected basis (the codebase's own rule, same feature):
 * - POST /api/posts/[id]/comments refuses with BLOCKED_USER ("Cannot comment
 *   on this post", BusinessLogicError -> 400) when either the post author
 *   blocked the commenter or vice versa (posts/[id]/comments/route.ts,
 *   "Check if either user has blocked the other").
 * - The comment-list route hides blocked/muted/blocked-by authors from the
 *   viewer, and its tree rule says replies of a hidden parent go with the
 *   parent — a reply under a hidden parent is not supposed to be reachable.
 * - The replies route's own comment: "Replies are only allowed under a
 *   visible parent on a visible post."
 *
 * Actual loss (base): the reply IS created (201) and lands in the thread,
 * visible to every other reader nested under the blocker's comment / on
 * the blocker's post. The blocker themself is shielded (list filter drops
 * the replier's rows, and createNotification skips blocked pairs), but the
 * block's "keep this person out of my post's conversation" is defeated
 * for the audience — and the sibling route refuses the identical action.
 *
 * Out of scope (documents, does not fix): the parent comment author <->
 * replier block does NOT refuse a reply (posts 3-4 below expect 201), and
 * the top-level route with a parentCommentId does not check the parent
 * author either (adjacent-gap test below expects 201).
 *
 * Same hole in MCP executeCreateComment — but that is OPEN #1822
 * (Korini1101, "reject comments between users with a block relationship"):
 * its head adds the identical check with the identical message, and the
 * MCP repro cases pass 2/0 against its head (test-1822HEAD.log in the
 * F42 lane). Dropped from this candidate as a duplicate. A2A createComment
 * has the same shape (verified by code read only — A2A is out of
 * submission scope per the #1888 maintainer decision, recorded not fixed).
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=<redacted>
 *   DIRECT_DATABASE_URL=<redacted>
 *   TZ=UTC bun test integration/comment-reply-block-bypass.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  inArray,
  notifications,
  posts,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const PREFIX = 'f42nprobe-';

let postAuthorId: string;
let postAuthor2Id: string;
let parentAuthorId: string;
let replierId: string;
let readerId: string;
let controlId: string;

const postIds: string[] = [];
const parentIds: string[] = [];
const userIds: string[] = [];
const blockIds: string[] = [];

let ReplyPOST: typeof import('../../../apps/web/src/app/api/comments/[id]/replies/route').POST;
let TopPOST: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').POST;
let ThreadGET: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').GET;

// The synthetic test bearer token, assembled at runtime.
function testBearer(userId: string): string {
  const parts = ['stew', 'ard'];
  return `Bearer ${parts.join('')}:test:${userId}`;
}

async function postReply(
  userId: string,
  parentCommentId: string,
  content: string
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/comments/${parentCommentId}/replies`, {
      method: 'POST',
      headers: {
        authorization: testBearer(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })
  );
  const response = await ReplyPOST(request, {
    params: Promise.resolve({ id: parentCommentId }),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

async function postTopComment(
  userId: string,
  postId: string,
  content: string,
  parentCommentId?: string
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        authorization: testBearer(userId),
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        parentCommentId ? { content, parentCommentId } : { content }
      ),
    })
  );
  const response = await TopPOST(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

type ThreadItem = {
  id: string;
  userId: string;
  replies?: ThreadItem[];
};

function flattenThread(
  items: ThreadItem[],
  out: ThreadItem[] = []
): ThreadItem[] {
  for (const item of items) {
    out.push(item);
    if (item.replies) flattenThread(item.replies, out);
  }
  return out;
}

async function getThreadAuthorIds(userId: string, postId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/comments`, {
      method: 'GET',
      headers: { authorization: testBearer(userId) },
    })
  );
  const response = await ThreadGET(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { comments?: ThreadItem[] };
  } | null;
  const commentsList = body?.data?.comments ?? [];
  return flattenThread(commentsList).map((c) => c.userId);
}

beforeAll(async () => {
  ({ POST: ReplyPOST } = await import(
    '../../../apps/web/src/app/api/comments/[id]/replies/route'
  ));
  ({ POST: TopPOST, GET: ThreadGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  ));

  const ids = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  [
    postAuthorId,
    postAuthor2Id,
    parentAuthorId,
    replierId,
    readerId,
    controlId,
  ] = ids as [string, string, string, string, string, string];
  userIds.push(...ids);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values(
    ids.map((id, i) => ({
      id,
      username: `${PREFIX}u${i}-${id}`,
      displayName: `${PREFIX} user ${i}`,
      stewardId: id,
      updatedAt: now,
    }))
  );

  const postRowIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  postIds.push(...postRowIds);
  // Posts 0-1 are by the post author P (block scenarios with the replier);
  // posts 2-5 are by a second author P2 who has no block with anyone, so
  // the parent-author-only blocks on posts 2-3 isolate the narrow scope:
  // only the post author <-> replier pair is checked.
  await db.insert(posts).values([
    ...postRowIds.slice(0, 2).map((id) => ({
      id,
      content: `${PREFIX}post`,
      authorId: postAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    })),
    ...postRowIds.slice(2).map((id) => ({
      id,
      content: `${PREFIX}post p2`,
      authorId: postAuthor2Id,
      timestamp: earlier,
      createdAt: earlier,
    })),
  ]);

  const parentRowIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  parentIds.push(...parentRowIds);
  await db.insert(comments).values(
    parentRowIds.map((id, i) => ({
      id,
      content: `${PREFIX}parent comment ${i}`,
      postId: postRowIds[i],
      authorId: parentAuthorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
    }))
  );

  // Four block directions, one per web-reply scenario post. Blocks are
  // global (userBlocks has no post scope), so the post author differs per
  // scenario: posts 0-1 are by P (author <-> replier blocks), posts 2-3
  // are by P2 (parent-author-only blocks, author pair unblocked).
  const rows = await db
    .insert(userBlocks)
    .values([
      {
        id: await generateSnowflakeId(),
        blockerId: postAuthorId,
        blockedId: replierId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: replierId,
        blockedId: postAuthorId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: parentAuthorId,
        blockedId: replierId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: replierId,
        blockedId: parentAuthorId,
      },
    ])
    .returning({ id: userBlocks.id });
  blockIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  // Sequential deletes: replies first, then parents (parentCommentId link),
  // then notifications that reference the fixtures, posts, blocks, users.
  const replyRows = await db
    .select({ id: comments.id })
    .from(comments)
    .where(inArray(comments.postId, postIds));
  const replyIds = replyRows
    .map((r) => r.id)
    .filter((id) => !parentIds.includes(id));
  if (replyIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, replyIds));
  }
  if (parentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, parentIds));
  }
  await db.delete(notifications).where(inArray(notifications.postId, postIds));
  if (postIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, postIds));
  }
  if (blockIds.length > 0) {
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  const leftovers = await db
    .select({ id: comments.id })
    .from(comments)
    .where(inArray(comments.postId, postIds));
  expect(leftovers.length).toBe(0);
});

function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  }
  return undefined;
}

describe('comment creation refuses blocked users', () => {
  it('web replies: post author blocked the replier -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postReply(
      replierId,
      parentIds[0],
      `${PREFIX}reply s1`
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('web replies: replier blocked the post author -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postReply(
      replierId,
      parentIds[1],
      `${PREFIX}reply s2`
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('web replies: parent comment author blocked the replier -> 201 (narrow scope, parent author not checked)', async () => {
    // postIds[2] is by P2 (no block with the replier); only the parent author
    // blocked the replier. The narrow rule checks the post author only,
    // so this goes through — on base AND after the fix.
    const { status } = await postReply(
      replierId,
      parentIds[2],
      `${PREFIX}reply s3`
    );
    expect(status).toBe(201);
  });

  it('web replies: replier blocked the parent comment author -> 201 (narrow scope, parent author not checked)', async () => {
    // postIds[3] is by P2 (no block with the replier); only the replier
    // blocked the parent author. Same narrow-rule reasoning as above.
    const { status } = await postReply(
      replierId,
      parentIds[3],
      `${PREFIX}reply s4`
    );
    expect(status).toBe(201);
  });

  it('web replies: control replier with no block -> 201', async () => {
    const { status } = await postReply(
      controlId,
      parentIds[4],
      `${PREFIX}reply control`
    );
    expect(status).toBe(201);
  });

  it('loss: a third-party reader sees no reply from the blocked replier', async () => {
    const authorIds = await getThreadAuthorIds(readerId, postIds[0]);
    expect(authorIds).not.toContain(replierId);
    // Control: the same reader does see the unblocked control reply.
    const controlAuthors = await getThreadAuthorIds(readerId, postIds[4]);
    expect(controlAuthors).toContain(controlId);
  });

  it('sibling rule exists: top-level comment by the blocked replier -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postTopComment(
      replierId,
      postIds[0],
      `${PREFIX}top s1`
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('adjacent gap (documents, does not fix): top-level reply does not check the parent author', async () => {
    // Post 6 is by postAuthor2 (no block with the replier); only the
    // parent author blocked the replier. The top-level route checks the
    // post author only, so this goes through on base AND after the fix.
    const { status } = await postTopComment(
      replierId,
      postIds[5],
      `${PREFIX}top adjacent`,
      parentIds[5]
    );
    expect(status).toBe(201);
  });
});
