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

type UserInsert = typeof users.$inferInsert;
type PostInsert = typeof posts.$inferInsert;
type CommentInsert = typeof comments.$inferInsert;
type UserBlockInsert = typeof userBlocks.$inferInsert;
type UserMuteInsert = typeof userMutes.$inferInsert;

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway (for example on
 * an ID collision with a pre-existing row) can never delete data this
 * fixture did not create.
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
    if (this.blockIds.length > 0) {
      await db.delete(userBlocks).where(inArray(userBlocks.id, this.blockIds));
    }
    if (this.muteIds.length > 0) {
      await db.delete(userMutes).where(inArray(userMutes.id, this.muteIds));
    }
    if (this.commentIds.length > 0) {
      await db.delete(comments).where(inArray(comments.id, this.commentIds));
    }
    if (this.postIds.length > 0) {
      await db.delete(posts).where(inArray(posts.id, this.postIds));
    }
    if (this.userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, this.userIds));
    }
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
let replyNormalId: string;
let replyBlockedId: string;
let replyMutedId: string;
let replyBlockerId: string;
let childCommentId: string;
let stewardId: string;
let token: string;

let GET: typeof import('../../../apps/web/src/app/api/comments/[id]/route').GET;

function viewerAuthHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

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
      username: `test-f75-${prefix}-${id}`,
      displayName,
      updatedAt: now,
    });
  }

  postAuthor = await insertFixtureUser('p', 'F75 Post Author');
  viewer = await insertFixtureUser('v', 'F75 Viewer');
  // The Steward subject is unique per run: the fixed 'f75-steward-viewer'
  // identity could collide with a concurrent run of this file.
  stewardId = `f75-comment-detail-${viewer}`;
  await db.update(users).set({ stewardId }).where(eq(users.id, viewer));
  normal = await insertFixtureUser('n', 'F75 Normal');
  blocked = await insertFixtureUser('b', 'F75 Blocked');
  muted = await insertFixtureUser('m', 'F75 Muted');
  blocker = await insertFixtureUser('r', 'F75 Blocker');

  postId = await fixtures.insertPost({
    id: await generateSnowflakeId(),
    content: 'f75 fixture post',
    authorId: postAuthor,
    timestamp: earlier,
    createdAt: earlier,
  });

  async function insertFixtureComment(
    authorId: string,
    parentCommentId: string | null,
    content: string,
    seconds: number
  ): Promise<string> {
    const id = await generateSnowflakeId();
    return fixtures.insertComment({
      id,
      content,
      postId,
      authorId,
      parentCommentId,
      createdAt: at(seconds),
      updatedAt: at(seconds),
      deletedAt: null,
    });
  }

  // Thread under the post:
  //   main (normal)
  //   ├─ replyNormal (normal)
  //   │    └─ childOfNormal (blocked author)
  //   ├─ replyBlocked (blocked author)
  //   │    └─ childOfBlocked (normal)
  //   ├─ replyMuted (muted author)
  //   └─ replyBlocker (author who blocked the viewer)
  //   childComment (normal) hangs under replyBlocked, for the parent chain.
  mainCommentId = await insertFixtureComment(
    normal,
    null,
    'f75 main comment',
    0
  );
  replyNormalId = await insertFixtureComment(
    normal,
    mainCommentId,
    'f75 reply by normal author',
    10
  );
  replyBlockedId = await insertFixtureComment(
    blocked,
    mainCommentId,
    'f75 reply by blocked author',
    20
  );
  replyMutedId = await insertFixtureComment(
    muted,
    mainCommentId,
    'f75 reply by muted author',
    30
  );
  replyBlockerId = await insertFixtureComment(
    blocker,
    mainCommentId,
    'f75 reply by blocking author',
    40
  );
  // These two nested replies shape the reply counts but their ids are
  // never asserted directly; the fixture tracker still owns their rows.
  await insertFixtureComment(
    normal,
    replyBlockedId,
    'f75 visible reply under blocked root',
    50
  );
  await insertFixtureComment(
    blocked,
    replyNormalId,
    'f75 blocked reply under normal root',
    60
  );
  childCommentId = await insertFixtureComment(
    normal,
    replyBlockedId,
    'f75 child of blocked reply',
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

  // The token is signed with the configured shared secret through the
  // shared helper. This file must not replace
  // process.env.STEWARD_JWT_SECRET: the test server and later suites in
  // the same process sign and verify with the configured value.
  token = await createStewardTestToken(stewardId);
});

afterAll(async () => {
  await fixtures.cleanup();
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
      viewerAuthHeaders()
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
      viewerAuthHeaders()
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

describe('fixture ownership', () => {
  it('cleanup after failed setup never deletes rows the fixture did not create', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const victimUserId = await generateSnowflakeId();
      await victim.insertUser({
        id: victimUserId,
        username: `test-f75-victim-${victimUserId}`,
        displayName: 'Pre-existing user',
        updatedAt: new Date(),
      });
      const victimCommentId = await generateSnowflakeId();
      await victim.insertComment({
        id: victimCommentId,
        content: 'f75 pre-existing comment',
        postId,
        authorId: victimUserId,
        parentCommentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      const victimBlockId = await generateSnowflakeId();
      await victim.insertBlock({
        id: victimBlockId,
        blockerId: victimUserId,
        blockedId: normal,
      });

      // A user INSERT that collides with the pre-existing user fails and
      // registers no ownership.
      let userCollisionFailed = false;
      try {
        await attempt.insertUser({
          id: victimUserId,
          username: `test-f75-collision-${victimUserId}`,
          displayName: 'Collision attempt',
          updatedAt: new Date(),
        });
      } catch {
        userCollisionFailed = true;
      }
      expect(userCollisionFailed).toBe(true);
      expect(attempt.userIds).toEqual([]);

      // Partial setup: the user insert succeeds, then the comment INSERT
      // collides with the pre-existing comment and registers nothing, and
      // a block INSERT colliding with the pre-existing block does the same.
      const attemptUserId = await generateSnowflakeId();
      await attempt.insertUser({
        id: attemptUserId,
        username: `test-f75-attempt-${attemptUserId}`,
        displayName: 'Partial setup',
        updatedAt: new Date(),
      });
      let commentCollisionFailed = false;
      try {
        await attempt.insertComment({
          id: victimCommentId,
          content: 'f75 colliding comment',
          postId,
          authorId: attemptUserId,
          parentCommentId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        });
      } catch {
        commentCollisionFailed = true;
      }
      expect(commentCollisionFailed).toBe(true);
      expect(attempt.commentIds).toEqual([]);
      let blockCollisionFailed = false;
      try {
        await attempt.insertBlock({
          id: victimBlockId,
          blockerId: attemptUserId,
          blockedId: normal,
        });
      } catch {
        blockCollisionFailed = true;
      }
      expect(blockCollisionFailed).toBe(true);
      expect(attempt.blockIds).toEqual([]);

      await attempt.cleanup();

      // The pre-existing rows survive the failed setup's cleanup untouched.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, victimUserId));
      expect(survivingUser).toBeDefined();
      expect(survivingUser?.displayName).toBe('Pre-existing user');
      const [survivingComment] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, victimCommentId));
      expect(survivingComment).toBeDefined();
      expect(survivingComment?.authorId).toBe(victimUserId);
      const [survivingBlock] = await db
        .select()
        .from(userBlocks)
        .where(eq(userBlocks.id, victimBlockId));
      expect(survivingBlock).toBeDefined();
      expect(survivingBlock?.blockerId).toBe(victimUserId);
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});
