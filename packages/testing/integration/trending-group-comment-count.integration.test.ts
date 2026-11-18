/**
 * GET /api/trending/group against a real database: moderated comments must
 * not inflate the comment count this route reports for each grouped post.
 *
 * The grouped route is reached from the same Trending panel click as the
 * single-tag page and the trending widget when a topic carries more than
 * one tag. It already filters soft-deleted posts in SQL and already counts
 * visible comments in the widget (`feed/widgets/trending-posts`, PRD §12 /
 * MVP phase 5: "moderated comments must not inflate the existing
 * trending-post count or ranking"). The grouped route's own comment-count
 * query filtered only `inArray(comments.postId, postIds)`, so every
 * soft-deleted comment was still counted and returned in `commentCount`.
 *
 * Reads without and with a signed Steward session use the real route and
 * database; no module is mocked. The signed variant mints a genuine HS256
 * Steward JWT with `createStewardTestToken` under the same key the server
 * verifies, and the fixture links the viewer through `users.stewardId`, so
 * `optionalAuth` — the exact helper `publicRateLimit` calls inside the
 * route — resolves the request to the fixture user and the route takes its
 * authenticated `asUser` branch. The public variant exercises `asPublic`.
 *
 * Fixture rows become ownership only through successful `INSERT ...
 * RETURNING` receipts; proposed IDs are never deleted. Cleanup runs
 * child-first inside one transaction under parent locks, re-checks identity
 * guards, and refuses (throws, rolling back) rather than deleting rows it
 * does not own. A final bounded control proves an INSERT that fails on a
 * pre-existing primary key publishes no receipt and leaves that row
 * untouched by cleanup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { optionalAuth } from '@feed/api';
import {
  and,
  comments,
  db,
  eq,
  inArray,
  posts,
  postTags,
  tags,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';

type GroupResponse = {
  success: boolean;
  posts: Array<{ id: string; commentCount: number }>;
  tags: Array<{ id: string; name: string }>;
};
let authorId: string;
let commenterId: string;
let tagAId: string;
let tagBId: string;
let mixedPostId: string;
let visiblePostId: string;
let deletedOnlyPostId: string;
let mixedVisibleCommentId: string;
let clientIp: string;
let stewardClaim: string;
let stewardToken: string;
// Ownership receipts: published only from successful INSERT ... RETURNING.
const ownedUserIds: string[] = [];
const ownedTagIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];
const ownedPostTagIds: string[] = [];
let GET: typeof import('../../../apps/web/src/app/api/trending/group/route').GET;

function buildGroupRequest(signed: boolean): NextRequest {
  return new NextRequest(
    new Request(
      `http://localhost/api/trending/group?tags=f5-alpha-${authorId},f5-beta-${authorId}&limit=10`,
      {
        headers: {
          'x-forwarded-for': clientIp,
          ...(signed ? { authorization: `Bearer ${stewardToken}` } : {}),
        },
      }
    )
  );
}

async function fetchGroup(signed = false) {
  const request = buildGroupRequest(signed);
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | GroupResponse
    | { error?: unknown }
    | null;
  return {
    status: response.status,
    body,
    // The route echoes its rate-limit bucket: 180/min is the authenticated
    // config, reachable only when publicRateLimit resolved a user.
    limitHeader: response.headers.get('X-RateLimit-Limit'),
  };
}

function commentCountOf(
  body: GroupResponse | { error?: unknown } | null,
  postId: string
) {
  const group = body as GroupResponse;
  return group.posts.find((post) => post.id === postId)?.commentCount;
}

/**
 * Child-first cleanup of every receipted fixture row, in one transaction:
 * parents are locked first so a concurrent writer cannot attach new children
 * mid-cleanup, each delete re-checks the fixture's identity (author, name
 * and username markers), and a row count that does not match the receipts
 * throws instead of deleting what it does not own.
 */
async function deleteOwnedRows(): Promise<void> {
  if (ownedPostIds.length === 0 && ownedUserIds.length === 0) return;
  await db.transaction(async (tx) => {
    if (ownedPostIds.length > 0) {
      await tx
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, ownedPostIds))
        .for('update');
    }
    if (ownedUserIds.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, ownedUserIds))
        .for('update');
    }

    if (ownedPostTagIds.length > 0) {
      const removed = await tx
        .delete(postTags)
        .where(inArray(postTags.id, ownedPostTagIds))
        .returning({ id: postTags.id });
      if (removed.length !== ownedPostTagIds.length) {
        throw new Error(
          `Trending fixture cleanup refused postTags: expected ${ownedPostTagIds.length}, removed ${removed.length}`
        );
      }
    }

    if (ownedCommentIds.length > 0) {
      const removed = await tx
        .delete(comments)
        .where(inArray(comments.id, ownedCommentIds))
        .returning({ id: comments.id });
      if (removed.length !== ownedCommentIds.length) {
        throw new Error(
          `Trending fixture cleanup refused comments: expected ${ownedCommentIds.length}, removed ${removed.length}`
        );
      }
    }

    if (ownedPostIds.length > 0) {
      const foreignChildren = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(inArray(comments.postId, ownedPostIds))
        .limit(1);
      if (foreignChildren.length > 0) {
        throw new Error(
          'Trending fixture cleanup refused posts: a comment this fixture does not own still references them'
        );
      }
      const removed = await tx
        .delete(posts)
        .where(
          and(inArray(posts.id, ownedPostIds), eq(posts.authorId, authorId))
        )
        .returning({ id: posts.id });
      if (removed.length !== ownedPostIds.length) {
        throw new Error(
          `Trending fixture cleanup refused posts: expected ${ownedPostIds.length}, removed ${removed.length}`
        );
      }
    }

    if (ownedTagIds.length > 0) {
      const removed = await tx
        .delete(tags)
        .where(
          and(
            inArray(tags.id, ownedTagIds),
            inArray(tags.name, [`f5-alpha-${authorId}`, `f5-beta-${authorId}`])
          )
        )
        .returning({ id: tags.id });
      if (removed.length !== ownedTagIds.length) {
        throw new Error(
          `Trending fixture cleanup refused tags: expected ${ownedTagIds.length}, removed ${removed.length}`
        );
      }
    }

    if (ownedUserIds.length > 0) {
      const authoredPosts = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.authorId, ownedUserIds))
        .limit(1);
      if (authoredPosts.length > 0) {
        throw new Error(
          'Trending fixture cleanup refused users: they still author posts this fixture does not own'
        );
      }
      const authoredComments = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(inArray(comments.authorId, ownedUserIds))
        .limit(1);
      if (authoredComments.length > 0) {
        throw new Error(
          'Trending fixture cleanup refused users: they still author comments this fixture does not own'
        );
      }
      const removed = await tx
        .delete(users)
        .where(
          and(
            inArray(users.id, ownedUserIds),
            inArray(users.username, [
              `test-f5-${authorId}`,
              `test-f5-c-${commenterId}`,
            ])
          )
        )
        .returning({ id: users.id });
      if (removed.length !== ownedUserIds.length) {
        throw new Error(
          `Trending fixture cleanup refused users: expected ${ownedUserIds.length}, removed ${removed.length}`
        );
      }
    }

    ownedPostTagIds.length = 0;
    ownedCommentIds.length = 0;
    ownedPostIds.length = 0;
    ownedTagIds.length = 0;
    ownedUserIds.length = 0;
  });
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/trending/group/route'
  ));
  [
    authorId,
    commenterId,
    tagAId,
    tagBId,
    mixedPostId,
    visiblePostId,
    deletedOnlyPostId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  // Isolate this fixture from other public reads while exercising the real
  // limiter. The public variant never falls into CI's shared anonymous
  // bucket; the signed variant is keyed by the resolved user instead.
  clientIp = `2001:db8:1656:1:${BigInt(authorId)
    .toString(16)
    .padStart(16, '0')
    .match(/.{4}/g)!
    .join(':')}`;
  // The signed variant authenticates through users.stewardId (the fast path
  // of resolveUserFromStewardPayload); without the link the token would
  // auto-provision a brand-new user instead of this fixture.
  stewardClaim = `steward-f5-${commenterId}`;
  stewardToken = await createStewardTestToken(stewardClaim);
  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `test-f5-${authorId}`,
        displayName: 'Trending Comment Count Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `test-f5-c-${commenterId}`,
        displayName: 'Trending Comment Count Commenter',
        stewardId: stewardClaim,
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  if (insertedUsers.length !== 2) {
    throw new Error(
      `Trending fixture setup refused: expected 2 users, inserted ${insertedUsers.length}`
    );
  }
  ownedUserIds.push(...insertedUsers.map((row) => row.id));

  const insertedTags = await db
    .insert(tags)
    .values([
      {
        id: tagAId,
        name: `f5-alpha-${authorId}`,
        displayName: 'F5 Alpha',
        category: 'test',
        createdAt: past,
        updatedAt: past,
      },
      {
        id: tagBId,
        name: `f5-beta-${authorId}`,
        displayName: 'F5 Beta',
        category: 'test',
        createdAt: past,
        updatedAt: past,
      },
    ])
    .returning({ id: tags.id });
  if (insertedTags.length !== 2) {
    throw new Error(
      `Trending fixture setup refused: expected 2 tags, inserted ${insertedTags.length}`
    );
  }
  ownedTagIds.push(...insertedTags.map((row) => row.id));

  // One post with visible and moderated comments, one post whose comments
  // are all visible, and one post whose comments are all soft-deleted.
  const insertedPosts = await db
    .insert(posts)
    .values([
      {
        id: mixedPostId,
        content: 'mixed moderation trending post',
        authorId,
        timestamp: past,
        createdAt: past,
      },
      {
        id: visiblePostId,
        content: 'fully visible trending post',
        authorId,
        timestamp: past,
        createdAt: past,
      },
      {
        id: deletedOnlyPostId,
        content: 'moderated-only trending post',
        authorId,
        timestamp: past,
        createdAt: past,
      },
    ])
    .returning({ id: posts.id });
  if (insertedPosts.length !== 3) {
    throw new Error(
      `Trending fixture setup refused: expected 3 posts, inserted ${insertedPosts.length}`
    );
  }
  ownedPostIds.push(...insertedPosts.map((row) => row.id));

  const commentSpecs = [
    { postId: mixedPostId, visible: 2, deleted: 2 },
    { postId: visiblePostId, visible: 3, deleted: 0 },
    { postId: deletedOnlyPostId, visible: 0, deleted: 2 },
  ];
  for (const spec of commentSpecs) {
    for (let i = 0; i < spec.visible + spec.deleted; i++) {
      const [inserted] = await db
        .insert(comments)
        .values({
          id: await generateSnowflakeId(),
          content: 'Trending comment count fixture',
          postId: spec.postId,
          authorId: commenterId,
          createdAt: past,
          updatedAt: past,
          deletedAt: i < spec.visible ? null : past,
        })
        .returning({ id: comments.id });
      if (!inserted) {
        throw new Error(
          `Trending fixture setup refused: comment insert on ${spec.postId} returned no row`
        );
      }
      ownedCommentIds.push(inserted.id);
      if (spec.postId === mixedPostId && i === 0) {
        mixedVisibleCommentId = inserted.id;
      }
    }
  }

  const insertedPostTags = await db
    .insert(postTags)
    .values([
      {
        id: await generateSnowflakeId(),
        postId: mixedPostId,
        tagId: tagAId,
        createdAt: past,
      },
      {
        id: await generateSnowflakeId(),
        postId: visiblePostId,
        tagId: tagBId,
        createdAt: past,
      },
      {
        id: await generateSnowflakeId(),
        postId: deletedOnlyPostId,
        tagId: tagAId,
        createdAt: past,
      },
    ])
    .returning({ id: postTags.id });
  if (insertedPostTags.length !== 3) {
    throw new Error(
      `Trending fixture setup refused: expected 3 postTags, inserted ${insertedPostTags.length}`
    );
  }
  ownedPostTagIds.push(...insertedPostTags.map((row) => row.id));
});

afterAll(async () => {
  await deleteOwnedRows();
});

for (const signed of [false, true]) {
  describe(`GET /api/trending/group comment counts (${signed ? 'signed steward session' : 'public'})`, () => {
    it('counts only comments that are still visible', async () => {
      if (signed) {
        // Prove the request headers resolve to the fixture user through
        // the same helper the route's publicRateLimit calls, so this
        // variant really runs the authenticated asUser branch.
        const resolved = await optionalAuth(buildGroupRequest(true));
        expect(resolved?.userId).toBe(commenterId);
      }
      const { status, body, limitHeader } = await fetchGroup(signed);
      expect(status).toBe(200);
      if (signed) {
        // Route-level proof that publicRateLimit resolved the session:
        // 180/min is PUBLIC_READ_AUTHED, never the IP/anonymous bucket.
        expect(limitHeader).toBe('180');
      }
      const group = body as GroupResponse;
      expect(group.success).toBe(true);
      const ids = group.posts.map((post) => post.id);
      expect(ids).toContain(mixedPostId);
      expect(ids).toContain(visiblePostId);
      expect(ids).toContain(deletedOnlyPostId);
      expect(commentCountOf(body, mixedPostId)).toBe(2);
      expect(commentCountOf(body, visiblePostId)).toBe(3);
      expect(commentCountOf(body, deletedOnlyPostId)).toBe(0);
    });

    it('observes a moderation change on a repeated read', async () => {
      try {
        await db
          .update(comments)
          .set({ deletedAt: new Date() })
          .where(eq(comments.id, mixedVisibleCommentId));
        const { status, body } = await fetchGroup(signed);
        expect(status).toBe(200);
        expect(commentCountOf(body, mixedPostId)).toBe(1);
      } finally {
        await db
          .update(comments)
          .set({ deletedAt: null })
          .where(eq(comments.id, mixedVisibleCommentId));
      }
      const { status, body } = await fetchGroup(signed);
      expect(status).toBe(200);
      expect(commentCountOf(body, mixedPostId)).toBe(2);
    });
  });
}

describe('fixture ownership', () => {
  it('failed setup publishes no receipt and cleanup spares the pre-existing row', async () => {
    const generated = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    const proposedId = generated[0]!;
    const foreignAuthorId = generated[1]!;
    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60_000);

    const insertedAuthor = await db
      .insert(users)
      .values({
        id: foreignAuthorId,
        username: `test-f5-x-${foreignAuthorId}`,
        displayName: 'Collision Control Author',
        updatedAt: now,
      })
      .returning({ id: users.id });
    expect(insertedAuthor).toHaveLength(1);

    // A pre-existing row occupies the primary key the fixture was going to
    // use — the collision an interrupted setup would run into.
    const preexisting = await db
      .insert(posts)
      .values({
        id: proposedId,
        content: 'pre-existing row the fixture must not own',
        authorId: foreignAuthorId,
        timestamp: past,
        createdAt: past,
      })
      .returning({ id: posts.id });
    expect(preexisting).toHaveLength(1);

    let setupFailed = false;
    try {
      await db.insert(posts).values({
        id: proposedId,
        content: 'fixture attempt on an occupied primary key',
        authorId,
        timestamp: past,
        createdAt: past,
      });
    } catch {
      setupFailed = true;
    }
    expect(setupFailed).toBe(true);
    // The failed insert must not publish ownership.
    expect(ownedPostIds).not.toContain(proposedId);

    // Real cleanup runs now: fixture receipts are removed, the
    // pre-existing row survives because no receipt ever named it.
    await deleteOwnedRows();
    const survivors = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, proposedId));
    expect(survivors).toHaveLength(1);

    // Control rows are removed by their own receipts.
    await db.delete(posts).where(eq(posts.id, proposedId));
    await db.delete(users).where(eq(users.id, foreignAuthorId));
  });
});
