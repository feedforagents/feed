/**
 * Repro: a dispute after a partial refund.
 *
 * User path (all real service calls, no mocks):
 * 1. User funds $100 via Stripe (PI-1) -> balance 10,000 units.
 * 2. User tops up another $100 via Stripe (PI-2) -> balance 20,000 units,
 *    so the later dispute deduction is not masked by the balance clamp.
 * 3. User gets a $40 partial refund on PI-1 -> balance 16,000, totalWithdrawn
 *    4,000. The refund handler already nets prior refunds for the same
 *    payment intent (cumulative accounting).
 * 4. User's bank disputes PI-1. The dispute handler passes the ACTUAL
 *    dispute amount (Stripe: "The disputed amount might be the full amount
 *    of the charge or a different amount"), so the dispute can be:
 *    (a) the FULL $100, (b) only the $60 unrefunded remainder, or
 *    (c) a $20 slice of the remainder.
 *
 * Correct end state in all three cases: refund + dispute together lose at
 * most the $100 charge (invariant: totalWithdrawn <= charge amount).
 * (a) $100 dispute -> $60 deducted (totalWithdrawn 10,000, balance 10,000).
 * (b) $60 dispute -> $60 deducted (totalWithdrawn 10,000, balance 10,000).
 * (c) $20 dispute -> $20 deducted (totalWithdrawn 6,000, balance 14,000).
 *
 * What each version does:
 * - Base (no netting): (a) deducts $100 (totalWithdrawn 14,000 — the $40
 *   refunded portion is deducted twice, and the 'lost' close path never
 *   returns it, so the loss is permanent); (b) and (c) deduct the dispute
 *   amount in full, which happens to be right.
 * - Previous fix (a8e225f6, `dispute amount - prior refunds`): (a) is
 *   right ($60), but (b) deducts only $20 and (c) deducts $0 — it
 *   under-deducts whenever the dispute is for less than the full charge.
 * - This fix (min(dispute amount, charge - prior refunds)): all three
 *   right. The new cases (b) and (c) are regression tests against the
 *   previous fix's formula, not base-vs-fix discriminators.
 *
 * Run: DISABLE_RATE_LIMITING=true DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f3r2 TZ=UTC bun test integration/dispute-after-partial-refund.integration.test.ts --preload ./integration/preload.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { TradingBalanceFundingService } from '@feed/api';
import { balanceTransactions, dbWrite, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const TEST_USER_PREFIX = 'f3-dispute-refund-';
const testUserIds: string[] = [];

async function getUserLedger(userId: string): Promise<{
  virtualBalance: number;
  totalDeposited: number;
  totalWithdrawn: number;
}> {
  const [user] = await dbWrite
    .select({
      virtualBalance: users.virtualBalance,
      totalDeposited: users.totalDeposited,
      totalWithdrawn: users.totalWithdrawn,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    virtualBalance: Number(user?.virtualBalance ?? 0),
    totalDeposited: Number(user?.totalDeposited ?? 0),
    totalWithdrawn: Number(user?.totalWithdrawn ?? 0),
  };
}

/** Fund $100 (PI-1) + $100 top-up (PI-2), then a $40 partial refund on PI-1. */
async function preparePartialRefundCase(): Promise<{
  userId: string;
  paymentIntentId: string;
  stamp: string;
}> {
  const userId = `${TEST_USER_PREFIX}${await generateSnowflakeId()}`;
  testUserIds.push(userId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `f3_${userId.slice(-8)}`,
    profileComplete: true,
    virtualBalance: '0',
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 0,
    invitePoints: 0,
    earnedPoints: 0,
    bonusPoints: 0,
    isActor: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
  const paymentIntentId = `pi_f3_${stamp}`;

  // 1. Fund $100 via Stripe (PI-1) -> 10,000 units.
  const funded1 = await TradingBalanceFundingService.fundPurchase(
    userId,
    100,
    `cs_f3_${stamp}`,
    paymentIntentId,
    'stripe'
  );
  expect(funded1.success).toBe(true);

  // 2. Top up another $100 (PI-2) so the dispute deduction is not
  // clamped by the balance floor.
  const funded2 = await TradingBalanceFundingService.fundPurchase(
    userId,
    100,
    `cs_f3_topup_${stamp}`,
    `pi_f3_topup_${stamp}`,
    'stripe'
  );
  expect(funded2.success).toBe(true);
  expect((await getUserLedger(userId)).virtualBalance).toBe(20000);

  // 3. Partial refund of $40 on PI-1.
  const refunded = await TradingBalanceFundingService.reversePurchaseFunding(
    userId,
    paymentIntentId,
    'refund',
    40,
    `evt_f3_refund_${stamp}`
  );
  expect(refunded.success).toBe(true);
  expect(refunded.balanceDelta).toBe(-4000);
  const ledger = await getUserLedger(userId);
  expect(ledger.virtualBalance).toBe(16000);
  expect(ledger.totalWithdrawn).toBe(4000);

  return { userId, paymentIntentId, stamp };
}

describe('dispute after a partial refund', () => {
  it('deducts only the not-yet-refunded portion of the charge', async () => {
    const { userId, paymentIntentId, stamp } = await preparePartialRefundCase();

    // Full-amount dispute of $100 on the same PI-1.
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_f3_dispute_${stamp}`
    );
    expect(disputed.success).toBe(true);
    const ledger = await getUserLedger(userId);
    console.log(
      '[f3 repro] after full-amount dispute:',
      ledger,
      'disputeDelta:',
      disputed.balanceDelta
    );

    // One $100 charge can lose at most $100 across refund + dispute:
    // $40 already refunded + $60 still disputed.
    expect(ledger.totalWithdrawn).toBe(10000);
    expect(ledger.virtualBalance).toBe(10000);
    expect(disputed.balanceDelta).toBe(-6000);
  });

  it('deducts the full remainder when the dispute covers only the unrefunded balance', async () => {
    const { userId, paymentIntentId, stamp } = await preparePartialRefundCase();

    // Dispute of only the $60 remainder (Stripe allows a dispute for a
    // different amount than the full charge).
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      60,
      `evt_f3_dispute_${stamp}`
    );
    expect(disputed.success).toBe(true);
    const ledger = await getUserLedger(userId);
    console.log(
      '[f3 repro] after remainder-only dispute:',
      ledger,
      'disputeDelta:',
      disputed.balanceDelta
    );

    // $40 refunded + $60 disputed = the full $100 charge, nothing more.
    expect(ledger.totalWithdrawn).toBe(10000);
    expect(ledger.virtualBalance).toBe(10000);
    expect(disputed.balanceDelta).toBe(-6000);
  });

  it('deducts only the disputed slice when the dispute is smaller than the remainder', async () => {
    const { userId, paymentIntentId, stamp } = await preparePartialRefundCase();

    // Partial dispute of $20 out of the $60 remainder.
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      20,
      `evt_f3_dispute_${stamp}`
    );
    expect(disputed.success).toBe(true);
    const ledger = await getUserLedger(userId);
    console.log(
      '[f3 repro] after partial dispute:',
      ledger,
      'disputeDelta:',
      disputed.balanceDelta
    );

    // $40 refunded + $20 disputed = $60 total loss, under the $100 charge.
    expect(ledger.totalWithdrawn).toBe(6000);
    expect(ledger.virtualBalance).toBe(14000);
    expect(disputed.balanceDelta).toBe(-2000);
  });

  afterAll(async () => {
    for (const userId of testUserIds) {
      await dbWrite
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      await dbWrite.delete(users).where(eq(users.id, userId));
    }
  });
});
