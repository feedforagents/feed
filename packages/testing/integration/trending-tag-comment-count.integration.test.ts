/**
 * PRD §§6.1/12 and MVP Phase 5 preserve public posts and moderation.
 * GET /api/trending/[tag] against a real database: the `commentCount` on a
 * tag-feed card must promise only what the post detail screen shows for
 * the same post (#1994 rule, already applied to the main post list by
 * #2100 and to For You cards by #2115).
 *
 * Scenario: moderation hides a parent comment (the admin content-queue
 * "hide" action sets comments.deletedAt on that one row; it does not
 * cascade). The replies under it stay non-deleted, but the detail
 * screen's reachable tree omits the whole subtree. The tag route counts
 * every comment row for the post, so the card promises comments the
 * detail screen never shows. A soft-deleted reply under a visible parent
 * is included as a control: both routes already exclude it.
 *
 * The real routes and database are used. Only the server-only environment
 * marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  inArray,
  posts,
  postTags,
  tags,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

type TagPost = {
  id: string;
  commentCount: number;
};

type TagResponse = {
  success: boolean;
  posts: TagPost[];
};

type PostResponse = {
  data: { id: string; commentCount: number };
};

function ownership() {
  return {
    users: new Set<string>(),
    posts: new Set<string>(),
    comments: new Set<string>(),
    tags: new Set<string>(),
    postTags: new Set<string>(),
    blocks: new Set<string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

let authorId: string;
let commenterId: string;
let replyAuthorId: string;
let viewerId: string;
let tagId: string;
let tagName: string;
let mixedPostId: string;
let controlPostId: string;
let token: string;

let getTagPosts: (
  request: NextRequest,
  context: { params: Promise<{ tag: string }> }
) => Promise<Response>;
let getPost: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const tagRoutePath = '../../../apps/web/src/app/api/trending/[tag]/route';
const postRoutePath = '../../../apps/web/src/app/api/posts/[id]/route';

async function fetchTagCounts(
  headers: Record<string, string> = {}
): Promise<Map<string, number>> {
  const request = new NextRequest(
    new Request(`http://localhost/api/trending/${tagName}?limit=20`, {
      headers,
    })
  );
  const response = await getTagPosts(request, {
    params: Promise.resolve({ tag: tagName }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as TagResponse;
  expect(body.success).toBe(true);
  return new Map(body.posts.map((post) => [post.id, post.commentCount]));
}

async function fetchDetailCount(
  targetPostId: string,
  headers: Record<string, string> = {}
): Promise<number> {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}`, { headers })
  );
  const response = await getPost(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as PostResponse;
  return body.data.commentCount;
}

function signedViewerHeaders() {
  return { authorization: `Bearer ${token}` };
}

async function cleanup(receipts: Ownership) {
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
      ids: receipts.postTags,
      remove: () =>
        db
          .delete(postTags)
          .where(inArray(postTags.id, [...receipts.postTags]))
          .returning({ id: postTags.id }),
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
      ids: receipts.posts,
      remove: () =>
        db
          .delete(posts)
          .where(inArray(posts.id, [...receipts.posts]))
          .returning({ id: posts.id }),
    },
    {
      ids: receipts.tags,
      remove: () =>
        db
          .delete(tags)
          .where(inArray(tags.id, [...receipts.tags]))
          .returning({ id: tags.id }),
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
      new Error('Owned tag comment-count identities remain after cleanup')
    );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned tag comment-count cleanup failed'
    );
}

beforeAll(async () => {
  ({ GET: getTagPosts } = await import(tagRoutePath));
  ({ GET: getPost } = await import(postRoutePath));

  [
    authorId,
    commenterId,
    replyAuthorId,
    viewerId,
    tagId,
    mixedPostId,
    controlPostId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  tagName = `r5f1-tag-${authorId}`;
  const viewerClaim = `steward-r5f1-${viewerId}`;
  token = await createStewardTestToken(viewerClaim);

  const [
    visibleTopId,
    visibleReplyId,
    deletedParentId,
    hiddenReplyId,
    hiddenGrandchildId,
    deletedReplyId,
    controlCommentId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `r5f1-author-${authorId}`,
        displayName: 'Tag Comment Count Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `r5f1-commenter-${commenterId}`,
        displayName: 'Tag Comment Count Commenter',
        updatedAt: now,
      },
      {
        id: replyAuthorId,
        username: `r5f1-replier-${replyAuthorId}`,
        displayName: 'Tag Comment Count Replier',
        updatedAt: now,
      },
      {
        id: viewerId,
        username: `r5f1-viewer-${viewerId}`,
        displayName: 'Tag Comment Count Viewer',
        stewardId: viewerClaim,
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedTags = await db
    .insert(tags)
    .values({
      id: tagId,
      name: tagName,
      displayName: 'R5F1 Tag',
      category: 'test',
      createdAt: past,
      updatedAt: past,
    })
    .returning({ id: tags.id });
  for (const row of insertedTags) owned.tags.add(row.id);

  const insertedPosts = await db
    .insert(posts)
    .values([
      {
        id: mixedPostId,
        content: 'mixed moderation tag post',
        authorId,
        timestamp: past,
        createdAt: past,
      },
      {
        id: controlPostId,
        content: 'fully visible tag post',
        authorId,
        timestamp: past,
        createdAt: past,
      },
    ])
    .returning({ id: posts.id });
  for (const row of insertedPosts) owned.posts.add(row.id);

  // Mixed post: 6 comment rows, only 2 reachable.
  // visible top + visible reply under it = reachable (2).
  // deleted parent + its visible reply + visible grandchild = unreachable (3).
  // deleted reply under the visible top = excluded control (1).
  const insertedComments = await db
    .insert(comments)
    .values([
      {
        id: visibleTopId,
        content: 'visible top-level comment',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: past,
        updatedAt: past,
        deletedAt: null,
      },
      {
        id: visibleReplyId,
        content: 'visible reply under the visible top',
        postId: mixedPostId,
        authorId: replyAuthorId,
        parentCommentId: visibleTopId,
        createdAt: past,
        updatedAt: past,
        deletedAt: null,
      },
      {
        id: deletedParentId,
        content: 'parent comment hidden by moderation',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: past,
        updatedAt: past,
        deletedAt: past,
      },
      {
        id: hiddenReplyId,
        content: 'visible reply under the hidden parent',
        postId: mixedPostId,
        authorId: replyAuthorId,
        parentCommentId: deletedParentId,
        createdAt: past,
        updatedAt: past,
        deletedAt: null,
      },
      {
        id: hiddenGrandchildId,
        content: 'visible grandchild under the hidden reply',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: hiddenReplyId,
        createdAt: past,
        updatedAt: past,
        deletedAt: null,
      },
      {
        id: deletedReplyId,
        content: 'deleted reply under the visible top',
        postId: mixedPostId,
        authorId: commenterId,
        parentCommentId: visibleTopId,
        createdAt: past,
        updatedAt: past,
        deletedAt: past,
      },
      {
        id: controlCommentId,
        content: 'visible control comment',
        postId: controlPostId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: past,
        updatedAt: past,
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);

  const insertedPostTags = await db
    .insert(postTags)
    .values([
      {
        id: await generateSnowflakeId(),
        postId: mixedPostId,
        tagId,
        createdAt: past,
      },
      {
        id: await generateSnowflakeId(),
        postId: controlPostId,
        tagId,
        createdAt: past,
      },
    ])
    .returning({ id: postTags.id });
  for (const row of insertedPostTags) owned.postTags.add(row.id);

  // Signed-viewer case: the viewer blocks the author of the visible reply,
  // so for them only the visible top-level comment is reachable.
  const insertedBlocks = await db
    .insert(userBlocks)
    .values({
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: replyAuthorId,
      createdAt: past,
    })
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) owned.blocks.add(row.id);
});

afterAll(async () => {
  await cleanup(owned);
});

describe('tag feed card comment count', () => {
  it('counts only reachable comments on the tag card (anonymous)', async () => {
    const counts = await fetchTagCounts();
    // Raw rows: 6. Non-deleted rows: 4. Reachable (detail) rows: 2.
    expect(counts.get(mixedPostId)).toBe(2);
    expect(counts.get(controlPostId)).toBe(1);
  });

  it('matches the post detail count for the same post (anonymous)', async () => {
    const [card, detail] = await Promise.all([
      fetchTagCounts().then((counts) => counts.get(mixedPostId)),
      fetchDetailCount(mixedPostId),
    ]);
    expect(detail).toBe(2);
    expect(card).toBe(detail);
  });

  it('counts only reachable comments for a viewer who blocked a replier', async () => {
    const counts = await fetchTagCounts(signedViewerHeaders());
    // The viewer blocked the reply author: only the visible top remains.
    expect(counts.get(mixedPostId)).toBe(1);
    expect(counts.get(controlPostId)).toBe(1);
    expect(await fetchDetailCount(mixedPostId, signedViewerHeaders())).toBe(1);
  });
});
