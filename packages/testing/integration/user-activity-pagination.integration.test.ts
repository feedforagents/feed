/**
 * PRD §§6.6/12, MVP Phase 5(6): the existing owner-only activity window
 * preserves displayable social/trade history and truthful hasMore metadata.
 * This does not add the planned via-agent filter or new points incentives.
 * Native cases use real PostgreSQL/authentication and only stub server-only's
 * marker. The separate HTTP case uses the actual server and signed JWTs;
 * production mode and disabled shortcut flags need independent runtime proof.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  comments,
  db,
  eq,
  inArray,
  pointsTransactions,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const activitySchema = z.object({
  userId: z.string(),
  activities: z.array(
    z.object({
      type: z.enum(['trade', 'points', 'post', 'comment']),
      id: z.string(),
      timestamp: z.string(),
    })
  ),
  pagination: z.object({
    limit: z.number().int(),
    count: z.number().int(),
    hasMore: z.boolean(),
  }),
});
function ownership() {
  return {
    users: new Set<string>(),
    points: new Set<string>(),
    balance: new Set<string>(),
    posts: new Set<string>(),
    comments: new Set<string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
const tokens = new Map<string, string>();
let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/activity/route').GET;
const base = Date.now();
const minutesAgo = (minutes: number) => new Date(base - minutes * 60_000);

async function fixtureUser(
  tag: string,
  receipts = owned,
  requestedId?: string
): Promise<string> {
  const id = requestedId ?? (await generateSnowflakeId());
  const stewardId = `activity-${tag}-${id}`;
  for (const row of await db
    .insert(users)
    .values({
      id,
      username: `g23${tag}-${id}`,
      displayName: `Activity Fixture ${tag}`,
      stewardId,
      isTest: true,
      updatedAt: new Date(),
    })
    .returning({ id: users.id }))
    receipts.users.add(row.id);
  // Ownership is registered before signing or any later setup await.
  tokens.set(id, await createStewardTestToken(stewardId));
  return id;
}
function auth(userId: string): Record<string, string> {
  const token = tokens.get(userId);
  if (!token) throw new Error('Missing owned activity token');
  return { authorization: `Bearer ${token}` };
}
async function native(userId: string, query: string, headers = auth(userId)) {
  return GET(
    new NextRequest(`http://localhost/api/users/${userId}/activity?${query}`, {
      headers,
    }),
    { params: Promise.resolve({ userId }) }
  );
}
async function activity(userId: string, query: string) {
  const response = await native(userId, query);
  expect(response.status).toBe(200);
  const body = activitySchema.parse(await response.json());
  expect(body.userId).toBe(userId);
  expect(body.pagination.count).toBe(body.activities.length);
  return body;
}
async function pointsRow(
  userId: string,
  reason: string,
  minutes: number,
  amount = 5
) {
  const id = await generateSnowflakeId();
  for (const row of await db
    .insert(pointsTransactions)
    .values({
      id,
      userId,
      amount,
      pointsBefore: 1000,
      pointsAfter: 1000 + amount,
      reason,
      createdAt: minutesAgo(minutes),
    })
    .returning({ id: pointsTransactions.id }))
    owned.points.add(row.id);
  return id;
}
async function balanceRow(userId: string, type: string, minutes: number) {
  const id = await generateSnowflakeId();
  for (const row of await db
    .insert(balanceTransactions)
    .values({
      id,
      userId,
      type,
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '110.00',
      createdAt: minutesAgo(minutes),
    })
    .returning({ id: balanceTransactions.id }))
    owned.balance.add(row.id);
  return id;
}
async function postRow(userId: string, minutes: number) {
  const id = await generateSnowflakeId();
  for (const row of await db
    .insert(posts)
    .values({
      id,
      authorId: userId,
      content: `activity fixture post ${id}`,
      timestamp: minutesAgo(minutes),
      createdAt: minutesAgo(minutes),
    })
    .returning({ id: posts.id }))
    owned.posts.add(row.id);
  return id;
}
async function commentRow(userId: string, postId: string, minutes: number) {
  const id = await generateSnowflakeId();
  for (const row of await db
    .insert(comments)
    .values({
      id,
      authorId: userId,
      postId,
      content: `activity fixture comment ${id}`,
      createdAt: minutesAgo(minutes),
      updatedAt: minutesAgo(minutes),
    })
    .returning({ id: comments.id }))
    owned.comments.add(row.id);
  return id;
}

async function cleanup(receipts: Ownership) {
  const failures: Error[] = [];
  // Child rows are attempted before parents; one failed table must not stop
  // other exact-owned deletes. Failed identities remain available for retry.
  const actions = [
    async () => {
      if (!receipts.comments.size) return;
      for (const row of await db
        .delete(comments)
        .where(inArray(comments.id, [...receipts.comments]))
        .returning({ id: comments.id }))
        receipts.comments.delete(row.id);
    },
    async () => {
      if (!receipts.points.size) return;
      for (const row of await db
        .delete(pointsTransactions)
        .where(inArray(pointsTransactions.id, [...receipts.points]))
        .returning({ id: pointsTransactions.id }))
        receipts.points.delete(row.id);
    },
    async () => {
      if (!receipts.balance.size) return;
      for (const row of await db
        .delete(balanceTransactions)
        .where(inArray(balanceTransactions.id, [...receipts.balance]))
        .returning({ id: balanceTransactions.id }))
        receipts.balance.delete(row.id);
    },
    async () => {
      if (!receipts.posts.size) return;
      for (const row of await db
        .delete(posts)
        .where(inArray(posts.id, [...receipts.posts]))
        .returning({ id: posts.id }))
        receipts.posts.delete(row.id);
    },
    async () => {
      if (!receipts.users.size) return;
      for (const row of await db
        .delete(users)
        .where(inArray(users.id, [...receipts.users]))
        .returning({ id: users.id }))
        receipts.users.delete(row.id);
    },
  ];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (Object.values(receipts).some((ids) => ids.size))
    failures.push(new Error('Owned activity identities remain after cleanup'));
  if (failures.length)
    throw new AggregateError(failures, 'Owned activity fixture cleanup failed');
}

let pnlUser: string;
let manyPointsUser: string;
let tradeUser: string;
let postUser: string;
let commentUser: string;
let smallUser: string;
let emptyUser: string;
let exactUser: string;
let mixedUser: string;
let hostUser: string;
const expected = {
  points: [] as string[],
  manyPoints: [] as string[],
  trade: [] as string[],
  post: [] as string[],
  comment: [] as string[],
  small: [] as string[],
  exact: [] as string[],
  mixed: [] as Array<
    Pick<z.infer<typeof activitySchema>['activities'][number], 'type' | 'id'>
  >,
};

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/activity/route'
  ));
  pnlUser = await fixtureUser('pnl');
  for (let i = 1; i <= 5; i++) await pointsRow(pnlUser, 'trading_pnl', i);
  for (let i = 6; i <= 10; i++)
    expected.points.push(await pointsRow(pnlUser, 'achievement_unlock', i));
  manyPointsUser = await fixtureUser('many');
  for (let i = 1; i <= 7; i++)
    expected.manyPoints.push(
      await pointsRow(manyPointsUser, 'achievement_unlock', i)
    );
  tradeUser = await fixtureUser('trade');
  for (let i = 1; i <= 10; i++) await balanceRow(tradeUser, 'deposit', i);
  for (let i = 11; i <= 16; i++)
    expected.trade.push(await balanceRow(tradeUser, 'pred_buy', i));
  postUser = await fixtureUser('post');
  for (let i = 1; i <= 7; i++) expected.post.push(await postRow(postUser, i));
  smallUser = await fixtureUser('small');
  for (let i = 1; i <= 3; i++)
    expected.small.push(await pointsRow(smallUser, 'achievement_unlock', i));
  emptyUser = await fixtureUser('empty');
  exactUser = await fixtureUser('exact');
  for (let i = 1; i <= 5; i++) expected.exact.push(await postRow(exactUser, i));
  hostUser = await fixtureUser('host');
  const parentId = await postRow(hostUser, 20);
  commentUser = await fixtureUser('comment');
  for (let i = 1; i <= 7; i++)
    expected.comment.push(await commentRow(commentUser, parentId, i));
  mixedUser = await fixtureUser('mixed');
  // Each source contributes TWO (<5), while their union contributes EIGHT.
  // Distinct timestamps make the combined top-five sequence explicit.
  for (let i = 1; i <= 8; i++) {
    const type = (['post', 'comment', 'trade', 'points'] as const)[(i - 1) % 4];
    if (!type) throw new Error('Missing mixed activity fixture source');
    let id: string;
    if (type === 'post') id = await postRow(mixedUser, i);
    else if (type === 'comment') id = await commentRow(mixedUser, parentId, i);
    else if (type === 'trade') id = await balanceRow(mixedUser, 'pred_buy', i);
    else id = await pointsRow(mixedUser, 'achievement_unlock', i);
    expected.mixed.push({ type, id });
  }
});

afterAll(async () => cleanup(owned));

function ids(body: z.infer<typeof activitySchema>) {
  return body.activities.map((row) => row.id);
}
describe('user activity feed pagination windows', () => {
  it('points exclusions precede the exact-N window', async () => {
    const body = await activity(pnlUser, 'type=points&limit=5');
    expect(ids(body)).toEqual(expected.points);
    expect(body.activities.every((row) => row.type === 'points')).toBe(true);
    expect(body.pagination).toEqual({ limit: 5, count: 5, hasMore: false });
  });
  it('points lookahead reports more displayable activity', async () => {
    const body = await activity(manyPointsUser, 'type=points&limit=5');
    expect(ids(body)).toEqual(expected.manyPoints.slice(0, 5));
    expect(body.pagination).toEqual({ limit: 5, count: 5, hasMore: true });
  });
  it('trade exclusions precede the lookahead window', async () => {
    const body = await activity(tradeUser, 'type=trade&limit=5');
    expect(ids(body)).toEqual(expected.trade.slice(0, 5));
    expect(body.activities.every((row) => row.type === 'trade')).toBe(true);
    expect(body.pagination).toEqual({ limit: 5, count: 5, hasMore: true });
  });
  for (const kind of ['post', 'comment'] as const) {
    it(`${kind} lookahead reports the exact newest five IDs`, async () => {
      const body = await activity(
        kind === 'post' ? postUser : commentUser,
        `type=${kind}&limit=5`
      );
      expect(ids(body)).toEqual(expected[kind].slice(0, 5));
      expect(body.activities.every((row) => row.type === kind)).toBe(true);
      expect(body.pagination).toEqual({ limit: 5, count: 5, hasMore: true });
    });
  }
  it('below-limit, empty and exact-N controls report no lookahead', async () => {
    for (const [userId, query, wanted] of [
      [smallUser, 'type=points&limit=5', expected.small],
      [emptyUser, 'type=all&limit=5', []],
      [exactUser, 'type=all&limit=5', expected.exact],
    ] as const) {
      const body = await activity(userId, query);
      expect(ids(body)).toEqual([...wanted]);
      expect(body.pagination).toEqual({
        limit: 5,
        count: wanted.length,
        hasMore: false,
      });
    }
  });
  it('all-source union has lookahead even when each source has fewer than N rows', async () => {
    expect(expected.mixed).toHaveLength(8);
    for (const type of ['post', 'comment', 'trade', 'points']) {
      const body = await activity(mixedUser, `type=${type}&limit=5`);
      expect(ids(body)).toEqual(
        expected.mixed.filter((row) => row.type === type).map((row) => row.id)
      );
      expect(body.pagination).toEqual({ limit: 5, count: 2, hasMore: false });
    }
    const body = await activity(mixedUser, 'type=all&limit=5');
    expect(body.activities.map(({ type, id }) => ({ type, id }))).toEqual(
      expected.mixed.slice(0, 5)
    );
    expect(body.pagination).toEqual({ limit: 5, count: 5, hasMore: true });
  });
  it('native real authentication returns exact missing/invalid401, other-owner403 and owner200', async () => {
    expect((await native(emptyUser, 'limit=5', {})).status).toBe(401);
    expect(
      (
        await native(emptyUser, 'limit=5', {
          authorization: 'Bearer invalid-token',
        })
      ).status
    ).toBe(401);
    expect((await native(emptyUser, 'limit=5', auth(hostUser))).status).toBe(
      403
    );
    expect((await native(emptyUser, 'limit=5')).status).toBe(200);
  });
  it('actual HTTP accepts signed owner JWT and rejects missing/invalid/foreign credentials', async () => {
    const baseUrl = new URL(
      process.env.TEST_API_URL ||
        process.env.TEST_BASE_URL ||
        'http://127.0.0.1:3100'
    );
    if (
      baseUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(baseUrl.hostname) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== '/' ||
      baseUrl.search ||
      baseUrl.hash
    )
      throw new Error('Owned loopback activity server required');
    const url = new URL(
      `/api/users/${emptyUser}/activity?type=all&limit=5`,
      baseUrl
    );
    const request = (headers: Record<string, string>) =>
      fetch(url, {
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
    expect((await request({})).status).toBe(401);
    expect(
      (await request({ authorization: 'Bearer invalid-token' })).status
    ).toBe(401);
    expect((await request(auth(hostUser))).status).toBe(403);
    const response = await request(auth(emptyUser));
    expect(response.status).toBe(200);
    const body = activitySchema.parse(await response.json());
    expect(body.userId).toBe(emptyUser);
    expect(body.activities).toEqual([]);
    expect(body.pagination).toEqual({ limit: 5, count: 0, hasMore: false });
  });
  it('real partial setup collision cannot grant ownership of an independent control', async () => {
    const partial = ownership();
    const control = ownership();
    let survivor: string | undefined;
    try {
      survivor = await fixtureUser('survivor', control);
      const [before] = await db
        .select()
        .from(users)
        .where(eq(users.id, survivor));
      expect(before?.id).toBe(survivor);
      const inserted = await fixtureUser('partial', partial);
      await expect(
        fixtureUser('collision', partial, survivor)
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect([...partial.users]).toEqual([inserted]);
      await cleanup(partial);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, inserted))
      ).toEqual([]);
      const [after] = await db
        .select()
        .from(users)
        .where(eq(users.id, survivor));
      expect(after).toEqual(before);
      await cleanup(partial); // Retry of successful cleanup is harmless.
    } finally {
      const results = await Promise.allSettled([
        cleanup(partial),
        cleanup(control),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            ]
          : []
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          'Partial activity fixture cleanup failed'
        );
    }
  });
});
