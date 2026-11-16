/**
 * Repro: a full-amount dispute after a partial refund deducts the refunded
 * portion a second time.
 *
 * User path (all real service calls, no mocks):
 * 1. User funds $100 via Stripe (PI-1) -> balance 10,000 units.
 * 2. User tops up another $100 via Stripe (PI-2) -> balance 20,000 units,
 *    so the later dispute deduction is not masked by the balance clamp.
 * 3. User gets a $40 partial refund on PI-1 -> balance 16,000, totalWithdrawn
 *    4,000. The refund handler already nets prior refunds for the same
 *    payment intent (cumulative accounting).
 * 4. User's bank disputes the FULL $100 of PI-1 (Stripe allows a full-amount
 *    dispute after a partial refund; the issuer later corrects it, and on a
 *    'lost' close only the partially refunded amount is returned).
 *    The dispute handler deducts the full $100 again without netting the
 *    $40 already refunded.
 *
 * Correct end state: totalWithdrawn 10,000 (=$100 charge: $40 refund +
 * $60 dispute) and balance 10,000.
 * Base behavior: totalWithdrawn 14,000 and balance 6,000 — the $40 refunded
 * portion is deducted twice, and the 'lost' close path never returns it
 * (handleDisputeClosed early-returns for non-won disputes), so the loss is
 * permanent. Portfolio netContributions is understated by the same $40, so
 * totalPnL is overstated by $40.
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

describe('full-amount dispute after a partial refund', () => {
  it('deducts only the not-yet-refunded portion of the charge', async () => {
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

    const stamp = Date.now();
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
    let ledger = await getUserLedger(userId);
    expect(ledger.virtualBalance).toBe(16000);
    expect(ledger.totalWithdrawn).toBe(4000);

    // 4. Full-amount dispute of $100 on the same PI-1.
    const disputed = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'dispute',
      100,
      `evt_f3_dispute_${stamp}`
    );
    expect(disputed.success).toBe(true);
    ledger = await getUserLedger(userId);
    console.log(
      '[f3 repro] after dispute:',
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

  afterAll(async () => {
    for (const userId of testUserIds) {
      await dbWrite
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      await dbWrite.delete(users).where(eq(users.id, userId));
    }
  });
});
