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
  gameOnboarding,
  inArray,
  posts,
  sql,
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
 * fixture did not create. Cleanup runs in one short transaction: it locks
 * the owned User rows first, then refuses while a row in a table that
 * cascades on users.id (GameOnboarding, UserPnLSnapshot, Whitelist)
 * still references an owned user, so a foreign child acquired after setup
 * — including one inserted while cleanup is in flight — is never deleted
 * with its parent. A refusal rolls the whole cleanup back.
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
        // Lock the owned User rows before checking their children. A
        // concurrent insert of a cascading child takes FOR KEY SHARE on
        // the referenced user row, so it blocks until this transaction
        // ends: no foreign child can appear between the lock and the
        // checks below.
        await tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, this.userIds))
          .for('update');
        // GameOnboarding, UserPnLSnapshot and Whitelist all reference
        // users.id ON DELETE CASCADE. A row in one of those tables that
        // this fixture did not create may still reference an owned user,
        // and deleting the user would silently delete that foreign row
        // too. Refuse before deleting anything, so the foreign row and
        // every owned row survive unchanged; throwing here rolls the
        // whole cleanup back.
        const [foreignOnboarding] = await tx
          .select({
            id: gameOnboarding.id,
            userId: gameOnboarding.userId,
          })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, this.userIds))
          .limit(1);
        const [foreignSnapshot] = await tx
          .select({
            id: userPnLSnapshots.id,
            userId: userPnLSnapshots.userId,
          })
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

  it('cleanup refuses when a foreign cascading child references an owned user', async () => {
    const foreignOnboardingId = await generateSnowflakeId();
    const now = new Date();
    try {
      // A GameOnboarding row created outside the fixture ledger, referencing
      // the owned fixture user `normal`. Its userId references users.id
      // ON DELETE CASCADE, so deleting the user would silently delete this
      // row too — the collision test above cannot see this case, because
      // the row was inserted successfully after the fixture was set up.
      await db.insert(gameOnboarding).values({
        id: foreignOnboardingId,
        userId: normal,
        currentStep: 'welcome',
        state: {
          completedSteps: [],
          currentStep: 'welcome',
          startedAt: now.toISOString(),
          completedAt: null,
          rewards: [],
        },
        isComplete: false,
        createdAt: now,
        updatedAt: now,
      });

      // Cleanup must refuse instead of deleting the user (and the row
      // with it).
      let refusal: unknown;
      try {
        await fixtures.cleanup();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(
        `GameOnboarding ${foreignOnboardingId} still references owned user ${normal}`
      );

      // The foreign row and the owned user row are both unchanged.
      const [survivingOnboarding] = await db
        .select()
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
      expect(survivingOnboarding).toBeDefined();
      expect(survivingOnboarding?.userId).toBe(normal);
      expect(survivingOnboarding?.currentStep).toBe('welcome');
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, normal));
      expect(survivingUser).toBeDefined();
      expect(survivingUser?.displayName).toBe('F75 Normal');
    } finally {
      // Remove the foreign row so the shared fixture's afterAll cleanup
      // can proceed.
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
    }
  });

  it('cleanup refuses a foreign cascading child inserted while cleanup is in flight', async () => {
    const foreignOnboardingId = await generateSnowflakeId();
    const now = new Date();
    try {
      // A second transaction inserts the foreign GameOnboarding row and
      // holds it uncommitted: the pre-delete checks cannot see it yet, so
      // this exercises the check/delete interval instead of inserting the
      // child before the checks (the case above). Cleanup must still
      // refuse once the row commits.
      const inserted = Promise.withResolvers<void>();
      const releaseInsert = Promise.withResolvers<void>();
      const inserter = db.transaction(async (tx) => {
        await tx.insert(gameOnboarding).values({
          id: foreignOnboardingId,
          userId: normal,
          currentStep: 'welcome',
          state: {
            completedSteps: [],
            currentStep: 'welcome',
            startedAt: now.toISOString(),
            completedAt: null,
            rewards: [],
          },
          isComplete: false,
          createdAt: now,
          updatedAt: now,
        });
        inserted.resolve();
        await releaseInsert.promise;
      });
      await inserted.promise;
      const pendingCleanup = fixtures.cleanup();
      try {
        // Wait until cleanup is blocked on an owned User row, proving it
        // reached the user lock/delete while the child was still
        // uncommitted.
        const until = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < until) {
          const rows = await db.execute(
            sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%User%'`
          );
          blocked = Number(rows[0]?.count ?? 0) > 0;
          if (blocked) break;
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
      } finally {
        releaseInsert.resolve();
        await inserter;
      }
      let refusal: unknown;
      try {
        await pendingCleanup;
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain(
        `GameOnboarding ${foreignOnboardingId} still references owned user ${normal}`
      );

      // The foreign row and the owned user row are both unchanged.
      const [survivingOnboarding] = await db
        .select()
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
      expect(survivingOnboarding).toBeDefined();
      expect(survivingOnboarding?.userId).toBe(normal);
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, normal));
      expect(survivingUser).toBeDefined();
      expect(survivingUser?.displayName).toBe('F75 Normal');
    } finally {
      // Remove the foreign row so the shared fixture's afterAll cleanup
      // can proceed.
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, foreignOnboardingId));
    }
  });
});
