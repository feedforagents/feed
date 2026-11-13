/**
 * Integration tests for GET /api/users/[userId]/activity — trades section.
 *
 * The trades section reads the user's balance ledger (BalanceTransaction)
 * and is supposed to return their recent trade events. Perp adds, partial
 * closes and flips write ledger rows of their own types
 * (perp_add_to_position, perp_partial_close, perp_flip_position) — the
 * section must not drop those trade events.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { balanceTransactions, comments, db, eq, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_ACT: typeof import('../../../apps/web/src/app/api/users/[userId]/activity/route').GET;

let userT: string; // one ledger row per trade event type
let userF: string; // guard target (another user's trades)
let userM: string; // 60 trades interleaved with 60 non-trade rows
let userP: string; // posts/comments guard

const base = new Date(Date.now() - 30 * 24 * 60 * 60_000);
const at = (min: number) => new Date(base.getTime() + min * 60_000);

async function bal(
  userId: string,
  type: string,
  min: number,
  relatedId: string | null = null
) {
  await db.insert(balanceTransactions).values({
    id: await generateSnowflakeId(),
    userId,
    type,
    amount: '10.00',
    balanceBefore: '100.00',
    balanceAfter: '110.00',
    relatedId,
    description: `test ${type}`,
    createdAt: at(min),
  });
}

async function call(asUser: string, url: string, target: string) {
  const request = new NextRequest(new Request(url), {
    headers: { authorization: `Bearer steward:test:${asUser}` },
  });
  const response = await (GET_ACT as Function)(request, {
    params: Promise.resolve({ userId: target }),
  });
  return { status: response.status, body: await response.json() };
}

const tradeTypesOf = (body: { activities?: unknown[] }) =>
  (body.activities ?? [])
    .filter((a) => (a as { type: string }).type === 'trade')
    .map((a) => (a as { data: { tradeType: string } }).data.tradeType);

beforeAll(async () => {
  ({ GET: GET_ACT } = await import(
    '../../../apps/web/src/app/api/users/[userId]/activity/route'
  ));

  userT = await generateSnowflakeId();
  userF = await generateSnowflakeId();
  userM = await generateSnowflakeId();
  userP = await generateSnowflakeId();
  const now = new Date();
  await db.insert(users).values([
    { id: userT, username: `f30t-${userT}`, displayName: 'T', updatedAt: now },
    { id: userF, username: `f30f-${userF}`, displayName: 'F', updatedAt: now },
    { id: userM, username: `f30m-${userM}`, displayName: 'M', updatedAt: now },
    { id: userP, username: `f30p-${userP}`, displayName: 'P', updatedAt: now },
  ]);

  // T: one of each trade event type the market services write
  await bal(userT, 'pred_buy', 1, 'mkt-1');
  await bal(userT, 'pred_sell', 2, 'mkt-1');
  await bal(userT, 'perp_open', 3, 'pos-1');
  await bal(userT, 'perp_add_to_position', 4, 'pos-1');
  await bal(userT, 'perp_partial_close', 5, 'pos-1');
  await bal(userT, 'perp_flip_position', 6, 'pos-1');
  await bal(userT, 'perp_close', 7, 'pos-1');
  await bal(userT, 'perp_liquidation', 8, 'pos-2');

  // F: a few trades (target of the cross-user guard below)
  for (let k = 1; k <= 10; k++) await bal(userF, 'pred_sell', k, 'mkt-9');

  // M: 60 trades, each followed by a non-trade row (deposit)
  for (let k = 1; k <= 60; k++) {
    await bal(userM, 'perp_open', k * 2, 'pos-m');
    await bal(userM, 'deposit', k * 2 + 1);
  }

  // P: one post, one comment (untouched-sections guard)
  const pid = await generateSnowflakeId();
  await db.insert(posts).values({
    id: pid,
    authorId: userP,
    content: 'guard post',
    timestamp: at(1),
    createdAt: at(1),
  });
  await db.insert(comments).values({
    id: await generateSnowflakeId(),
    postId: pid,
    authorId: userP,
    content: 'guard comment',
    createdAt: at(2),
    updatedAt: at(2),
  });
});

afterAll(async () => {
  for (const id of [userT, userF, userM, userP]) {
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, id));
    await db.delete(comments).where(eq(comments.authorId, id));
    await db.delete(posts).where(eq(posts.authorId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe('activity trades section', () => {
  it('returns every trade event type the market services write', async () => {
    const res = await call(
      userT,
      `http://localhost/api/users/${userT}/activity?type=trade&limit=50`,
      userT
    );
    expect(res.status).toBe(200);
    expect(tradeTypesOf(res.body).sort()).toEqual(
      [
        'perp_add_to_position',
        'perp_close',
        'perp_flip_position',
        'perp_liquidation',
        'perp_open',
        'perp_partial_close',
        'pred_buy',
        'pred_sell',
      ].sort()
    );
  });

  it('returns a full page of the newest trades despite interleaved non-trade rows', async () => {
    const res = await call(
      userM,
      `http://localhost/api/users/${userM}/activity?type=trade&limit=50`,
      userM
    );
    expect(res.status).toBe(200);
    const types = tradeTypesOf(res.body);
    expect(types).toHaveLength(50);
    expect(types.every((t) => t === 'perp_open')).toBe(true);
  });

  it('includes perp adds and flips in the merged all-types feed', async () => {
    const res = await call(
      userT,
      `http://localhost/api/users/${userT}/activity?type=all&limit=50`,
      userT
    );
    expect(res.status).toBe(200);
    const types = tradeTypesOf(res.body);
    expect(types).toContain('perp_add_to_position');
    expect(types).toContain('perp_flip_position');
    expect(types).toContain('perp_partial_close');
  });

  it('keeps the other sections working and other users out', async () => {
    const rp = await call(
      userP,
      `http://localhost/api/users/${userP}/activity?type=post&limit=50`,
      userP
    );
    expect(rp.status).toBe(200);
    expect(
      (rp.body.activities ?? []).filter(
        (a: { type: string }) => a.type === 'post'
      )
    ).toHaveLength(1);

    const rc = await call(
      userP,
      `http://localhost/api/users/${userP}/activity?type=comment&limit=50`,
      userP
    );
    expect(rc.status).toBe(200);
    expect(
      (rc.body.activities ?? []).filter(
        (a: { type: string }) => a.type === 'comment'
      )
    ).toHaveLength(1);

    const guard = await call(
      userT,
      `http://localhost/api/users/${userF}/activity?type=trade&limit=50`,
      userF
    );
    expect(guard.status).not.toBe(200);
  });
});
