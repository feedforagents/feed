/**
 * A deleted account's shares must stop contributing to existing post
 * counts. Exercise the real route in a verified disposable database and
 * a separate process with its own public-read rate-limit state.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'post shareCount population';
const toggleCase =
  'keeps the count exact across share / duplicate / unshare / re-share';
const deletionCase =
  'stops counting a sharer once that sharer deletes their account';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  // This Next.js marker has no runtime behavior under the Bun test runner.
  mock.module('server-only', () => ({}));
  const { db, eq, posts, shares, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST: sharePOST, DELETE: shareDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/share/route'
  );
  const { GET: detailGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );
  const { GET: interactionsGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/interactions/route'
  );
  const { POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  );

  async function seedPost() {
    const [authorId, sharerId, controlId, postId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    const updatedAt = new Date();
    const past = new Date(updatedAt.getTime() - 10 * 60_000);
    await db.insert(users).values(
      [authorId, sharerId, controlId].map((id) => ({
        id,
        username: `f171-${id}`,
        displayName: 'F171 fixture account',
        updatedAt,
      }))
    );
    await db.insert(posts).values({
      id: postId,
      content: 'Fixture post for share-count deletion test',
      authorId,
      timestamp: past,
      createdAt: past,
    });
    return { authorId, sharerId, controlId, postId };
  }

  function request(path: string, userId: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set('x-dev-user-id', userId);
    return new NextRequest(
      new Request(`http://localhost${path}`, { ...init, headers })
    );
  }

  function context(postId: string) {
    return { params: Promise.resolve({ id: postId }) };
  }

  async function share(
    postId: string,
    userId: string,
    method: 'POST' | 'DELETE' = 'POST'
  ) {
    const response = await (method === 'POST' ? sharePOST : shareDELETE)(
      request(`/api/posts/${postId}/share`, userId, {
        method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      context(postId)
    );
    return response.status;
  }

  async function detailCount(postId: string, userId: string) {
    const res = await detailGET(
      request(`/api/posts/${postId}`, userId),
      context(postId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { shareCount: number } };
    return body.data.shareCount;
  }

  async function interactionsCount(postId: string, userId: string) {
    const res = await interactionsGET(
      request(`/api/posts/${postId}/interactions?limit=10`, userId),
      context(postId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shareCount: number };
    return body.shareCount;
  }

  function postShares(postId: string) {
    return db
      .select({ userId: shares.userId })
      .from(shares)
      .where(eq(shares.postId, postId));
  }

  describe(suite, () => {
    it(toggleCase, async () => {
      const { authorId, sharerId, controlId, postId } = await seedPost();
      expect(await share(postId, sharerId)).toBe(201);
      expect(await detailCount(postId, authorId)).toBe(1);

      expect(await share(postId, sharerId)).toBe(400);
      expect(await detailCount(postId, authorId)).toBe(1);
      expect(await postShares(postId)).toEqual([{ userId: sharerId }]);

      expect(await share(postId, controlId)).toBe(201);
      expect(await detailCount(postId, authorId)).toBe(2);
      expect(await share(postId, sharerId, 'DELETE')).toBe(200);
      expect(await detailCount(postId, authorId)).toBe(1);
      expect(await share(postId, sharerId)).toBe(201);
      expect(await detailCount(postId, authorId)).toBe(2);
    });

    it(deletionCase, async () => {
      const { authorId, sharerId, controlId, postId } = await seedPost();
      expect(await share(postId, sharerId)).toBe(201);
      expect(await share(postId, controlId)).toBe(201);
      const before = await detailCount(postId, authorId);
      expect(before).toBe(2);

      const response = await deleteAccountPOST(
        request('/api/users/delete-account', sharerId, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
        })
      );
      expect(response.status).toBe(200);

      const [gone] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, sharerId));
      expect(gone).toBeUndefined();

      const detail = await detailCount(postId, authorId);
      const interactions = await interactionsCount(postId, authorId);
      const remaining = await postShares(postId);
      console.info('DELETE_ACCOUNT_SHARE_COUNTS', {
        postId,
        deletionStatus: response.status,
        before,
        detail,
        interactions,
        remaining: remaining.length,
      });
      expect(detail).toBe(1);
      expect(interactions).toBe(1);
      expect(remaining).toEqual([{ userId: controlId }]);
    });
  });
} else {
  it('runs the share and deletion cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-share-count-deleted-account',
      file: 'packages/testing/integration/post-share-count-deleted-account.integration.test.ts',
      cases: [`${suite} > ${toggleCase}`, `${suite} > ${deletionCase}`],
    });
  }, 300_000);
}
