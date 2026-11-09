/** Real HTTP/state evidence for desired social actions resumed after sign-in.
 * Local signed Steward identities exercise canonical account resolution; they
 * are not evidence of a live provider login or concurrent-request behavior. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  and,
  comments,
  dbWrite as db,
  eq,
  follows,
  inArray,
  notifications,
  posts,
  reactions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { z } from 'zod';

let base: string;
let viewer: string;
let author: string;
let commentAuthor: string;
let stewardSubject: string;
let postId: string;
let commentId: string;
let jwt: string;
const userIds: string[] = [];
const acceptedAt = new Date(Date.now() - 60_000);
const errorSchema = z.object({ error: z.string() });
const likeSchema = z.object({
  data: z.object({ isLiked: z.boolean(), likeCount: z.number() }),
});

async function post(path: string, authenticated: boolean) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: authenticated ? { Cookie: `steward-token=${jwt}` } : {},
  });
}

async function persistedState() {
  const [reactionRows, followRows, notificationRows] = await Promise.all([
    db
      .select()
      .from(reactions)
      .where(eq(reactions.userId, viewer))
      .orderBy(reactions.id),
    db
      .select()
      .from(follows)
      .where(eq(follows.followerId, viewer))
      .orderBy(follows.id),
    db
      .select()
      .from(notifications)
      .where(eq(notifications.actorId, viewer))
      .orderBy(notifications.id),
  ]);
  return { reactionRows, followRows, notificationRows };
}

describe('pending social intent desired-state POSTs', () => {
  beforeAll(async () => {
    base = process.env.TEST_BASE_URL ?? '';
    if (!base)
      throw new Error(
        'Run through bun run test:integration for a real Next server'
      );
    for (let i = 0; i < 3; i++) userIds.push(await generateSnowflakeId());
    [viewer, author, commentAuthor] = userIds as [string, string, string];
    stewardSubject = `intent-steward-${viewer}`;
    await db.insert(users).values(
      userIds.map((id) => ({
        id,
        stewardId: id === viewer ? stewardSubject : `intent-steward-${id}`,
        username: `intent_${id}`,
        displayName: 'Intent integration account',
        profileComplete: true,
        isTest: false,
        tosAcceptedAt: acceptedAt,
        emailNotificationsEnabled: false,
        updatedAt: new Date(),
      }))
    );
    postId = await generateSnowflakeId();
    commentId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: postId,
      authorId: author,
      content: 'Desired-state post fixture',
      timestamp: new Date(Date.now() - 60_000),
    });
    await db.insert(comments).values({
      id: commentId,
      postId,
      authorId: commentAuthor,
      content: 'Desired-state comment fixture',
      updatedAt: new Date(),
    });
    jwt = await new SignJWT({ userId: stewardSubject })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setExpirationTime('10m')
      .sign(
        new TextEncoder().encode(
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
        )
      );
  });

  afterAll(async () => {
    if (!userIds.length) return;
    await db
      .delete(notifications)
      .where(inArray(notifications.actorId, userIds));
    await db.delete(reactions).where(inArray(reactions.userId, userIds));
    await db.delete(follows).where(inArray(follows.followerId, userIds));
    await db.delete(comments).where(inArray(comments.authorId, userIds));
    await db.delete(posts).where(inArray(posts.authorId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  test('/me returns the canonical account persisted Terms timestamp, including null', async () => {
    const read = async () => {
      const response = await fetch(`${base}/api/users/me`, {
        headers: { Cookie: `steward-token=${jwt}` },
      });
      expect(response.status).toBe(200);
      return z
        .object({
          authenticated: z.literal(true),
          user: z.object({
            id: z.string(),
            tosAcceptedAt: z.string().nullable(),
          }),
        })
        .parse(await response.json()).user;
    };
    expect(await read()).toEqual({
      id: viewer,
      tosAcceptedAt: acceptedAt.toISOString(),
    });
    await db
      .update(users)
      .set({ tosAcceptedAt: null })
      .where(eq(users.id, viewer));
    try {
      expect(await read()).toEqual({ id: viewer, tosAcceptedAt: null });
      expect(
        await db
          .select({ tosAcceptedAt: users.tosAcceptedAt })
          .from(users)
          .where(eq(users.id, viewer))
      ).toEqual([{ tosAcceptedAt: null }]);
    } finally {
      await db
        .update(users)
        .set({ tosAcceptedAt: acceptedAt })
        .where(eq(users.id, viewer));
    }
  });

  for (const kind of ['post-like', 'comment-like', 'follow'] as const) {
    test(`${kind}: canonical cookie identity creates one record and notification, repeated POST preserves both`, async () => {
      const path =
        kind === 'post-like'
          ? `/api/posts/${postId}/like`
          : kind === 'comment-like'
            ? `/api/comments/${commentId}/like`
            : `/api/users/${author}/follow`;
      const before = await persistedState();
      expect((await post(path, false)).status).toBe(401);
      expect(await persistedState()).toEqual(before);

      const first = await post(path, true);
      expect(first.status).toBe(kind === 'post-like' ? 200 : 201);
      if (kind !== 'follow') {
        const body = likeSchema.parse(await first.json());
        expect(body.data).toMatchObject({ isLiked: true, likeCount: 1 });
      }
      const afterFirst = await persistedState();
      const mutation =
        kind === 'follow'
          ? afterFirst.followRows.filter((row) => row.followingId === author)
          : afterFirst.reactionRows.filter((row) =>
              kind === 'post-like'
                ? row.postId === postId && row.type === 'like'
                : row.commentId === commentId && row.type === 'like'
            );
      expect(mutation).toHaveLength(1);
      const emitted = afterFirst.notificationRows.filter((row) =>
        kind === 'follow'
          ? row.type === 'follow' && row.userId === author
          : row.type === 'reaction' &&
            (kind === 'post-like'
              ? row.postId === postId &&
                row.commentId === null &&
                row.userId === author
              : row.commentId === commentId && row.userId === commentAuthor)
      );
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.actorId).toBe(viewer);

      const repeated = await post(path, true);
      expect(repeated.status).toBe(400);
      expect(errorSchema.parse(await repeated.json()).error).toBe(
        kind === 'post-like'
          ? 'Post already liked'
          : kind === 'comment-like'
            ? 'Comment already liked'
            : 'Already following this user'
      );
      expect(await persistedState()).toEqual(afterFirst);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, stewardSubject))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.stewardId, stewardSubject))
      ).toEqual([{ id: viewer }]);
      expect(
        await db
          .select({ id: reactions.id })
          .from(reactions)
          .where(eq(reactions.userId, stewardSubject))
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: follows.id })
          .from(follows)
          .where(eq(follows.followerId, stewardSubject))
      ).toHaveLength(0);
      if (kind === 'follow') {
        const status = await fetch(`${base}${path}`, {
          headers: { Cookie: `steward-token=${jwt}` },
        });
        expect(status.status).toBe(200);
        expect(
          z.object({ isFollowing: z.boolean() }).parse(await status.json())
            .isFollowing
        ).toBe(true);
      } else {
        const row = await db
          .select({ id: reactions.id })
          .from(reactions)
          .where(
            and(
              eq(reactions.userId, viewer),
              eq(
                kind === 'post-like' ? reactions.postId : reactions.commentId,
                kind === 'post-like' ? postId : commentId
              )
            )
          );
        expect(row).toHaveLength(1);
      }
    });
  }
});
