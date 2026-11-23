/** Refunds use the same ledger units as purchases (PRD §9.1, MVP Phase 6). */
import { describe, expect, mock, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'Stripe refund cent accounting';
const cases = {
  full: 'deducts all 113 credited units on a full refund',
  partial: 'deducts 1003 units then the remainder of a 2007-unit purchase',
  legacy: 'limits a legacy refund to the recorded 112-unit credit',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks refund cent accounting in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'stripe-refund-cents',
      file: 'packages/testing/integration/stripe-refund-cents.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_refund_cents_fixture';
  const webhookSecret = `whsec_${randomUUID()}`;

  mock.module('server-only', () => ({}));

  const stripeServerPath = '../../../apps/web/src/lib/stripe/server';
  const stripeServer = await import(stripeServerPath);
  const computeHMACSignature = (payload: string, secret: string) =>
    createHmac('sha256', secret).update(payload).digest('hex');
  // Bun resolves Stripe's Worker export. Supply synchronous HMAC through the
  // SDK's crypto provider so it still validates and decodes each request.
  const cryptoProvider = {
    computeHMACSignature,
    async computeHMACSignatureAsync(payload: string, secret: string) {
      return computeHMACSignature(payload, secret);
    },
  };
  mock.module(stripeServerPath, () => ({
    ...stripeServer,
    constructWebhookEvent: (payload: string, signature: string) =>
      stripeServer.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
        undefined,
        cryptoProvider
      ),
  }));

  const { TradingBalanceFundingService } = await import('@feed/api');
  const { and, balanceTransactions, db, eq, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { POST } = await import(
    '../../../apps/web/src/app/api/stripe/webhook/route'
  );

  async function seedPurchase(cents: number, legacyUnits?: number) {
    const userId = await generateSnowflakeId();
    const paymentIntentId = `pi_test_refund_${userId}`;
    const [user] = await db
      .insert(users)
      .values({
        id: userId,
        username: `test-refund-${userId}`,
        displayName: 'Refund Fixture',
        virtualBalance: '1500',
        updatedAt: new Date(),
      })
      .returning({ balance: users.virtualBalance });
    if (!user) throw new Error('Refund fixture user was not inserted');

    const initialBalance = Number(user.balance);
    if (legacyUnits === undefined) {
      const funded = await TradingBalanceFundingService.fundPurchase(
        userId,
        cents / 100,
        `cs_test_refund_${userId}`,
        paymentIntentId,
        'stripe'
      );
      expect(funded.success).toBe(true);
    } else {
      const fundedBalance = initialBalance + legacyUnits;
      await db
        .update(users)
        .set({
          virtualBalance: String(fundedBalance),
          totalDeposited: String(legacyUnits),
        })
        .where(eq(users.id, userId));
      await db.insert(balanceTransactions).values({
        id: await generateSnowflakeId(),
        userId,
        type: 'stripe_purchase',
        amount: String(legacyUnits),
        balanceBefore: String(initialBalance),
        balanceAfter: String(fundedBalance),
        relatedId: paymentIntentId,
        description: JSON.stringify({ amountUSD: cents / 100 }),
      });
    }
    return { userId, paymentIntentId, cents, initialBalance };
  }

  async function sendRefund(
    purchase: Awaited<ReturnType<typeof seedPurchase>>,
    refundedCents: number
  ) {
    const { cents, paymentIntentId } = purchase;
    const payload = JSON.stringify({
      id: `evt_test_refund_${paymentIntentId}_${refundedCents}`,
      object: 'event',
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_test_${paymentIntentId}`,
          object: 'charge',
          amount: cents,
          amount_refunded: refundedCents,
          refunded: refundedCents === cents,
          payment_intent: paymentIntentId,
          metadata: { app: 'feed' },
        },
      },
    });
    const signature = stripeServer.stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      cryptoProvider,
    });
    const response = await POST(
      new NextRequest('http://localhost/api/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signature },
        body: payload,
      })
    );
    expect(response.status).toBe(200);
  }

  async function expectRefund(userId: string, balance: number, units: number) {
    const refunds = await db
      .select({ amount: balanceTransactions.amount })
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, userId),
          eq(balanceTransactions.type, 'stripe_refund')
        )
      );
    expect(
      refunds.reduce((sum, refund) => sum - Number(refund.amount), 0)
    ).toBe(units);
    const [user] = await db
      .select({ balance: users.virtualBalance })
      .from(users)
      .where(eq(users.id, userId));
    expect(Number(user?.balance)).toBe(balance);
  }

  describe(suite, () => {
    test(cases.full, async () => {
      const purchase = await seedPurchase(113);
      await sendRefund(purchase, 113);
      await expectRefund(purchase.userId, purchase.initialBalance, 113);
    });

    test(cases.partial, async () => {
      const purchase = await seedPurchase(2007);
      await sendRefund(purchase, 1003);
      await expectRefund(purchase.userId, purchase.initialBalance + 1004, 1003);
      await sendRefund(purchase, 2007);
      await expectRefund(purchase.userId, purchase.initialBalance, 2007);
    });

    test(cases.legacy, async () => {
      const purchase = await seedPurchase(113, 112);
      await sendRefund(purchase, 113);
      await expectRefund(purchase.userId, purchase.initialBalance, 112);
    });
  });
}
