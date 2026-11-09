/**
 * PRD §12 / MVP phase 5: moderated comments must not inflate the existing
 * trending-post count or ranking. Uses the real route and PostgreSQL.
 * Only the server-only environment marker is stubbed.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';

mock.module('server-only', () => ({}));

import { optionalAuth } from '@feed/api';
import {
  comments,
  db,
  eq,
  inArray,
  posts,
  reactions,
  sql,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/trending-posts/route';

const userIds: string[] = [];
const postIds: string[] = [];
const commentIds: string[] = [];
const reactionIds: string[] = [];
let authorId: string;
let actorId: string;
let mixedVisibleCommentId: string;
let viewerId: string;
let mixedId: string;
let controlId: string;
let deletedOnlyId: string;
let deletedWithLikeId: string;
let token: string;
let fixtureTime: Date;

interface TrendingPost {
  id: string;
  authorId: string;
  commentCount: number;
  likeCount: number;
  shareCount: number;
  trendingScore: number;
}

beforeAll(async () => {
  const actor = StaticDataRegistry.getAllActors()[0];
  if (!actor) throw new Error('A real registry actor is required');
  actorId = actor.id;
  // The widget returns the global top five. Keep this test's 24-hour window
  // separate from existing rows without deleting or modifying those rows.
  const [bounds] = await db
    .select({ oldest: sql<string | null>`min(${posts.timestamp})::text` })
    .from(posts);
  const oldest = bounds?.oldest
    ? new Date(bounds.oldest).getTime()
    : Date.now();
  fixtureTime = new Date(Math.min(Date.now(), oldest) - 48 * 60 * 60 * 1000);
  const newUserIds = await Promise.all(
    Array.from({ length: 7 }, () => generateSnowflakeId())
  );
  [authorId, viewerId] = newUserIds as [string, string, ...string[]];
  const now = fixtureTime;
  await db.insert(users).values(
    newUserIds.map((id) => ({
      id,
      username: `tpc${id}`,
      displayName: 'Trending count fixture',
      isTest: true,
      updatedAt: now,
      stewardId: id === viewerId ? `trending-${viewerId}` : null,
    }))
  );
  userIds.push(...newUserIds);
  token = await new SignJWT({ userId: `trending-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setNotBefore(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(
      new TextEncoder().encode(
        process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod'
      )
    );

  const newPostIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  [mixedId, controlId, deletedOnlyId, deletedWithLikeId] = newPostIds as [
    string,
    string,
    string,
    string,
  ];
  await db.insert(posts).values(
    newPostIds.map((id) => ({
      id,
      content: 'Trending count fixture',
      authorId,
      timestamp: now,
      createdAt: now,
    }))
  );
  postIds.push(...newPostIds);

  const commentSets = [
    { postId: mixedId, visible: 2, deleted: 2 },
    { postId: controlId, visible: 3, deleted: 0 },
    { postId: deletedOnlyId, visible: 0, deleted: 2 },
    { postId: deletedWithLikeId, visible: 0, deleted: 2 },
  ];
  for (const fixture of commentSets) {
    for (let i = 0; i < fixture.visible + fixture.deleted; i++) {
      const id = await generateSnowflakeId();
      await db.insert(comments).values({
        id,
        content: 'Trending count comment',
        postId: fixture.postId,
        authorId,
        createdAt: now,
        updatedAt: now,
        deletedAt: i < fixture.visible ? null : now,
      });
      commentIds.push(id);
      if (fixture.postId === mixedId && i === 0) mixedVisibleCommentId = id;
    }
  }
  for (const postId of [mixedId, controlId, deletedWithLikeId]) {
    const likers = postId === deletedWithLikeId ? [viewerId] : userIds.slice(2);
    for (const userId of likers) {
      const id = await generateSnowflakeId();
      await db.insert(reactions).values({ id, postId, userId, type: 'like' });
      reactionIds.push(id);
    }
  }
});

afterAll(async () => {
  if (reactionIds.length) {
    await db.delete(reactions).where(inArray(reactions.id, reactionIds));
  }
  if (commentIds.length) {
    await db.delete(comments).where(inArray(comments.id, commentIds));
  }
  if (postIds.length) await db.delete(posts).where(inArray(posts.id, postIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

async function fetchTrending(signedIn: boolean): Promise<TrendingPost[]> {
  const request = new NextRequest(
    'http://localhost/api/feed/widgets/trending-posts',
    { headers: signedIn ? { Authorization: `Bearer ${token}` } : undefined }
  );
  // Tokens are valid only in this five-minute synthetic window, already
  // expired at wall-clock time. Restore the clock even on assertion failure.
  setSystemTime(fixtureTime);
  try {
    const auth = await optionalAuth(request);
    if (signedIn) expect(auth?.userId).toBe(viewerId);
    else expect(auth).toBeNull();
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: TrendingPost[] };
    return body.posts;
  } finally {
    setSystemTime();
  }
}

describe('Trending posts exclude moderated comment engagement', () => {
  for (const authorKind of ['human', 'actor']) {
    for (const signedIn of [false, true]) {
      it(`preserves visible counts and ranking (${authorKind}, ${signedIn ? 'signed-in' : 'public'})`, async () => {
        const expectedAuthorId = authorKind === 'human' ? authorId : actorId;
        await db
          .update(posts)
          .set({ authorId: expectedAuthorId })
          .where(inArray(posts.id, postIds));
        const result = await fetchTrending(signedIn);
        const mixed = result.find((post) => post.id === mixedId);
        const control = result.find((post) => post.id === controlId);
        const deletedWithLike = result.find(
          (post) => post.id === deletedWithLikeId
        );
        expect(mixed).toBeDefined();
        expect(control).toBeDefined();
        expect(deletedWithLike).toBeDefined();
        expect(mixed?.authorId).toBe(expectedAuthorId);
        expect(control?.authorId).toBe(expectedAuthorId);
        expect(mixed?.commentCount).toBe(2);
        expect(control?.commentCount).toBe(3);
        expect(mixed?.likeCount).toBe(5);
        expect(control?.likeCount).toBe(5);
        expect(mixed?.shareCount).toBe(0);
        expect(deletedWithLike?.commentCount).toBe(0);
        expect(deletedWithLike?.likeCount).toBe(1);
        expect(result.some((post) => post.id === deletedOnlyId)).toBe(false);
        expect(result.findIndex((post) => post.id === controlId)).toBeLessThan(
          result.findIndex((post) => post.id === mixedId)
        );
        expect(control!.trendingScore).toBeGreaterThan(mixed!.trendingScore);

        const repeated = await fetchTrending(signedIn);
        expect(repeated.find((post) => post.id === mixedId)?.commentCount).toBe(
          2
        );
        expect(
          repeated.find((post) => post.id === controlId)?.commentCount
        ).toBe(3);
      });
    }
  }

  it('observes moderation changes on repeated public and signed-in reads', async () => {
    try {
      for (const signedIn of [false, true]) {
        expect(
          (await fetchTrending(signedIn)).find((post) => post.id === mixedId)
            ?.commentCount
        ).toBe(2);
      }
      await db
        .update(comments)
        .set({ deletedAt: fixtureTime })
        .where(eq(comments.id, mixedVisibleCommentId));
      for (const signedIn of [false, true]) {
        expect(
          (await fetchTrending(signedIn)).find((post) => post.id === mixedId)
            ?.commentCount
        ).toBe(1);
      }
    } finally {
      await db
        .update(comments)
        .set({ deletedAt: null })
        .where(eq(comments.id, mixedVisibleCommentId));
    }
  });
});
