/**
 * Post shareCount after the sharer deletes their account, against a real
 * database and the real routes.
 *
 * POST /api/users/delete-account states the contract in its own response:
 * "Your account and personal data have been deleted from our servers." The
 * route deletes the user's follows, interactions, group memberships,
 * invites, follow statuses, share actions and pool deposits inside the
 * deletion transaction and relies on schema cascades for "most other
 * tables". Share has no foreign keys at all, so nothing cascades: the
 * deleted user's share rows survive and every shareCount surface (post
 * detail, post interactions, embed, feed pipelines) keeps counting a
 * person who no longer exists.
 *
 * Sibling precedent for cleaning shares up with their owner: unsharing a
 * post (DELETE /api/posts/[id]/share) deletes the share row and the count
 * drops immediately. Deleting the account must do the same for the shares
 * the account made. (Same shape as the Reaction orphan fixed for likes:
 * the delete transaction must clear the user's rows in tables that carry
 * no foreign keys.)
 *
 * Toggle guard in the same file: the share -> duplicate-share -> unshare
 * -> re-share cycle must keep the count exact (the Share table also has a
 * unique (userId, postId) constraint).
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
  or,
  posts,
  shares,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let authorId: string;
let sharerId: string;
let controlSharerId: string;
let postId: string;
const ownedUserIds: string[] = [];

let sharePOST: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').POST;
let shareDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').DELETE;
let detailGET: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
let interactionsGET: typeof import('../../../apps/web/src/app/api/posts/[id]/interactions/route').GET;
let deleteAccountPOST: typeof import('../../../apps/web/src/app/api/users/delete-account/route').POST;

function req(url: string, userId: string, method = 'GET', body?: unknown) {
  return new NextRequest(
    new Request(url, {
      method,
      headers: {
        'x-dev-user-id': userId,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

async function share(userId: string, method: 'POST' | 'DELETE' = 'POST') {
  const handler = method === 'POST' ? sharePOST : shareDELETE;
  const response = await handler(
    req(
      `http://localhost/api/posts/${postId}/share`,
      userId,
      method,
      method === 'POST' ? {} : undefined
    ),
    { params: Promise.resolve({ id: postId }) }
  );
  return response.status;
}

async function detailShareCount(viewerId: string) {
  const response = await detailGET(
    req(`http://localhost/api/posts/${postId}`, viewerId),
    { params: Promise.resolve({ id: postId }) }
  );
  const body = (await response.json().catch(() => null)) as {
    data?: { post?: { shareCount?: number }; shareCount?: number };
  } | null;
  return body?.data?.post?.shareCount ?? body?.data?.shareCount;
}

async function interactionsShareCount(viewerId: string) {
  const response = await interactionsGET(
    req(`http://localhost/api/posts/${postId}/interactions?limit=10`, viewerId),
    { params: Promise.resolve({ id: postId }) }
  );
  const body = (await response.json().catch(() => null)) as {
    data?: { shareCount?: number };
    shareCount?: number;
  } | null;
  return body?.data?.shareCount ?? body?.shareCount;
}

async function shareRowsBy(userId: string) {
  return db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.postId, postId), eq(shares.userId, userId)));
}

beforeAll(async () => {
  ({ POST: sharePOST, DELETE: shareDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/share/route'
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

  [authorId, sharerId, controlSharerId, postId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  ownedUserIds.push(authorId, sharerId, controlSharerId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  // privyId = own id so ensureUserForAuth resolves the fixture row
  // directly instead of provisioning a fresh account.
  await db.insert(users).values([
    {
      id: authorId,
      privyId: authorId,
      username: `f171-author-${authorId}`,
      displayName: 'F171 Author',
      updatedAt: now,
    },
    {
      id: sharerId,
      privyId: sharerId,
      username: `f171-sharer-${sharerId}`,
      displayName: 'F171 Sharer',
      updatedAt: now,
    },
    {
      id: controlSharerId,
      privyId: controlSharerId,
      username: `f171-control-${controlSharerId}`,
      displayName: 'F171 Control Sharer',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values({
    id: postId,
    content: 'Fixture post for share-count deletion test',
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
  await db.delete(shares).where(eq(shares.postId, postId));
  await db
    .delete(posts)
    .where(or(eq(posts.id, postId), eq(posts.originalPostId, postId)));
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('post shareCount population', () => {
  it('keeps the count exact across share / duplicate / unshare / re-share', async () => {
    expect(await share(sharerId)).toBe(201);
    expect(await detailShareCount(authorId)).toBe(1);

    // Duplicate share is rejected and does not double-count.
    expect(await share(sharerId)).toBe(400);
    expect(await detailShareCount(authorId)).toBe(1);
    expect(await shareRowsBy(sharerId)).toHaveLength(1);

    expect(await share(controlSharerId)).toBe(201);
    expect(await detailShareCount(authorId)).toBe(2);

    expect(await share(sharerId, 'DELETE')).toBe(200);
    expect(await detailShareCount(authorId)).toBe(1);

    expect(await share(sharerId)).toBe(201);
    expect(await detailShareCount(authorId)).toBe(2);
  });

  it('stops counting a sharer once that sharer deletes their account', async () => {
    const response = await deleteAccountPOST(
      req('http://localhost/api/users/delete-account', sharerId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(response.status).toBe(200);

    // The account itself is gone (the route's own contract).
    const [gone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, sharerId));
    expect(gone).toBeUndefined();

    // Its shares must be gone too, and every count surface must agree:
    // only the control sharer remains.
    expect(await detailShareCount(authorId)).toBe(1);
    expect(await interactionsShareCount(authorId)).toBe(1);
    expect(await shareRowsBy(sharerId)).toHaveLength(0);
  });
});
