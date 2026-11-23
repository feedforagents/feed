/**
 * POST /api/moderation/appeal against a real database: a banned user who
 * already used the free appeal must be able to submit a staked second appeal
 * with a paid moderation escrow payment.
 *
 * The escrow lookup loaded a `User` relation that does not exist in the
 * Drizzle schema (relations are `recipient` / `admin` / `refundedByUser`),
 * so Drizzle throws while building the query and the route answers 500 for
 * every staked appeal. The included user fields are never read by the route,
 * so the lookup must not request them.
 *
 * Stubs: `server-only`, `authenticate` (returns the fixture user) and
 * `callClaudeDirect` (always approves, after a short delay that models the
 * model call; counts invocations). Database, wallet and route code run for
 * real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  balanceTransactions,
  db,
  eq,
  moderationEscrows,
  notifications,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const STAKE = 10;
const ESCROW_HASH = `0x${'c'.repeat(64)}`;

let userId: string;
let escrowId: string;
let evalCalls = 0;
let ownsFixture = false;
let POST: typeof import('../../../apps/web/src/app/api/moderation/appeal/route').POST;

beforeAll(async () => {
  userId = await generateSnowflakeId();
  escrowId = await generateSnowflakeId();
  const actualApi = await import('@feed/api');
  mock.module('@feed/api', () => ({
    ...actualApi,
    authenticate: async () => ({ userId, dbUserId: userId }),
    callClaudeDirect: async () => {
      evalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return '{"shouldDeny": false, "reasoning": "benefit of the doubt"}';
    },
  }));
  ({ POST } = await import(
    '../../../apps/web/src/app/api/moderation/appeal/route'
  ));

  await db.insert(users).values({
    id: userId,
    username: `test-appeal-escrow-${userId}`,
    displayName: 'Appeal Escrow Fixture',
    updatedAt: new Date(),
    virtualBalance: '0',
    isBanned: true,
    bannedAt: new Date(),
    bannedReason: 'fixture',
    appealCount: 1,
    appealStatus: 'denied',
    appealStaked: false,
  });
  await db.insert(moderationEscrows).values({
    id: escrowId,
    recipientId: userId,
    adminId: userId,
    amountUSD: String(STAKE),
    amountWei: '10000000',
    status: 'paid',
    paymentRequestId: `pr-escrow-stake-${escrowId}`,
    paymentTxHash: ESCROW_HASH,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  ownsFixture = true;
});

afterAll(async () => {
  if (!ownsFixture) return;
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(moderationEscrows).where(eq(moderationEscrows.id, escrowId));
  await db.delete(users).where(eq(users.id, userId));
});

describe('POST /api/moderation/appeal staked escrow appeal', () => {
  it('accepts a paid escrow stake instead of failing with 500', async () => {
    const response = (await POST(
      new NextRequest(
        new Request('http://localhost/api/moderation/appeal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reason: 'This ban was a mistake, please review',
            stakeTxHash: ESCROW_HASH,
          }),
        })
      )
    )) as Response;
    const body = (await response.json()) as {
      success?: boolean;
      status?: string;
      error?: string;
    };
    console.log('status', response.status, 'body', JSON.stringify(body));
    console.log('lenient eval calls', evalCalls);

    const [row] = await db
      .select({
        virtualBalance: users.virtualBalance,
        isBanned: users.isBanned,
        appealStaked: users.appealStaked,
        appealStakeTxHash: users.appealStakeTxHash,
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

    expect(response.status).toBe(200);
    expect(body.status).toBe('approved');
    expect(evalCalls).toBe(1);
    expect(refunds).toBe(1);
    expect(Number(row?.virtualBalance)).toBe(STAKE);
    expect(row?.isBanned).toBe(false);
    expect(row?.appealStaked).toBe(false);
    expect(row?.appealStakeTxHash).toBe(ESCROW_HASH);
  });
});
