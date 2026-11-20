/**
 * GET /api/comments/[id] against a real database: the `post.commentCount`
 * shown at the top of the comment thread page must equal the number the
 * post detail screen shows for the same post and the same viewer.
 *
 * The post detail route counts only the comments its comment list can
 * actually show ("Count only the comments the comment list below can
 * actually show", apps/web/src/app/api/posts/[id]/route.ts): replies
 * whose parent is not visible are unreachable from the root and omitted
 * with their parent, and comments by authors the viewer blocked or
 * muted — or who blocked the viewer — are excluded with their subtrees
 * (same loadViewerExcludedAuthorIds definition). The comment list's own
 * total counts tree nodes the same way. The thread route's own header
 * promises the same for its replies, reply counts and parent chain
 * ("replies and ancestors by authors the viewer must not see are not
 * returned or counted").
 *
 * But the thread route's `post.commentCount` is a raw count of every
 * non-deleted comment row for the post: no moderation filter, no
 * tree-reachability rule. So the thread page header promises comments
 * the post detail screen — and the list below it — never shows. The
 * InteractionBar on /comment/[id] renders that number, so the same
 * viewer sees two different counts for one post.
 *
 * Two mechanisms, one defect:
 *  1. Viewer moderation: a blocked/muted/blocking author's comments
 *     (and the visible replies under them) count on the thread page
 *     but not on post detail.
 *  2. Hidden parent: replies under a soft-deleted (moderated) parent
 *     stay non-deleted rows, so they count on the thread page but are
 *     unreachable — and uncounted — on post detail.
 *
 * The real routes and database are used. Only the server-only
 * environment marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  eq,
  gameOnboarding,
  inArray,
  posts,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

type CommentDetailResponse = {
  comment: { id: string; replyCount: number };
  replies: Array<{ id: string }>;
  parentChain: Array<{ id: string }>;
  post: { id: string; commentCount: number } | null;
};

type PostDetailResponse = {
  success: boolean;
  data: { id: string; commentCount: number };
};

type CommentNode = {
  id: string;
  replies: CommentNode[];
};

type CommentsListResponse = {
  success: boolean;
  data: { comments: CommentNode[]; total: number };
};

type UserInsert = typeof users.$inferInsert;
type PostInsert = typeof posts.$inferInsert;
type CommentInsert = typeof comments.$inferInsert;
type UserBlockInsert = typeof userBlocks.$inferInsert;
type UserMuteInsert = typeof userMutes.$inferInsert;

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway can never
 * delete data this fixture did not create. (Same ownership discipline
 * as comment-detail-viewer-moderation: lock owned User rows first, then
 * refuse while a foreign cascading child references one.)
 */
class OwnedFixtures {
  readonly userIds: string[] = [];
  readonly postIds: string[] = [];
  readonly commentIds: string[] = [];
  readonly blockIds: string[] = [];
  readonly muteIds: string[] = [];

  async insertUser(values: UserInsert): Promise<string> {
    const [row] = await db
      .insert(users)
      .values(values)
      .returning({ id: users.id });
    if (!row) throw new Error('user insert returned no row');
    this.userIds.push(row.id);
    return row.id;
  }

  async insertPost(values: PostInsert): Promise<string> {
    const [row] = await db
      .insert(posts)
      .values(values)
      .returning({ id: posts.id });
    if (!row) throw new Error('post insert returned no row');
    this.postIds.push(row.id);
    return row.id;
  }

  async insertComment(values: CommentInsert): Promise<string> {
    const [row] = await db
      .insert(comments)
      .values(values)
      .returning({ id: comments.id });
    if (!row) throw new Error('comment insert returned no row');
    this.commentIds.push(row.id);
    return row.id;
  }

  async insertBlock(values: UserBlockInsert): Promise<string> {
    const [row] = await db
      .insert(userBlocks)
      .values(values)
      .returning({ id: userBlocks.id });
    if (!row) throw new Error('block insert returned no row');
    this.blockIds.push(row.id);
    return row.id;
  }

  async insertMute(values: UserMuteInsert): Promise<string> {
    const [row] = await db
      .insert(userMutes)
      .values(values)
      .returning({ id: userMutes.id });
    if (!row) throw new Error('mute insert returned no row');
    this.muteIds.push(row.id);
    return row.id;
  }

  async cleanup(): Promise<void> {
    await db.transaction(async (tx) => {
      if (this.userIds.length > 0) {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, this.userIds))
          .for('update');
        const [foreignOnboarding] = await tx
          .select({ id: gameOnboarding.id, userId: gameOnboarding.userId })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, this.userIds))
          .limit(1);
        const [foreignSnapshot] = await tx
          .select({ id: userPnLSnapshots.id, userId: userPnLSnapshots.userId })
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.userId, this.userIds))
          .limit(1);
        const [foreignWhitelist] = await tx
          .select({ id: whitelist.id, userId: whitelist.userId })
          .from(whitelist)
          .where(inArray(whitelist.userId, this.userIds))
          .limit(1);
        const foreign =
          foreignOnboarding !== undefined
            ? { label: 'GameOnboarding', ...foreignOnboarding }
            : foreignSnapshot !== undefined
              ? { label: 'UserPnLSnapshot', ...foreignSnapshot }
              : foreignWhitelist !== undefined
                ? { label: 'Whitelist', ...foreignWhitelist }
                : null;
        if (foreign) {
          throw new Error(
            `OwnedFixtures.cleanup refused: ${foreign.label} ${foreign.id} still references owned user ${foreign.userId}`
          );
        }
      }
      if (this.blockIds.length > 0) {
        await tx
          .delete(userBlocks)
          .where(inArray(userBlocks.id, this.blockIds));
      }
      if (this.muteIds.length > 0) {
        await tx.delete(userMutes).where(inArray(userMutes.id, this.muteIds));
      }
      if (this.commentIds.length > 0) {
        await tx.delete(comments).where(inArray(comments.id, this.commentIds));
      }
      if (this.postIds.length > 0) {
        await tx.delete(posts).where(inArray(posts.id, this.postIds));
      }
      if (this.userIds.length > 0) {
        await tx.delete(users).where(inArray(users.id, this.userIds));
      }
    });
    this.userIds.length = 0;
    this.postIds.length = 0;
    this.commentIds.length = 0;
    this.blockIds.length = 0;
    this.muteIds.length = 0;
  }
}

const fixtures = new OwnedFixtures();

let postAuthor: string;
let viewer: string;
let normal: string;
let blocked: string;
let muted: string;
let blocker: string;
let postId: string;
let mainCommentId: string;
let hiddenPostId: string;
let hiddenChildId: string;
let stewardId: string;
let token: string;

let GET_DETAIL: typeof import('../../../apps/web/src/app/api/comments/[id]/route').GET;
let GET_POST: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
let GET_LIST: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').GET;

function viewerAuthHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function fetchThread(id: string, headers?: Record<string, string>) {
  const request = new NextRequest(`http://localhost/api/comments/${id}`, {
    headers,
  });
  const response = await GET_DETAIL(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchPostCount(
  targetPostId: string,
  headers?: Record<string, string>
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}`, { headers })
  );
  const response = await GET_POST(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchListTotal(
  targetPostId: string,
  headers?: Record<string, string>
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}/comments`, {
      headers,
    })
  );
  const response = await GET_LIST(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentsListResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET: GET_DETAIL } = await import(
    '../../../apps/web/src/app/api/comments/[id]/route'
  ));
  ({ GET: GET_POST } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));
  ({ GET: GET_LIST } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  ));

  const now = new Date();
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const earlier = new Date(now.getTime() - 3_600_000);

  async function insertFixtureUser(
    prefix: string,
    displayName: string
  ): Promise<string> {
    const id = await generateSnowflakeId();
    return fixtures.insertUser({
      id,
      username: `test-w5a-${prefix}-${id}`,
      displayName,
      updatedAt: now,
    });
  }

  postAuthor = await insertFixtureUser('p', 'W5A Post Author');
  viewer = await insertFixtureUser('v', 'W5A Viewer');
  // The Steward subject is unique per run: the fixed identity could
  // collide with a concurrent run of this file.
  stewardId = `w5a-comment-detail-${viewer}`;
  await db.update(users).set({ stewardId }).where(eq(users.id, viewer));
  normal = await insertFixtureUser('n', 'W5A Normal');
  blocked = await insertFixtureUser('b', 'W5A Blocked');
  muted = await insertFixtureUser('m', 'W5A Muted');
  blocker = await insertFixtureUser('r', 'W5A Blocker');

  postId = await fixtures.insertPost({
    id: await generateSnowflakeId(),
    content: 'w5a fixture post',
    authorId: postAuthor,
    timestamp: earlier,
    createdAt: earlier,
  });

  async function insertFixtureComment(
    targetPostId: string,
    authorId: string,
    parentCommentId: string | null,
    content: string,
    seconds: number,
    deletedAt: Date | null = null
  ): Promise<string> {
    const id = await generateSnowflakeId();
    return fixtures.insertComment({
      id,
      content,
      postId: targetPostId,
      authorId,
      parentCommentId,
      createdAt: at(seconds),
      updatedAt: at(seconds),
      deletedAt,
    });
  }

  // Thread under the post (same shape as the viewer-moderation fixture):
  //   main (normal)
  //   ├─ replyNormal (normal)
  //   │    └─ blocked reply under normal root (blocked author)
  //   ├─ replyBlocked (blocked author)
  //   │    ├─ visible reply under blocked root (normal)
  //   │    └─ child of blocked reply (normal)
  //   ├─ replyMuted (muted author)
  //   └─ replyBlocker (author who blocked the viewer)
  // 8 rows in total. The viewer can see 2: main + replyNormal.
  mainCommentId = await insertFixtureComment(
    postId,
    normal,
    null,
    'w5a main comment',
    0
  );
  await insertFixtureComment(
    postId,
    normal,
    mainCommentId,
    'w5a reply by normal author',
    10
  );
  const replyBlockedId = await insertFixtureComment(
    postId,
    blocked,
    mainCommentId,
    'w5a reply by blocked author',
    20
  );
  await insertFixtureComment(
    postId,
    muted,
    mainCommentId,
    'w5a reply by muted author',
    30
  );
  await insertFixtureComment(
    postId,
    blocker,
    mainCommentId,
    'w5a reply by blocking author',
    40
  );
  await insertFixtureComment(
    postId,
    normal,
    replyBlockedId,
    'w5a visible reply under blocked root',
    50
  );
  await insertFixtureComment(
    postId,
    blocked,
    mainCommentId,
    'w5a blocked reply under normal root',
    60
  );
  await insertFixtureComment(
    postId,
    normal,
    replyBlockedId,
    'w5a child of blocked reply',
    70
  );

  await fixtures.insertBlock({
    id: await generateSnowflakeId(),
    blockerId: viewer,
    blockedId: blocked,
  });
  await fixtures.insertBlock({
    id: await generateSnowflakeId(),
    blockerId: blocker,
    blockedId: viewer,
  });
  await fixtures.insertMute({
    id: await generateSnowflakeId(),
    muterId: viewer,
    mutedId: muted,
  });

  // Second post: a soft-deleted (moderated) parent whose replies stay
  // non-deleted rows. The list's tree rule omits the whole subtree, so
  // post detail counts 0 — but the raw thread count sees 2 rows.
  hiddenPostId = await fixtures.insertPost({
    id: await generateSnowflakeId(),
    content: 'w5a hidden-parent fixture post',
    authorId: postAuthor,
    timestamp: earlier,
    createdAt: earlier,
  });
  const hiddenParentId = await insertFixtureComment(
    hiddenPostId,
    normal,
    null,
    'w5a hidden parent',
    0,
    now
  );
  hiddenChildId = await insertFixtureComment(
    hiddenPostId,
    normal,
    hiddenParentId,
    'w5a reply under hidden parent',
    10
  );
  await insertFixtureComment(
    hiddenPostId,
    normal,
    hiddenChildId,
    'w5a grandchild under hidden parent',
    20
  );

  // The token is signed with the configured shared secret through the
  // shared helper. This file must not replace
  // process.env.STEWARD_JWT_SECRET: the test server and later suites in
  // the same process sign and verify with the configured value.
  token = await createStewardTestToken(stewardId);
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe('GET /api/comments/[id] post.commentCount matches post detail', () => {
  it('anonymous reads agree on the moderated thread (control)', async () => {
    const thread = await fetchThread(mainCommentId);
    expect(thread.status).toBe(200);
    const detail = thread.body as CommentDetailResponse;
    expect(detail.post?.commentCount).toBe(8);

    const post = await fetchPostCount(postId);
    expect(post.status).toBe(200);
    expect((post.body as PostDetailResponse).data.commentCount).toBe(8);

    const list = await fetchListTotal(postId);
    expect(list.status).toBe(200);
    expect((list.body as CommentsListResponse).data.total).toBe(8);
  });

  it('viewer reads agree on the moderated thread', async () => {
    const post = await fetchPostCount(postId, viewerAuthHeaders());
    expect(post.status).toBe(200);
    expect((post.body as PostDetailResponse).data.commentCount).toBe(2);

    const list = await fetchListTotal(postId, viewerAuthHeaders());
    expect(list.status).toBe(200);
    expect((list.body as CommentsListResponse).data.total).toBe(2);

    // The thread page header must show the same 2 the post detail
    // screen shows — not the raw 8 rows.
    const thread = await fetchThread(mainCommentId, viewerAuthHeaders());
    expect(thread.status).toBe(200);
    const detail = thread.body as CommentDetailResponse;
    expect(detail.post?.commentCount).toBe(2);
  });

  it('anonymous reads agree when the parent is hidden by moderation', async () => {
    const post = await fetchPostCount(hiddenPostId);
    expect(post.status).toBe(200);
    expect((post.body as PostDetailResponse).data.commentCount).toBe(0);

    const list = await fetchListTotal(hiddenPostId);
    expect(list.status).toBe(200);
    expect((list.body as CommentsListResponse).data.total).toBe(0);

    // The thread page header must show 0 — not the raw 2 rows under
    // the hidden parent.
    const thread = await fetchThread(hiddenChildId);
    expect(thread.status).toBe(200);
    const detail = thread.body as CommentDetailResponse;
    expect(detail.post?.commentCount).toBe(0);
  });
});
