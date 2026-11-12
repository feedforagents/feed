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
 * Reads without and with the CI bearer use the real route and database;
 * no module is mocked. This route's optionalAuth does not accept the CI
 * bearer, so neither case claims production authenticated-viewer coverage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
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
const allPostIds: string[] = [];
const allCommentIds: string[] = [];
let GET: typeof import('../../../apps/web/src/app/api/trending/group/route').GET;

async function fetchGroup(withCiBearer = false) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/trending/group?tags=f5-alpha-${authorId},f5-beta-${authorId}&limit=10`,
      {
        headers: {
          'x-forwarded-for': clientIp,
          ...(withCiBearer
            ? { authorization: `Bearer steward:test:${authorId}` }
            : {}),
        },
      }
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | GroupResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

function commentCountOf(
  body: GroupResponse | { error?: unknown } | null,
  postId: string
) {
  const group = body as GroupResponse;
  return group.posts.find((post) => post.id === postId)?.commentCount;
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
  allPostIds.push(mixedPostId, visiblePostId, deletedOnlyPostId);
  // Isolate this fixture from other public reads while exercising the real
  // limiter. No request falls into CI's shared anonymous bucket.
  clientIp = `2001:db8:1656:1:${BigInt(authorId)
    .toString(16)
    .padStart(16, '0')
    .match(/.{4}/g)!
    .join(':')}`;
  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  await db.insert(users).values([
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
      updatedAt: now,
    },
  ]);
  await db.insert(tags).values([
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
  ]);
  // One post with visible and moderated comments, one post whose comments
  // are all visible, and one post whose comments are all soft-deleted.
  await db.insert(posts).values([
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
  ]);
  const commentSpecs = [
    { postId: mixedPostId, visible: 2, deleted: 2 },
    { postId: visiblePostId, visible: 3, deleted: 0 },
    { postId: deletedOnlyPostId, visible: 0, deleted: 2 },
  ];
  for (const spec of commentSpecs) {
    for (let i = 0; i < spec.visible + spec.deleted; i++) {
      const id = await generateSnowflakeId();
      await db.insert(comments).values({
        id,
        content: 'Trending comment count fixture',
        postId: spec.postId,
        authorId: commenterId,
        createdAt: past,
        updatedAt: past,
        deletedAt: i < spec.visible ? null : past,
      });
      allCommentIds.push(id);
      if (spec.postId === mixedPostId && i === 0) mixedVisibleCommentId = id;
    }
  }
  const postTagIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(postTags).values([
    {
      id: postTagIds[0]!,
      postId: mixedPostId,
      tagId: tagAId,
      createdAt: past,
    },
    {
      id: postTagIds[1]!,
      postId: visiblePostId,
      tagId: tagBId,
      createdAt: past,
    },
    {
      id: postTagIds[2]!,
      postId: deletedOnlyPostId,
      tagId: tagAId,
      createdAt: past,
    },
  ]);
});
afterAll(async () => {
  await db.delete(postTags).where(inArray(postTags.postId, allPostIds));
  if (allCommentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, allCommentIds));
  }
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(tags).where(inArray(tags.id, [tagAId, tagBId]));
  await db.delete(users).where(inArray(users.id, [authorId, commenterId]));
});

for (const withCiBearer of [false, true]) {
  describe(`GET /api/trending/group comment counts (${withCiBearer ? 'CI bearer' : 'public'})`, () => {
    it('counts only comments that are still visible', async () => {
      const { status, body } = await fetchGroup(withCiBearer);
      expect(status).toBe(200);
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
        const { status, body } = await fetchGroup(withCiBearer);
        expect(status).toBe(200);
        expect(commentCountOf(body, mixedPostId)).toBe(1);
      } finally {
        await db
          .update(comments)
          .set({ deletedAt: null })
          .where(eq(comments.id, mixedVisibleCommentId));
      }
      const { status, body } = await fetchGroup(withCiBearer);
      expect(status).toBe(200);
      expect(commentCountOf(body, mixedPostId)).toBe(2);
    });
  });
}
