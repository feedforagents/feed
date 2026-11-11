/**
 * PRD §§6.1/12 and MVP Phase 5 preserve public posts and moderation.
 * GET /api/posts/[id] against a real database: the `commentCount` in the
 * response is the number shown at the top of the post detail screen, and it
 * must equal the number of comments the comment list for the same post
 * actually delivers.
 *
 * Scenario: moderation hides a parent comment (the admin content-queue
 * "hide" action sets comments.deletedAt on that one row; it does not
 * cascade). The replies under it — including a nested grandchild — stay
 * non-deleted, but the comment list's tree rule omits the whole subtree:
 * "Comments whose parent is not visible (e.g. hidden by moderation) are
 * unreachable from the root and therefore omitted with their parent." The
 * base detail route counts every non-deleted row, so the header promises
 * comments that are not in the list below it. Sibling counts already follow
 * the count-only-what-is-visible rule (#1658 following-feed comment counts,
 * and the comment list's own total).
 *
 * A reply that is itself soft-deleted is included as a control: both routes
 * already exclude it, before and after.
 *
 * Several comments share one createdAt timestamp to cover the
 * equal-timestamp axis.
 *
 * The real routes and database are used. Only the server-only environment
 * marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  eq,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

type CommentNode = {
  id: string;
  replies: CommentNode[];
};

type PostResponse = {
  success: boolean;
  data: { id: string; commentCount: number };
};

type CommentsResponse = {
  success: boolean;
  data: { comments: CommentNode[]; total: number };
};

function ownership() {
  return {
    users: new Set<string>(),
    posts: new Set<string>(),
    comments: new Set<string>(),
    blocks: new Set<string>(),
    mutes: new Set<string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

let authorId: string;
let commenterId: string;
let postId: string;
let parentCommentId: string;

// Signed-viewer regression (maintainer follow-up on #1698): the viewer
// blocks one author, mutes another, and is blocked by a third. Their
// comments — and the replies under them — must be invisible to the viewer
// in both the list and the detail count, while an anonymous read still
// sees them. A second fixture post keeps this case independent of the
// hide flow above.
let viewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockerAuthorId: string;
let viewerPostId: string;
let token: string;

let getPost: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let getComments: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const postRoutePath = '../../../apps/web/src/app/api/posts/[id]/route';
const commentsRoutePath =
  '../../../apps/web/src/app/api/posts/[id]/comments/route';

function flattenIds(nodes: CommentNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...flattenIds(node.replies)]);
}

async function fetchPostCommentCount(
  targetPostId: string = postId,
  headers: Record<string, string> = {}
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}`, { headers })
  );
  const response = await getPost(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchDeliveredCommentIds(
  targetPostId: string = postId,
  headers: Record<string, string> = {}
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}/comments`, {
      headers,
    })
  );
  const response = await getComments(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

// The signed-viewer case uses a short-lived synthetic steward JWT (the
// same pattern as the following-feed count test): the public routes resolve
// the viewer through optionalAuth, which only accepts real steward JWTs —
// the `steward:test:` bearer works for required-auth routes only.
function signedViewerHeaders() {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(receipts: Ownership) {
  // Delete only successful INSERT identities, children before their parents.
  // A failed table must not prevent the remaining owned cleanup attempts.
  const actions = [
    {
      ids: receipts.comments,
      remove: () =>
        db
          .delete(comments)
          .where(inArray(comments.id, [...receipts.comments]))
          .returning({ id: comments.id }),
    },
    {
      ids: receipts.blocks,
      remove: () =>
        db
          .delete(userBlocks)
          .where(inArray(userBlocks.id, [...receipts.blocks]))
          .returning({ id: userBlocks.id }),
    },
    {
      ids: receipts.mutes,
      remove: () =>
        db
          .delete(userMutes)
          .where(inArray(userMutes.id, [...receipts.mutes]))
          .returning({ id: userMutes.id }),
    },
    {
      ids: receipts.posts,
      remove: () =>
        db
          .delete(posts)
          .where(inArray(posts.id, [...receipts.posts]))
          .returning({ id: posts.id }),
    },
    {
      ids: receipts.users,
      remove: () =>
        db
          .delete(users)
          .where(inArray(users.id, [...receipts.users]))
          .returning({ id: users.id }),
    },
  ];
  const failures: Error[] = [];
  for (const { ids, remove } of actions) {
    if (ids.size === 0) continue;
    try {
      for (const row of await remove()) ids.delete(row.id);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (Object.values(receipts).some((ids) => ids.size > 0))
    failures.push(
      new Error('Owned comment-count identities remain after cleanup')
    );
  if (failures.length)
    throw new AggregateError(failures, 'Owned comment-count cleanup failed');
}

async function collisionUser(id: string, tag: string, registry: Set<string>) {
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `g22-${tag}-${id}`,
      displayName: 'Comment Count Cleanup Fixture',
      isTest: true,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  for (const row of inserted) registry.add(row.id);
  expect(inserted).toEqual([{ id }]);
}

beforeAll(async () => {
  ({ GET: getPost } = await import(postRoutePath));
  ({ GET: getComments } = await import(commentsRoutePath));

  [authorId, commenterId, postId, parentCommentId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const [childId, grandchildId, visibleTopId, visibleReplyId, deletedReplyId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  // One shared timestamp for the parent, its subtree, and the visible
  // top-level comment (equal-timestamp axis).
  const sharedTs = new Date(now.getTime() - 30_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `g22a-${authorId}`,
        displayName: 'Post Detail Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `g22c-${commenterId}`,
        displayName: 'Post Detail Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedPost = await db
    .insert(posts)
    .values({
      id: postId,
      content: 'fixture post for post detail comment count',
      authorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of insertedPost) owned.posts.add(row.id);

  const insertedComments = await db
    .insert(comments)
    .values([
      {
        id: parentCommentId,
        content: 'parent comment that moderation will hide',
        postId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: sharedTs,
        updatedAt: sharedTs,
        deletedAt: null,
      },
      {
        id: childId,
        content: 'reply under the soon-to-be-hidden parent',
        postId,
        authorId: authorId,
        parentCommentId,
        createdAt: sharedTs,
        updatedAt: sharedTs,
        deletedAt: null,
      },
      {
        id: grandchildId,
        content: 'nested reply under the hidden parent subtree',
        postId,
        authorId: commenterId,
        parentCommentId: childId,
        createdAt: sharedTs,
        updatedAt: sharedTs,
        deletedAt: null,
      },
      {
        id: visibleTopId,
        content: 'visible top-level comment',
        postId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: sharedTs,
        updatedAt: sharedTs,
        deletedAt: null,
      },
      {
        id: visibleReplyId,
        content: 'visible reply',
        postId,
        authorId: authorId,
        parentCommentId: visibleTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: deletedReplyId,
        content: 'reply that is itself soft-deleted (control)',
        postId,
        authorId: authorId,
        parentCommentId: visibleTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);

  // Signed-viewer fixture on its own post: one visible top-level comment
  // with a reply, one top-level comment each from a blocked, a muted, and
  // a blocking author (each with a visible-author reply underneath, so the
  // hidden-parent subtree rule is exercised through moderation too), and
  // one moderation-hidden top-level comment with a reply.
  [viewerId, blockedAuthorId, mutedAuthorId, blockerAuthorId, viewerPostId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const [
    viewerVisibleTopId,
    viewerVisibleReplyId,
    viewerBlockedTopId,
    viewerBlockedReplyId,
    viewerMutedTopId,
    viewerMutedReplyId,
    viewerBlockerTopId,
    viewerBlockerReplyId,
    viewerHiddenTopId,
    viewerHiddenReplyId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const viewerStewardId = `g22-detail-${viewerId}`;

  const insertedViewerUsers = await db
    .insert(users)
    .values([
      {
        id: viewerId,
        username: `g22v-${viewerId}`,
        displayName: 'Post Detail Viewer',
        stewardId: viewerStewardId,
        updatedAt: now,
      },
      {
        id: blockedAuthorId,
        username: `g22b-${blockedAuthorId}`,
        displayName: 'Blocked Comment Author',
        updatedAt: now,
      },
      {
        id: mutedAuthorId,
        username: `g22m-${mutedAuthorId}`,
        displayName: 'Muted Comment Author',
        updatedAt: now,
      },
      {
        id: blockerAuthorId,
        username: `g22k-${blockerAuthorId}`,
        displayName: 'Blocking Comment Author',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedViewerUsers) owned.users.add(row.id);
  // Register the viewer before signing or any later setup await can fail.
  token = await createStewardTestToken(viewerStewardId);

  const insertedViewerPost = await db
    .insert(posts)
    .values({
      id: viewerPostId,
      content: 'fixture post for signed-viewer post detail comment count',
      authorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of insertedViewerPost) owned.posts.add(row.id);

  const insertedViewerComments = await db
    .insert(comments)
    .values([
      {
        id: viewerVisibleTopId,
        content: 'visible top-level comment for the viewer',
        postId: viewerPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerVisibleReplyId,
        content: 'visible reply for the viewer',
        postId: viewerPostId,
        authorId: authorId,
        parentCommentId: viewerVisibleTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerBlockedTopId,
        content: 'top-level comment by the blocked author',
        postId: viewerPostId,
        authorId: blockedAuthorId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerBlockedReplyId,
        content: 'reply under the blocked author comment',
        postId: viewerPostId,
        authorId: authorId,
        parentCommentId: viewerBlockedTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerMutedTopId,
        content: 'top-level comment by the muted author',
        postId: viewerPostId,
        authorId: mutedAuthorId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerMutedReplyId,
        content: 'reply under the muted author comment',
        postId: viewerPostId,
        authorId: commenterId,
        parentCommentId: viewerMutedTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerBlockerTopId,
        content: 'top-level comment by the author who blocked the viewer',
        postId: viewerPostId,
        authorId: blockerAuthorId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerBlockerReplyId,
        content: 'reply under the blocking author comment',
        postId: viewerPostId,
        authorId: authorId,
        parentCommentId: viewerBlockerTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: viewerHiddenTopId,
        content: 'moderation-hidden top-level comment',
        postId: viewerPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
      {
        id: viewerHiddenReplyId,
        content: 'reply under the moderation-hidden comment',
        postId: viewerPostId,
        authorId: authorId,
        parentCommentId: viewerHiddenTopId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedViewerComments) owned.comments.add(row.id);

  const [viewerBlockId, viewerBlockerBlockId, viewerMuteId] = await Promise.all(
    [generateSnowflakeId(), generateSnowflakeId(), generateSnowflakeId()]
  );
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: viewerBlockId, blockerId: viewerId, blockedId: blockedAuthorId },
      {
        id: viewerBlockerBlockId,
        blockerId: blockerAuthorId,
        blockedId: viewerId,
      },
    ])
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) owned.blocks.add(row.id);
  const insertedMutes = await db
    .insert(userMutes)
    .values({ id: viewerMuteId, muterId: viewerId, mutedId: mutedAuthorId })
    .returning({ id: userMutes.id });
  for (const row of insertedMutes) owned.mutes.add(row.id);
});

afterAll(async () => cleanup(owned));

describe('GET /api/posts/[id] commentCount', () => {
  it('commentCount equals the number of comments the list delivers', async () => {
    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    // Five comments are reachable; the soft-deleted reply is excluded by
    // both routes already.
    expect(delivered).toHaveLength(5);

    const { status, body } = await fetchPostCommentCount();
    expect(status).toBe(200);
    expect((body as PostResponse).data.commentCount).toBe(delivered.length);
  });

  it('does not count replies whose parent was hidden by moderation', async () => {
    // The admin content-queue "hide" action: soft-delete the one row.
    await db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(eq(comments.id, parentCommentId));

    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    // The hidden parent and its whole (non-deleted) subtree are absent from
    // the tree; only the visible top-level comment and its reply remain.
    expect(delivered).toHaveLength(2);
    expect(delivered).not.toContain(parentCommentId);

    const { status, body } = await fetchPostCommentCount();
    expect(status).toBe(200);
    // The header count must promise only what the list below it shows.
    expect((body as PostResponse).data.commentCount).toBe(2);
    expect((body as PostResponse).data.commentCount).toBe(delivered.length);
  });

  it('signed viewer: detail count matches the list total with blocked/muted authors and a hidden parent', async () => {
    // Anonymous control first: the blocked, muted, and blocking authors'
    // top-level comments and their replies are all visible without a
    // viewer (6), plus the visible pair (2). The moderation-hidden parent
    // and its reply are excluded for everyone.
    const anonList = await fetchDeliveredCommentIds(viewerPostId);
    expect(anonList.status).toBe(200);
    const anonDelivered = flattenIds(
      (anonList.body as CommentsResponse).data.comments
    );
    expect(anonDelivered).toHaveLength(8);
    expect((anonList.body as CommentsResponse).data.total).toBe(8);
    const anonDetail = await fetchPostCommentCount(viewerPostId);
    expect(anonDetail.status).toBe(200);
    expect((anonDetail.body as PostResponse).data.commentCount).toBe(8);

    // Signed as the viewer: only the visible pair remains. The blocked,
    // muted, and blocking authors' comments go with their replies, and
    // the moderation-hidden parent takes its reply with it.
    const signedList = await fetchDeliveredCommentIds(
      viewerPostId,
      signedViewerHeaders()
    );
    expect(signedList.status).toBe(200);
    const signedDelivered = flattenIds(
      (signedList.body as CommentsResponse).data.comments
    );
    expect(signedDelivered).toHaveLength(2);
    expect((signedList.body as CommentsResponse).data.total).toBe(2);

    const signedDetail = await fetchPostCommentCount(
      viewerPostId,
      signedViewerHeaders()
    );
    expect(signedDetail.status).toBe(200);
    // The header count must match the list total for the same viewer, and
    // must actually apply the viewer filter (not read as anonymous).
    expect((signedDetail.body as PostResponse).data.commentCount).toBe(2);
    expect((signedDetail.body as PostResponse).data.commentCount).toBe(
      signedDelivered.length
    );
    expect((signedDetail.body as PostResponse).data.commentCount).toBeLessThan(
      (anonDetail.body as PostResponse).data.commentCount
    );
  });

  it('partial setup cleanup preserves an independently inserted collision user', async () => {
    const partial = ownership();
    const control = ownership();
    const controlId = await generateSnowflakeId();
    const partialId = await generateSnowflakeId();
    try {
      await collisionUser(controlId, 'survivor', control.users);
      const [before] = await db
        .select()
        .from(users)
        .where(eq(users.id, controlId));
      expect(before?.id).toBe(controlId);
      await collisionUser(partialId, 'partial', partial.users);
      await expect(
        collisionUser(controlId, 'collision', partial.users)
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect([...partial.users]).toEqual([partialId]);
      await cleanup(partial);
      expect(
        await db.select().from(users).where(eq(users.id, partialId))
      ).toEqual([]);
      const [after] = await db
        .select()
        .from(users)
        .where(eq(users.id, controlId));
      expect(after).toEqual(before);
      await cleanup(partial); // Repeating successful cleanup is harmless.
    } finally {
      const results = await Promise.allSettled([
        cleanup(partial),
        cleanup(control),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ]
          : []
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          'Partial comment-count cleanup failed'
        );
    }
  });
});
