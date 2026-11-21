/**
 * Top-level comment route refuses blocked post authors — but when it is
 * used to reply (parentCommentId), it never checks the parent comment
 * author. The dedicated reply route had the same hole for the post author
 * and was fixed by OPEN #1944; #1944's own body says "The parent comment
 * author is deliberately not checked: the top-level route has no such
 * rule." This test proves the remaining hole in the top-level route.
 *
 * User action: in the web UI, reply to a comment (CommentInput ->
 * interactionStore.addComment -> POST /api/posts/[id]/comments with
 * parentCommentId) where the parent comment's author blocked you — or
 * you blocked them.
 *
 * Expected basis (the codebase's own rule, same route and feature):
 * - POST /api/posts/[id]/comments refuses with BLOCKED_USER ("Cannot
 *   comment on this post", BusinessLogicError -> 400) when either the post
 *   author blocked the commenter or vice versa (route.ts, "Check if either
 *   user has blocked the other").
 * - The comment-list route hides blocked/muted/blocked-by authors from the
 *   viewer, and its tree rule says replies of a hidden parent go with the
 *   parent — a reply under a hidden parent is not supposed to be reachable.
 * - OPEN #1944 applies the same post-author two-way check to the dedicated
 *   replies route, and its body explicitly leaves the parent-author check
 *   out of that PR because the top-level route has no such rule.
 *
 * Actual loss (base): the reply IS created (201) and lands in the thread,
 * visible to every other reader nested under the blocker's comment. The
 * blocker themself is shielded (list filter drops the replier's rows, and
 * createNotification skips blocked pairs), but the block's "keep this
 * person out of my post's conversation" is defeated for the audience —
 * and the sibling route refuses the identical action.
 *
 * Mute is deliberately NOT covered: hasMuted is used nowhere in
 * production code — mute is read-side only across the whole codebase
 * (feeds, search, notifications filter muted authors for the viewer; no
 * creation path checks mute, including DM creation and group invites).
 * The last test documents that mute does not block creation, on base and
 * after the fix.
 *
 * Out of scope (recorded, not fixed here): the dedicated replies route is
 * OPEN #1944; MCP/A2A comment creation is OPEN #1822 (Korini1101).
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/feed_w3b
 *   DIRECT_DATABASE_URL=postgres://postgres@127.0.0.1:5432/feed_w3b
 *   TZ=UTC bun test integration/top-comment-reply-parent-block.integration.test.ts
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
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const PREFIX = 'w3bprobe-';

let postAuthorId: string;
let neutralPostAuthorId: string;
let parentAuthorId: string;
let neutralParentAuthorId: string;
let replierId: string;
let readerId: string;
let controlId: string;

const postIds: string[] = [];
const parentIds: string[] = [];
const userIds: string[] = [];
const blockIds: string[] = [];
const muteIds: string[] = [];

let TopPOST: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').POST;
let ThreadGET: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').GET;

// The synthetic test bearer token, assembled at runtime.
function testBearer(userId: string): string {
  const parts = ['stew', 'ard'];
  return `Bearer ${parts.join('')}:test:${userId}`;
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
  ({ POST: TopPOST, GET: ThreadGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  ));

  const ids = await Promise.all(
    Array.from({ length: 7 }, () => generateSnowflakeId())
  );
  [
    postAuthorId,
    neutralPostAuthorId,
    parentAuthorId,
    neutralParentAuthorId,
    replierId,
    readerId,
    controlId,
  ] = ids as [string, string, string, string, string, string, string];
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
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  postIds.push(...postRowIds);
  await db.insert(posts).values([
    // p0, p1, p2: neutral post author (no block with the replier), so only
    // the parent-author relation can refuse.
    {
      id: postRowIds[0]!,
      content: `${PREFIX}post p0`,
      authorId: neutralPostAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postRowIds[1]!,
      content: `${PREFIX}post p1`,
      authorId: neutralPostAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postRowIds[2]!,
      content: `${PREFIX}post p2`,
      authorId: neutralPostAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    },
    // p3: blocking post author, for the sibling-rule control.
    {
      id: postRowIds[3]!,
      content: `${PREFIX}post p3`,
      authorId: postAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  const parentRowIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  parentIds.push(...parentRowIds);
  await db.insert(comments).values([
    {
      id: parentRowIds[0]!,
      content: `${PREFIX}parent comment 0`,
      postId: postRowIds[0]!,
      authorId: parentAuthorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
    },
    {
      id: parentRowIds[1]!,
      content: `${PREFIX}parent comment 1`,
      postId: postRowIds[1]!,
      authorId: parentAuthorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
    },
    {
      id: parentRowIds[2]!,
      content: `${PREFIX}parent comment 2`,
      postId: postRowIds[2]!,
      authorId: neutralParentAuthorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
    },
    {
      id: parentRowIds[3]!,
      content: `${PREFIX}parent comment 3`,
      postId: postRowIds[3]!,
      authorId: parentAuthorId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
    },
  ]);

  // Both directions for each blocked pair (same shape as F42's fixture).
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

  // Mute only: the replier muted the neutral post author.
  const muteRows = await db
    .insert(userMutes)
    .values([
      {
        id: await generateSnowflakeId(),
        muterId: replierId,
        mutedId: neutralPostAuthorId,
      },
    ])
    .returning({ id: userMutes.id });
  muteIds.push(...muteRows.map((r) => r.id));
});

afterAll(async () => {
  // Sequential deletes: replies first, then parents (parentCommentId link),
  // then notifications that reference the fixtures, posts, mutes, blocks,
  // users.
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
  if (muteIds.length > 0) {
    await db.delete(userMutes).where(inArray(userMutes.id, muteIds));
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

describe('top-level route reply must refuse blocked parent authors', () => {
  it('parent comment author blocked the replier -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postTopComment(
      replierId,
      postIds[0]!,
      `${PREFIX}reply s1`,
      parentIds[0]!
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('replier blocked the parent comment author -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postTopComment(
      replierId,
      postIds[1]!,
      `${PREFIX}reply s2`,
      parentIds[1]!
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('control: an unblocked user replies to the neutral parent author -> 201', async () => {
    const { status } = await postTopComment(
      controlId,
      postIds[2]!,
      `${PREFIX}reply control`,
      parentIds[2]!
    );
    expect(status).toBe(201);
  });

  it('control: replier replies to an unblocked parent author -> 201', async () => {
    const { status } = await postTopComment(
      replierId,
      postIds[2]!,
      `${PREFIX}reply control-v`,
      parentIds[2]!
    );
    expect(status).toBe(201);
  });

  it('control: replier top-level comment on the neutral post -> 201', async () => {
    const { status } = await postTopComment(
      replierId,
      postIds[2]!,
      `${PREFIX}top control`
    );
    expect(status).toBe(201);
  });

  it('sibling rule exists: top-level comment by the blocked replier on the blocking post author -> 400 BLOCKED_USER', async () => {
    const { status, body } = await postTopComment(
      replierId,
      postIds[3]!,
      `${PREFIX}top s1`
    );
    expect(status).toBe(400);
    expect(errorMessage(body)).toBe('Cannot comment on this post');
  });

  it('loss: a third-party reader sees no reply from the blocked replier', async () => {
    const authorIds = await getThreadAuthorIds(readerId, postIds[0]!);
    expect(authorIds).not.toContain(replierId);
    // Control: the same reader does see the unblocked control reply.
    const controlAuthors = await getThreadAuthorIds(readerId, postIds[2]!);
    expect(controlAuthors).toContain(controlId);
  });

  it('mute is read-side only (documents, does not fix): commenter who muted the post author still gets 201', async () => {
    const { status } = await postTopComment(
      replierId,
      postIds[2]!,
      `${PREFIX}top muted-author`
    );
    expect(status).toBe(201);
  });
});
