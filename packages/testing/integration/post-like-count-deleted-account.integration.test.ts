/**
 * A deleted account's reactions must stop contributing to existing post
 * counts. Exercise the real route in a verified disposable database and
 * a separate process with its own public-read rate-limit state.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'post likeCount population';
const toggleCase =
  'keeps the count exact across like / duplicate / unlike / re-like';
const deletionCase =
  'stops counting a liker once that liker deletes their account';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();

  // This Next.js marker has no runtime behavior under the Bun test runner.
  mock.module('server-only', () => ({}));
  const { db, eq, posts, reactions, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST: likePOST, DELETE: likeDELETE } = await import(
    '../../../apps/web/src/app/api/posts/[id]/like/route'
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
    const [authorId, likerId, controlId, postId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    const updatedAt = new Date();
    const past = new Date(updatedAt.getTime() - 10 * 60_000);
    await db.insert(users).values(
      [authorId, likerId, controlId].map((id) => ({
        id,
        username: `f166-${id}`,
        displayName: 'F166 fixture account',
        updatedAt,
      }))
    );
    await db.insert(posts).values({
      id: postId,
      content: 'Fixture post for like-count deletion test',
      authorId,
      timestamp: past,
      createdAt: past,
    });
    return { authorId, likerId, controlId, postId };
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

  async function like(
    postId: string,
    userId: string,
    method: 'POST' | 'DELETE' = 'POST'
  ) {
    const response = await (method === 'POST' ? likePOST : likeDELETE)(
      request(`/api/posts/${postId}/like`, userId, { method }),
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
    const body = (await res.json()) as { data: { likeCount: number } };
    return body.data.likeCount;
  }

  async function interactionsCount(postId: string, userId: string) {
    const res = await interactionsGET(
      request(`/api/posts/${postId}/interactions?limit=10`, userId),
      context(postId)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { likeCount: number };
    return body.likeCount;
  }

  function postReactions(postId: string) {
    return db
      .select({ userId: reactions.userId, type: reactions.type })
      .from(reactions)
      .where(eq(reactions.postId, postId));
  }

  describe(suite, () => {
    it(toggleCase, async () => {
      const { authorId, likerId, controlId, postId } = await seedPost();
      expect(await like(postId, likerId)).toBe(200);
      expect(await detailCount(postId, authorId)).toBe(1);

      expect(await like(postId, likerId)).toBe(400);
      expect(await detailCount(postId, authorId)).toBe(1);
      expect(await postReactions(postId)).toEqual([
        { userId: likerId, type: 'like' },
      ]);

      expect(await like(postId, controlId)).toBe(200);
      expect(await detailCount(postId, authorId)).toBe(2);
      expect(await like(postId, likerId, 'DELETE')).toBe(200);
      expect(await detailCount(postId, authorId)).toBe(1);
      expect(await like(postId, likerId)).toBe(200);
      expect(await detailCount(postId, authorId)).toBe(2);
    });

    it(deletionCase, async () => {
      const { authorId, likerId, controlId, postId } = await seedPost();
      expect(await like(postId, likerId)).toBe(200);
      expect(await like(postId, controlId)).toBe(200);
      const before = await detailCount(postId, authorId);
      expect(before).toBe(2);

      const response = await deleteAccountPOST(
        request('/api/users/delete-account', likerId, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
        })
      );
      expect(response.status).toBe(200);

      const [gone] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, likerId));
      expect(gone).toBeUndefined();

      const detail = await detailCount(postId, authorId);
      const interactions = await interactionsCount(postId, authorId);
      const remaining = await postReactions(postId);
      console.info('DELETE_ACCOUNT_REACTION_COUNTS', {
        postId,
        deletionStatus: response.status,
        before,
        detail,
        interactions,
        remaining: remaining.length,
      });
      expect(detail).toBe(1);
      expect(interactions).toBe(1);
      expect(remaining).toEqual([{ userId: controlId, type: 'like' }]);
    });
  });
} else {
  it('runs the like and deletion cases on a verified disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'post-like-count-deleted-account',
      file: 'packages/testing/integration/post-like-count-deleted-account.integration.test.ts',
      cases: [`${suite} > ${toggleCase}`, `${suite} > ${deletionCase}`],
    });
  }, 300_000);
}
