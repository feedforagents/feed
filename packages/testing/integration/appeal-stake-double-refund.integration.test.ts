/**
 * POST /api/moderation/appeal against a real database: a staked appeal that
 * the lenient review approves must refund the escrow stake exactly once, even
 * when the same banned user sends several appeals at the same time.
 *
 * The route read `appealStaked`, credited the refund, and only afterwards
 * cleared `appealStaked`, with no transaction or row lock. The reviewer call
 * keeps that window open, so every parallel request passed the `isBanned`
 * check and credited another stake.
 *
 * Stubs: `server-only`, `authenticate` (returns the fixture user) and
 * `callClaudeDirect` (always approves, after a short delay that models the
 * model call). Database, wallet and route code run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { balanceTransactions, db, eq, notifications, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const STAKE = 10;
const PARALLEL = 5;

let userId: string;
let ownsUser = false;
let POST: typeof import('../../../apps/web/src/app/api/moderation/appeal/route').POST;

beforeAll(async () => {
  userId = await generateSnowflakeId();
  const actualApi = await import('@feed/api');
  mock.module('@feed/api', () => ({
    ...actualApi,
    authenticate: async () => ({ userId, dbUserId: userId }),
    callClaudeDirect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return '{"shouldDeny": false, "reasoning": "benefit of the doubt"}';
    },
  }));
  ({ POST } = await import(
    '../../../apps/web/src/app/api/moderation/appeal/route'
  ));

  await db.insert(users).values({
    id: userId,
    username: `test-appeal-refund-${userId}`,
    displayName: 'Appeal Refund Fixture',
    updatedAt: new Date(),
    virtualBalance: '0',
    isBanned: true,
    bannedAt: new Date(),
    bannedReason: 'fixture',
    appealCount: 1,
    appealStatus: 'denied',
    appealStaked: true,
    appealStakeAmount: String(STAKE),
    appealStakeTxHash: `0x${'b'.repeat(64)}`,
  });
  ownsUser = true;
});

afterAll(async () => {
  if (!ownsUser) return;
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('POST /api/moderation/appeal stake refund', () => {
  it('refunds the stake once when the same appeal is sent in parallel', async () => {
    const send = () =>
      POST(
        new NextRequest(
          new Request('http://localhost/api/moderation/appeal', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reason: 'This ban was a mistake, please review',
            }),
          })
        )
      ) as Promise<Response>;

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () => send())
    );
    const statuses = responses.map((response) => response.status);
    console.log('statuses', JSON.stringify(statuses));

    const [row] = await db
      .select({
        virtualBalance: users.virtualBalance,
        isBanned: users.isBanned,
        appealStaked: users.appealStaked,
      })
      .from(users)
      .where(eq(users.id, userId));
    const refunds = (
      await db
        .select({ id: balanceTransactions.id })
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId))
    ).length;
    console.log('balance', row?.virtualBalance, 'refund rows', refunds);

    expect(refunds).toBe(1);
    expect(Number(row?.virtualBalance)).toBe(STAKE);
    expect(row?.isBanned).toBe(false);
    expect(row?.appealStaked).toBe(false);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  });
});
