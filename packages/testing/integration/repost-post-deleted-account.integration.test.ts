/**
 * Repost posts after the sharer deletes their account, against a real
 * database and the real routes.
 *
 * Sharing a post creates a repost post (posts row with originalPostId set,
 * authored by the sharer). The product's own contract ties that repost
 * post's life to the share: unsharing (DELETE /api/posts/[id]/share)
 * hard-deletes the repost post along with the share row — its route
 * description says "Removes share and deletes associated repost post".
 *
 * Account deletion (POST /api/users/delete-account) ends every share the
 * user ever made, and its response states "Your account and personal data
 * have been deleted from our servers." But the route never touches the
 * posts table, and Post carries no foreign keys at all, so nothing
 * cascades: the deleted user's repost posts (pure reposts and quote
 * posts alike) survive forever, still publicly readable through
 * GET /api/posts/[id], still embedding the original post's content and
 * attributed to the deleted account's raw id.
 *
 * Guard in the same file: the unshare path must keep deleting the repost
 * post (the shipped precedent this fix mirrors), and another user's
 * repost of the same original must be untouched.
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
  isNotNull,
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
let controlId: string;
let postId: string;
let post2Id: string;
let ownPostId: string;
let repostId: string;
let quotePostId: string;
let controlRepostId: string;
const ownedUserIds: string[] = [];

let sharePOST: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').POST;
let shareDELETE: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').DELETE;
let detailGET: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
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

async function share(
  userId: string,
  targetPostId: string,
  method: 'POST' | 'DELETE' = 'POST',
  comment?: string
) {
  const handler = method === 'POST' ? sharePOST : shareDELETE;
  const response = await handler(
    req(
      `http://localhost/api/posts/${targetPostId}/share`,
      userId,
      method,
      method === 'POST' ? (comment ? { comment } : {}) : undefined
    ),
    { params: Promise.resolve({ id: targetPostId }) }
  );
  return response.status;
}

async function repostRowsBy(userId: string) {
  return db
    .select({ id: posts.id, originalPostId: posts.originalPostId })
    .from(posts)
    .where(and(eq(posts.authorId, userId), isNotNull(posts.originalPostId)));
}

async function detail(viewerId: string, targetId: string) {
  const response = await detailGET(
    req(`http://localhost/api/posts/${targetId}`, viewerId),
    { params: Promise.resolve({ id: targetId }) }
  );
  const body = (await response.json().catch(() => null)) as {
    data?: {
      authorId?: string;
      isRepost?: boolean;
      quoteComment?: string | null;
      originalPost?: { content?: string };
    };
  } | null;
  return { status: response.status, data: body?.data };
}

beforeAll(async () => {
  ({ POST: sharePOST, DELETE: shareDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/share/route'
  ));
  ({ GET: detailGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));
  ({ POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  ));

  [authorId, sharerId, controlId, postId, post2Id, ownPostId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  ownedUserIds.push(authorId, sharerId, controlId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  // privyId = own id so ensureUserForAuth resolves the fixture row
  // directly instead of provisioning a fresh account.
  await db.insert(users).values([
    {
      id: authorId,
      privyId: authorId,
      username: `f175-author-${authorId}`,
      displayName: 'F175 Author',
      updatedAt: now,
    },
    {
      id: sharerId,
      privyId: sharerId,
      username: `f175-sharer-${sharerId}`,
      displayName: 'F175 Sharer',
      updatedAt: now,
    },
    {
      id: controlId,
      privyId: controlId,
      username: `f175-control-${controlId}`,
      displayName: 'F175 Control',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values([
    {
      id: postId,
      content: 'Fixture original post for repost deletion test',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: post2Id,
      content: 'Second fixture original for quote repost test',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: ownPostId,
      content: 'Sharer own original post (observation only)',
      authorId: sharerId,
      timestamp: past,
      createdAt: past,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(inArray(notifications.postId, [postId, post2Id]))
    .catch(() => {});
  await db.delete(shares).where(inArray(shares.postId, [postId, post2Id]));
  await db
    .delete(posts)
    .where(
      or(
        inArray(posts.id, [postId, post2Id, ownPostId]),
        inArray(posts.originalPostId, [postId, post2Id])
      )
    );
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('repost posts and account deletion', () => {
  it('unshare deletes the repost post (shipped precedent)', async () => {
    expect(await share(sharerId, postId)).toBe(201);
    const created = await repostRowsBy(sharerId);
    expect(created).toHaveLength(1);

    expect(await share(sharerId, postId, 'DELETE')).toBe(200);
    expect(await repostRowsBy(sharerId)).toHaveLength(0);

    // Re-share so the deletion test below has a live repost again.
    expect(await share(sharerId, postId)).toBe(201);
    const recreated = await repostRowsBy(sharerId);
    expect(recreated).toHaveLength(1);
    repostId = recreated[0]!.id;

    // Quote repost on the second original.
    expect(await share(sharerId, post2Id, 'POST', 'sharer quote words')).toBe(
      201
    );
    const all = await repostRowsBy(sharerId);
    expect(all).toHaveLength(2);
    quotePostId = all.find((r) => r.originalPostId === post2Id)!.id;

    // Control: another user's repost of the same original.
    expect(await share(controlId, postId)).toBe(201);
    const controlRows = await repostRowsBy(controlId);
    expect(controlRows).toHaveLength(1);
    controlRepostId = controlRows[0]!.id;

    // The live repost is publicly readable and embeds the original.
    const live = await detail(authorId, repostId);
    expect(live.status).toBe(200);
    expect(live.data?.isRepost).toBe(true);
    expect(live.data?.originalPost?.content).toBe(
      'Fixture original post for repost deletion test'
    );
  });

  it('account deletion removes the sharer repost posts', async () => {
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

    // Every repost post the sharer created must be gone with the account,
    // exactly as unsharing removes one: pure repost and quote post alike.
    expect(await repostRowsBy(sharerId)).toHaveLength(0);

    const repostDetail = await detail(authorId, repostId);
    expect(repostDetail.status).toBe(404);
    const quoteDetail = await detail(authorId, quotePostId);
    expect(quoteDetail.status).toBe(404);

    // The control user's repost of the same original is untouched.
    const controlRows = await repostRowsBy(controlId);
    expect(controlRows).toHaveLength(1);
    const controlDetail = await detail(authorId, controlRepostId);
    expect(controlDetail.status).toBe(200);
    expect(controlDetail.data?.isRepost).toBe(true);
  });
});
