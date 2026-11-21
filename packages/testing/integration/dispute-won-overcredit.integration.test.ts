/**
 * Won-dispute re-credit: restore exactly what THIS dispute deducted.
 *
 * Single-dispute over-credit (partial refund, then a full-amount dispute,
 * then a win) is already owned by open PR #1959 (hermesagent270-commits,
 * head fd0334089): it clamps the win to the sum of all dispute deductions
 * for the payment intent. Cases 1–2 below reproduce that symptom and PASS
 * on #1959's head — they are the duplicate boundary, kept to prove the
 * boundary, not as the candidate.
 *
 * What #1959 does NOT cover — the candidate (case 5):
 * Two $100 disputes on one $100 payment (Stripe: a payment can receive
 * more than one dispute). The first takes 10,000 units, the second only
 * 6,000 — the balance floor clamps it. #1959 sums both deductions (16,000)
 * and re-credits min($100, 16,000) = 10,000 for the second win: 4,000
 * phantom units. The win must match the dispute's OWN deduction, not the
 * payment-intent sum. Case 4 (a second won notice for the same dispute
 * restores again) is the same identity gap on the replay axis: #1959 has
 * no restore-once guard beyond the same-event check.
 *
 * Basis: PRD §9.1 / MVP Phase 6 accounting consistency, as the maintainer
 * stated when closing #1624 (2026-11-17): "a credit must be backed by a
 * recorded deduction and that deduction must not be restored more than
 * once", and "Match the dispute identity as well as the payment intent".
 * #1624's own fix is not the reference either: it picked the latest
 * reversal for the payment intent, so winning the first of two disputes
 * ($20 then $10) restored $10 instead of $20 (case 3 guards against
 * repeating that error; it passes on base too).
 *
 * Run: DISABLE_RATE_LIMITING=true DATABASE_URL=<db> DIRECT_DATABASE_URL=<db> TZ=UTC bun test integration/dispute-won-overcredit.integration.test.ts --preload ./integration/preload.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { TradingBalanceFundingService } from '@feed/api';
import { balanceTransactions, dbWrite, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const TEST_USER_PREFIX = 'frev-dispute-won-';
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

async function createUser(): Promise<string> {
  const userId = `${TEST_USER_PREFIX}${await generateSnowflakeId()}`;
  testUserIds.push(userId);
  await dbWrite.insert(users).values({
    id: userId,
    username: `frev_${userId.slice(-8)}`,
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
  return userId;
}

async function fund(
  userId: string,
  amountUSD: number,
  stamp: string,
  tag: string
): Promise<string> {
  const paymentIntentId = `pi_frev_${tag}_${stamp}`;
  const funded = await TradingBalanceFundingService.fundPurchase(
    userId,
    amountUSD,
    `cs_frev_${tag}_${stamp}`,
    paymentIntentId,
    'stripe'
  );
  expect(funded.success).toBe(true);
  return paymentIntentId;
}

afterAll(async () => {
  for (const userId of testUserIds) {
    await dbWrite
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await dbWrite.delete(users).where(eq(users.id, userId));
  }
});

describe('won dispute re-credit', () => {
  it('re-credits only what the dispute actually deducted after a partial refund', async () => {
    const userId = await createUser();
    const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
    const paymentIntentId = await fund(userId, 100, stamp, 'a');

    // $40 partial refund -> balance 6,000, totalWithdrawn 4,000.
    const refunded = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'refund',
      40,
      `evt_frev_refund_${stamp}`
    );
    expect(refunded.success).toBe(true);
    expect(refunded.balanceDelta).toBe(-4000);

    // $100 dispute: only 6,000 can actually be deducted (balance floor).
    const disputeId = `dp_frev_${stamp}`;
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_frev_dispute_${stamp}`,
      disputeId
    );
    expect(disputed.success).toBe(true);
    expect(disputed.balanceDelta).toBe(-6000);
    expect((await getUserLedger(userId)).virtualBalance).toBe(0);

    // Merchant wins: restore the 6,000 actually deducted, not the 10,000 disputed.
    const won = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeId,
      100,
      `evt_frev_won_${stamp}`,
      paymentIntentId
    );
    expect(won.success).toBe(true);
    expect(won.balanceDelta).toBe(6000);

    const ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(6000);
    expect(ledger.totalWithdrawn).toBe(4000);
  });

  it('credits nothing when the dispute deducted nothing (full refund first)', async () => {
    const userId = await createUser();
    const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
    const paymentIntentId = await fund(userId, 100, stamp, 'b');

    // Full $100 refund -> balance 0, totalWithdrawn 10,000.
    const refunded = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'refund',
      100,
      `evt_frev_refund_${stamp}`
    );
    expect(refunded.success).toBe(true);
    expect((await getUserLedger(userId)).virtualBalance).toBe(0);

    // Dispute arrives after the full refund: deduction is 0.
    const disputeId = `dp_frev_${stamp}`;
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_frev_dispute_${stamp}`,
      disputeId
    );
    expect(disputed.success).toBe(true);
    // -0 === 0: the service returns -actualDeduction, which is -0 here.
    expect(disputed.balanceDelta === 0).toBe(true);

    // Merchant wins: there is no deduction to restore.
    const won = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeId,
      100,
      `evt_frev_won_${stamp}`,
      paymentIntentId
    );
    expect(won.success).toBe(true);
    expect(won.balanceDelta).toBe(0);

    const ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(0);
    expect(ledger.totalWithdrawn).toBe(10000);
  });

  it('winning the first of two disputes restores that dispute, not the latest (guard vs #1624)', async () => {
    const userId = await createUser();
    const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
    const paymentIntentId = await fund(userId, 100, stamp, 'c');
    await fund(userId, 100, stamp, 'c-topup');

    // Two disputes on the same payment: $20, then $10.
    const disputeA = `dp_frev_a_${stamp}`;
    const disputeB = `dp_frev_b_${stamp}`;
    const disputedA = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      20,
      `evt_frev_dispute_a_${stamp}`,
      disputeA
    );
    expect(disputedA.balanceDelta).toBe(-2000);
    const disputedB = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      10,
      `evt_frev_dispute_b_${stamp}`,
      disputeB
    );
    expect(disputedB.balanceDelta).toBe(-1000);

    // Win the FIRST dispute: restore 2,000, not the latest reversal (1,000).
    const wonA = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeA,
      20,
      `evt_frev_won_a_${stamp}`,
      paymentIntentId
    );
    expect(wonA.success).toBe(true);
    expect(wonA.balanceDelta).toBe(2000);

    // Win the second: restore its own 1,000.
    const wonB = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeB,
      10,
      `evt_frev_won_b_${stamp}`,
      paymentIntentId
    );
    expect(wonB.success).toBe(true);
    expect(wonB.balanceDelta).toBe(1000);

    const ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(20000);
    expect(ledger.totalWithdrawn).toBe(0);
  });

  it('a second won notice for the same dispute restores nothing', async () => {
    const userId = await createUser();
    const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
    const paymentIntentId = await fund(userId, 100, stamp, 'd');
    await fund(userId, 100, stamp, 'd-topup');

    const disputeId = `dp_frev_${stamp}`;
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_frev_dispute_${stamp}`,
      disputeId
    );
    expect(disputed.balanceDelta).toBe(-10000);

    const won1 = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeId,
      100,
      `evt_frev_won_1_${stamp}`,
      paymentIntentId
    );
    expect(won1.success).toBe(true);
    expect(won1.balanceDelta).toBe(10000);

    // Same dispute, new event id (not the same-event replay the existing
    // idempotency check catches): the deduction must not be restored twice.
    const won2 = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeId,
      100,
      `evt_frev_won_2_${stamp}`,
      paymentIntentId
    );
    expect(won2.success).toBe(true);
    expect(won2.alreadyProcessed).toBe(true);

    const ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(20000);
    expect(ledger.totalWithdrawn).toBe(0);
  });

  it('winning the clamped second of two disputes restores only that dispute (not the PI sum)', async () => {
    // Two $100 disputes on one $100 payment (Stripe: a payment can receive
    // more than one dispute). The first takes 10,000 units, the second only
    // 6,000 — the balance floor clamps it. Winning the second must restore
    // 6,000, not min($100, sum of both deductions = 16,000) = 10,000.
    const userId = await createUser();
    const stamp = `${Date.now()}_${await generateSnowflakeId()}`;
    const paymentIntentId = await fund(userId, 100, stamp, 'e');
    await fund(userId, 100, stamp, 'e-topup');

    const refunded = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'refund',
      40,
      `evt_frev_refund_${stamp}`
    );
    expect(refunded.balanceDelta).toBe(-4000);

    const disputeA = `dp_frev_a_${stamp}`;
    const disputeB = `dp_frev_b_${stamp}`;
    const disputedA = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_frev_dispute_a_${stamp}`,
      disputeA
    );
    expect(disputedA.balanceDelta).toBe(-10000);
    const disputedB = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_frev_dispute_b_${stamp}`,
      disputeB
    );
    expect(disputedB.balanceDelta).toBe(-6000);

    // Win the SECOND (clamped) dispute first: restore its 6,000 only.
    const wonB = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeB,
      100,
      `evt_frev_won_b_${stamp}`,
      paymentIntentId
    );
    expect(wonB.success).toBe(true);
    expect(wonB.balanceDelta).toBe(6000);

    // Win the first: restore its own 10,000. Total restored (16,000) now
    // equals total deducted (16,000) — no phantom units.
    const wonA = await TradingBalanceFundingService.creditDisputeWon(
      userId,
      disputeA,
      100,
      `evt_frev_won_a_${stamp}`,
      paymentIntentId
    );
    expect(wonA.success).toBe(true);
    expect(wonA.balanceDelta).toBe(10000);

    const ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(16000);
    expect(ledger.totalWithdrawn).toBe(4000);
  });
});
