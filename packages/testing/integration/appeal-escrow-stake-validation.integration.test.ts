/**
 * POST /api/moderation/appeal against a real database: escrow stakes that
 * must be rejected with 400 and no state change.
 *
 * The happy path (a paid $10 escrow) is covered by
 * appeal-escrow-stake.integration.test.ts. These cases pin the validation
 * branch against a real query, so a mutation that drops one check fails:
 *
 * - an escrow below the $10 minimum (the A2A handler enforces it; the web
 *   route did not, so a $1 escrow bought the lenient review)
 * - an escrow that belongs to someone else
 * - an escrow that is not paid yet
 * - an escrow that was already refunded
 * - an escrow already used for an appeal by another user
 *
 * Stubs: `server-only`, `authenticate` (returns the fixture user of the
 * running case) and `callClaudeDirect` (counts invocations; must stay 0).
 * Database, wallet and route code run for real.
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

const REASON = 'This ban was a mistake, please review';

let currentUserId = '';
let evalCalls = 0;
let POST: typeof import('../../../apps/web/src/app/api/moderation/appeal/route').POST;

const fixtureUserIds: string[] = [];
const fixtureEscrowIds: string[] = [];

async function createBannedUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `test-appeal-validation-${id}`,
    displayName: 'Appeal Validation Fixture',
    updatedAt: new Date(),
    virtualBalance: '0',
    isBanned: true,
    bannedAt: new Date(),
    bannedReason: 'fixture',
    appealCount: 1,
    appealStatus: 'denied',
    appealStaked: false,
  });
  fixtureUserIds.push(id);
  return id;
}

async function createEscrow(args: {
  recipientId: string;
  amountUSD: string;
  status: string;
  paymentTxHash: string;
  refundTxHash?: string | null;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(moderationEscrows).values({
    id,
    recipientId: args.recipientId,
    adminId: args.recipientId,
    amountUSD: args.amountUSD,
    amountWei: '10000000',
    status: args.status,
    paymentRequestId: `pr-appeal-validation-${id}`,
    paymentTxHash: args.paymentTxHash,
    refundTxHash: args.refundTxHash ?? null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  fixtureEscrowIds.push(id);
  return id;
}

async function submitStake(stakeTxHash: string): Promise<{
  status: number;
  body: { success?: boolean; status?: string; error?: string };
}> {
  const response = (await POST(
    new NextRequest(
      new Request('http://localhost/api/moderation/appeal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: REASON, stakeTxHash }),
      })
    )
  )) as Response;
  const body = (await response.json()) as {
    success?: boolean;
    status?: string;
    error?: string;
  };
  console.log('status', response.status, 'body', JSON.stringify(body));
  return { status: response.status, body };
}

async function readState(userId: string): Promise<{
  virtualBalance: string | null;
  isBanned: boolean | null;
  appealCount: number | null;
  appealStaked: boolean | null;
  appealStakeTxHash: string | null;
  refunds: number;
}> {
  const [row] = await db
    .select({
      virtualBalance: users.virtualBalance,
      isBanned: users.isBanned,
      appealCount: users.appealCount,
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
  return {
    virtualBalance: row?.virtualBalance ?? null,
    isBanned: row?.isBanned ?? null,
    appealCount: row?.appealCount ?? null,
    appealStaked: row?.appealStaked ?? null,
    appealStakeTxHash: row?.appealStakeTxHash ?? null,
    refunds,
  };
}

function expectNoStateChange(state: Awaited<ReturnType<typeof readState>>) {
  expect(Number(state.virtualBalance)).toBe(0);
  expect(state.refunds).toBe(0);
  expect(state.isBanned).toBe(true);
  expect(state.appealCount).toBe(1);
  expect(state.appealStaked).toBe(false);
  expect(state.appealStakeTxHash).toBeNull();
  expect(evalCalls).toBe(0);
}

beforeAll(async () => {
  const actualApi = await import('@feed/api');
  mock.module('@feed/api', () => ({
    ...actualApi,
    authenticate: async () => ({
      userId: currentUserId,
      dbUserId: currentUserId,
    }),
    callClaudeDirect: async () => {
      evalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return '{"shouldDeny": false, "reasoning": "benefit of the doubt"}';
    },
  }));
  ({ POST } = await import(
    '../../../apps/web/src/app/api/moderation/appeal/route'
  ));
});

afterAll(async () => {
  for (const userId of fixtureUserIds) {
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await db.delete(notifications).where(eq(notifications.userId, userId));
  }
  for (const escrowId of fixtureEscrowIds) {
    await db
      .delete(moderationEscrows)
      .where(eq(moderationEscrows.id, escrowId));
  }
  for (const userId of fixtureUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('POST /api/moderation/appeal escrow stake validation', () => {
  it('rejects an escrow below the $10 minimum', async () => {
    const userId = await createBannedUser();
    const hash = `0x${'e'.repeat(64)}`;
    await createEscrow({
      recipientId: userId,
      amountUSD: '1',
      status: 'paid',
      paymentTxHash: hash,
    });
    currentUserId = userId;
    const { status, body } = await submitStake(hash);
    expect(status).toBe(400);
    expect(body.error).toBe('Appeal stake must be at least $10');
    expectNoStateChange(await readState(userId));
  });

  it('rejects an escrow that belongs to someone else', async () => {
    const userId = await createBannedUser();
    const otherId = await createBannedUser();
    const hash = `0x${'f'.repeat(64)}`;
    await createEscrow({
      recipientId: otherId,
      amountUSD: '10',
      status: 'paid',
      paymentTxHash: hash,
    });
    currentUserId = userId;
    const { status, body } = await submitStake(hash);
    expect(status).toBe(400);
    expect(body.error).toBe('Escrow payment does not belong to you');
    expectNoStateChange(await readState(userId));
  });

  it('rejects an escrow that is not paid', async () => {
    const userId = await createBannedUser();
    const hash = `0x${'a'.repeat(64)}`;
    await createEscrow({
      recipientId: userId,
      amountUSD: '10',
      status: 'pending',
      paymentTxHash: hash,
    });
    currentUserId = userId;
    const { status, body } = await submitStake(hash);
    expect(status).toBe(400);
    expect(body.error).toBe(
      "Escrow payment is pending, must be 'paid' to use for appeal"
    );
    expectNoStateChange(await readState(userId));
  });

  it('rejects an escrow that was already refunded', async () => {
    const userId = await createBannedUser();
    const hash = `0x${'b'.repeat(64)}`;
    await createEscrow({
      recipientId: userId,
      amountUSD: '10',
      status: 'paid',
      paymentTxHash: hash,
      refundTxHash: `0x${'1'.repeat(64)}`,
    });
    currentUserId = userId;
    const { status, body } = await submitStake(hash);
    expect(status).toBe(400);
    expect(body.error).toBe(
      'Escrow payment has been refunded and cannot be used for appeal'
    );
    expectNoStateChange(await readState(userId));
  });

  it('rejects an escrow already used for an appeal by another user', async () => {
    const userId = await createBannedUser();
    const otherId = await createBannedUser();
    const hash = `0x${'2'.repeat(64)}`;
    await db
      .update(users)
      .set({ appealStakeTxHash: hash })
      .where(eq(users.id, otherId));
    await createEscrow({
      recipientId: userId,
      amountUSD: '10',
      status: 'paid',
      paymentTxHash: hash,
    });
    currentUserId = userId;
    const { status, body } = await submitStake(hash);
    expect(status).toBe(400);
    expect(body.error).toBe(
      'This escrow payment has already been used for an appeal by another user'
    );
    expectNoStateChange(await readState(userId));
  });
});
