/**
 * Post likeCount after the liker deletes their account, against a real
 * database and the real routes.
 *
 * POST /api/users/delete-account states the contract in its own response:
 * "Your account and personal data have been deleted from our servers." The
 * route deletes the user's follows, interactions, group memberships,
 * invites, follow statuses, share actions and pool deposits inside the
 * deletion transaction and relies on schema cascades for "most other
 * tables". Reaction has no foreign keys at all, so nothing cascades: the
 * deleted user's like rows survive and every likeCount surface (post
 * detail, post interactions, feed pipelines) keeps counting a person who
 * no longer exists.
 *
 * Sibling precedent for cleaning reactions up with their owner: deleting
 * a comment deletes the reactions on that comment
 * (apps/web/src/app/api/comments/[id]/route.ts). Deleting the account must
 * do the same for the reactions the account made.
 *
 * Toggle guard in the same file: the like -> duplicate-like -> unlike ->
 * re-like cycle must keep the count exact (the Reaction table also has a
 * unique (postId, userId, type) constraint).
 *
 * Auth uses the non-production x-dev-user-id header. Only the
 * `server-only` marker package is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  and,
  db,
  eq,
  inArray,
  notifications,
  posts,
  reactions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let authorId: string;
let likerId: string;
let controlLikerId: string;
let postId: string;
const ownedUserIds: string[] = [];

let likePOST: typeof import('../../../apps/web/src/app/api/posts/[id]/like/route').POST;
let likeDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/like/route').DELETE;
let detailGET: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
let interactionsGET: typeof import('../../../apps/web/src/app/api/posts/[id]/interactions/route').GET;
let deleteAccountPOST: typeof import('../../../apps/web/src/app/api/users/delete-account/route').POST;

function req(url: string, userId: string, method = 'GET', body?: unknown) {
  return new NextRequest(
    new Request(url, {
      method,
      headers: {
        'x-dev-user-id': userId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

async function like(userId: string, method: 'POST' | 'DELETE' = 'POST') {
  const response = await (method === 'POST' ? likePOST : likeDELETE)(
    req(`http://localhost/api/posts/${postId}/like`, userId, method),
    { params: Promise.resolve({ id: postId }) }
  );
  return response.status;
}

async function detailLikeCount(viewerId: string) {
  const response = await detailGET(
    req(`http://localhost/api/posts/${postId}`, viewerId),
    { params: Promise.resolve({ id: postId }) }
  );
  const body = (await response.json().catch(() => null)) as {
    data?: { post?: { likeCount?: number }; likeCount?: number };
  } | null;
  return body?.data?.post?.likeCount ?? body?.data?.likeCount;
}

async function interactionsLikeCount(viewerId: string) {
  const response = await interactionsGET(
    req(`http://localhost/api/posts/${postId}/interactions?limit=10`, viewerId),
    { params: Promise.resolve({ id: postId }) }
  );
  const body = (await response.json().catch(() => null)) as {
    data?: { likeCount?: number };
    likeCount?: number;
  } | null;
  return body?.data?.likeCount ?? body?.likeCount;
}

async function likeRowsBy(userId: string) {
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.postId, postId),
        eq(reactions.userId, userId),
        eq(reactions.type, 'like')
      )
    );
}

beforeAll(async () => {
  ({ POST: likePOST, DELETE: likeDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/like/route'
  ));
  ({ GET: detailGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));
  ({ GET: interactionsGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/interactions/route'
  ));
  ({ POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  ));

  [authorId, likerId, controlLikerId, postId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  ownedUserIds.push(authorId, likerId, controlLikerId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  // privyId = own id so ensureUserForAuth resolves the fixture row
  // directly instead of provisioning a fresh account.
  await db.insert(users).values([
    {
      id: authorId,
      privyId: authorId,
      username: `f166-author-${authorId}`,
      displayName: 'F166 Author',
      updatedAt: now,
    },
    {
      id: likerId,
      privyId: likerId,
      username: `f166-liker-${likerId}`,
      displayName: 'F166 Liker',
      updatedAt: now,
    },
    {
      id: controlLikerId,
      privyId: controlLikerId,
      username: `f166-control-${controlLikerId}`,
      displayName: 'F166 Control Liker',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values({
    id: postId,
    content: 'Fixture post for like-count deletion test',
    authorId,
    timestamp: past,
    createdAt: past,
  });
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(eq(notifications.postId, postId))
    .catch(() => {});
  await db.delete(reactions).where(eq(reactions.postId, postId));
  await db.delete(posts).where(eq(posts.id, postId));
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('post likeCount population', () => {
  it('keeps the count exact across like / duplicate / unlike / re-like', async () => {
    expect(await like(likerId)).toBe(200);
    expect(await detailLikeCount(authorId)).toBe(1);

    // Duplicate like is rejected and does not double-count.
    expect(await like(likerId)).toBe(400);
    expect(await detailLikeCount(authorId)).toBe(1);
    expect(await likeRowsBy(likerId)).toHaveLength(1);

    expect(await like(controlLikerId)).toBe(200);
    expect(await detailLikeCount(authorId)).toBe(2);

    expect(await like(likerId, 'DELETE')).toBe(200);
    expect(await detailLikeCount(authorId)).toBe(1);

    expect(await like(likerId)).toBe(200);
    expect(await detailLikeCount(authorId)).toBe(2);
  });

  it('stops counting a liker once that liker deletes their account', async () => {
    const response = await deleteAccountPOST(
      req('http://localhost/api/users/delete-account', likerId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(response.status).toBe(200);

    // The account itself is gone (the route's own contract).
    const [gone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, likerId));
    expect(gone).toBeUndefined();

    // Its likes must be gone too, and every count surface must agree:
    // only the control liker remains.
    expect(await detailLikeCount(authorId)).toBe(1);
    expect(await interactionsLikeCount(authorId)).toBe(1);
    expect(await likeRowsBy(likerId)).toHaveLength(0);
  });
});
