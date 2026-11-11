/**
 * PRD §§6.1/12 and MVP Phase 5 preserve public posts and moderation.
 * A2A `social.get_post` against a real database: the `commentCount` it
 * returns for a post must be the number of comments a reader can
 * actually reach on that post — the rule the web post detail route
 * already follows (see post-detail-comment-count.integration.test.ts:
 * the detail `commentCount` equals the number of comments the comment
 * list delivers).
 *
 * The web list omits a reply whose parent is not visible: a parent
 * soft-deleted by moderation (the admin content-queue "hide" action
 * sets comments.deletedAt on that one row; it does not cascade) or by
 * its author takes its whole subtree out of the tree. The live replies
 * under it stay non-deleted, but they are unreachable from the root.
 *
 * The A2A executor counted every non-deleted row, so for a post whose
 * top-level comment was hidden after two replies were posted, an agent
 * reading the post over A2A was told commentCount 4 while the post
 * actually shows 2 comments — and the count never converged with the
 * website's for the same post.
 *
 * Scope: this is the row-state axis (soft-deleted / hidden /
 * unreachable rows) on the A2A surface. The viewer-moderation axis for
 * MCP get_post is a different surface and case (#1878); A2A get_post
 * takes no viewer, so its canonical comparison is the anonymous web
 * read, which applies the same reachability rule.
 *
 * The real executor and database are used. Only the server-only
 * environment marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

type GetPostResult = {
  post: { id: string; commentCount: number; likeCount: number };
};

type PostDetailResponse = {
  success: boolean;
  data: { id: string; commentCount: number };
};

const ownedUsers = new Set<string>();
const ownedPosts = new Set<string>();
const ownedComments = new Set<string>();

let authorId: string;
let commenterId: string;
let hiddenPostId: string;
let midChainPostId: string;
let cleanPostId: string;

let getPostRoute: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

async function a2aCommentCount(postId: string) {
  const result = (await FeedAgentExecutor.executeDirectly(
    'social.get_post',
    { postId },
    authorId
  )) as unknown as GetPostResult;
  return result.post.commentCount;
}

async function webCommentCount(postId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}`)
  );
  const response = await getPostRoute(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json()) as PostDetailResponse;
  return body.data.commentCount;
}

async function insertPost(id: string, content: string) {
  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  const inserted = await db
    .insert(posts)
    .values({
      id,
      content,
      authorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of inserted) ownedPosts.add(row.id);
}

async function insertComment(values: {
  id: string;
  content: string;
  postId: string;
  authorId: string;
  parentCommentId: string | null;
  deletedAt: Date | null;
}) {
  const now = new Date();
  const inserted = await db
    .insert(comments)
    .values({ ...values, createdAt: now, updatedAt: now })
    .returning({ id: comments.id });
  for (const row of inserted) ownedComments.add(row.id);
}

beforeAll(async () => {
  ({ GET: getPostRoute } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  [authorId, commenterId, hiddenPostId, midChainPostId, cleanPostId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

  const now = new Date();
  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `f195a-${authorId}`,
        displayName: 'A2A GetPost Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `f195c-${commenterId}`,
        displayName: 'A2A GetPost Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) ownedUsers.add(row.id);

  await insertPost(hiddenPostId, 'f195 post with a hidden parent comment');
  await insertPost(midChainPostId, 'f195 post with a deleted middle reply');
  await insertPost(cleanPostId, 'f195 clean post (control)');

  const ids = await Promise.all(
    Array.from({ length: 10 }, () => generateSnowflakeId())
  );
  const [
    visibleTopId,
    visibleReplyId,
    hiddenParentId,
    childUnderHiddenId,
    grandchildUnderHiddenId,
    midTopId,
    midDeletedId,
    midLeafId,
    cleanTopId,
    cleanDeletedReplyId,
  ] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  // Hidden-parent post: a visible pair, plus a top-level comment whose
  // row carries deletedAt (the moderation-hide / author-delete state)
  // with two live replies underneath it.
  await insertComment({
    id: visibleTopId,
    content: 'visible top-level',
    postId: hiddenPostId,
    authorId: commenterId,
    parentCommentId: null,
    deletedAt: null,
  });
  await insertComment({
    id: visibleReplyId,
    content: 'visible reply',
    postId: hiddenPostId,
    authorId: authorId,
    parentCommentId: visibleTopId,
    deletedAt: null,
  });
  await insertComment({
    id: hiddenParentId,
    content: 'parent with deletedAt set',
    postId: hiddenPostId,
    authorId: commenterId,
    parentCommentId: null,
    deletedAt: now,
  });
  await insertComment({
    id: childUnderHiddenId,
    content: 'live child under the deletedAt parent',
    postId: hiddenPostId,
    authorId: authorId,
    parentCommentId: hiddenParentId,
    deletedAt: null,
  });
  await insertComment({
    id: grandchildUnderHiddenId,
    content: 'live grandchild under the deletedAt parent',
    postId: hiddenPostId,
    authorId: commenterId,
    parentCommentId: childUnderHiddenId,
    deletedAt: null,
  });

  // Mid-chain post: visible top-level, a soft-deleted reply under it,
  // and a live reply under the deleted one. Only the top-level comment
  // is reachable.
  await insertComment({
    id: midTopId,
    content: 'mid-chain top-level',
    postId: midChainPostId,
    authorId: commenterId,
    parentCommentId: null,
    deletedAt: null,
  });
  await insertComment({
    id: midDeletedId,
    content: 'mid-chain soft-deleted reply',
    postId: midChainPostId,
    authorId: authorId,
    parentCommentId: midTopId,
    deletedAt: now,
  });
  await insertComment({
    id: midLeafId,
    content: 'live reply under the soft-deleted reply',
    postId: midChainPostId,
    authorId: commenterId,
    parentCommentId: midDeletedId,
    deletedAt: null,
  });

  // Clean post (control): one visible comment and one soft-deleted
  // reply. Every surface already agrees here.
  await insertComment({
    id: cleanTopId,
    content: 'clean visible comment',
    postId: cleanPostId,
    authorId: commenterId,
    parentCommentId: null,
    deletedAt: null,
  });
  await insertComment({
    id: cleanDeletedReplyId,
    content: 'clean soft-deleted reply (control)',
    postId: cleanPostId,
    authorId: authorId,
    parentCommentId: cleanTopId,
    deletedAt: now,
  });
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, [...ownedComments]));
  await db.delete(posts).where(inArray(posts.id, [...ownedPosts]));
  await db.delete(users).where(inArray(users.id, [...ownedUsers]));
});

describe('A2A social.get_post commentCount', () => {
  it('does not count live replies under a parent whose row is deleted', async () => {
    const web = await webCommentCount(hiddenPostId);
    expect(web).toBe(2);
    const a2a = await a2aCommentCount(hiddenPostId);
    expect(a2a).toBe(2);
    expect(a2a).toBe(web);
  });

  it('does not count a live reply under a soft-deleted middle reply', async () => {
    const web = await webCommentCount(midChainPostId);
    expect(web).toBe(1);
    const a2a = await a2aCommentCount(midChainPostId);
    expect(a2a).toBe(1);
    expect(a2a).toBe(web);
  });

  it('still counts every reachable comment on a clean post', async () => {
    const web = await webCommentCount(cleanPostId);
    expect(web).toBe(1);
    const a2a = await a2aCommentCount(cleanPostId);
    expect(a2a).toBe(1);
    expect(a2a).toBe(web);
  });
});
