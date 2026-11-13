/**
 * POST /api/stripe/webhook (charge.refunded) against a real database: a full
 * refund must take back exactly the balance units the purchase credited.
 *
 * Checkout charges Math.round(amountUSD * 100) cents and fundPurchase credits
 * usdToBalanceUnits(amountUSD) = one unit per charged cent (#1606). The refund
 * handler receives charge.amount_refunded in cents, divides by 100 and must
 * convert back the same way. 113 / 100 * 100 === 112.99999999999999 in
 * floating point, so flooring that product leaves one unit with the user.
 *
 * The webhook route handler and the database are real. Two modules are
 * stubbed: the `server-only` marker package (an empty module), and
 * constructWebhookEvent, which is replaced by a hand-written v1 HMAC check
 * (see below). This test therefore proves the refund and ledger behavior.
 * It does not prove the real Stripe signature-verification boundary, and it
 * is not a live payment end-to-end test: no real payment is made.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { TradingBalanceFundingService } from '@feed/api';
import { balanceTransactions, db, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

mock.module('server-only', () => ({}));

// Under Bun, the stripe package resolves its `bun` export (the worker build),
// whose synchronous constructEvent cannot use SubtleCrypto. Production runs
// `next start` on Node and gets the Node build. Keep the route's verification
// step but check the same v1 HMAC with node:crypto; everything else is real.
const stripeServerPath = '../../../apps/web/src/lib/stripe/server';
const actualStripeServer = await import(stripeServerPath);
mock.module(stripeServerPath, () => ({
  ...actualStripeServer,
  constructWebhookEvent: (payload: string, header: string) => {
    const parts = Object.fromEntries(
      header.split(',').map((part) => part.split('=') as [string, string])
    );
    const expected = createHmac(
      'sha256',
      process.env.STRIPE_WEBHOOK_SECRET as string
    )
      .update(`${parts.t}.${payload}`)
      .digest('hex');
    if (parts.v1 !== expected) throw new Error('signature mismatch');
    return JSON.parse(payload);
  },
}));

process.env.STRIPE_SECRET_KEY ??= 'sk_test_synthetic_refund_cents';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic_refund_cents';

let POST: typeof import('../../../apps/web/src/app/api/stripe/webhook/route').POST;
let signPayload: (payload: string) => string;
const userIds: string[] = [];

async function seedPurchase(cents: number) {
  const userId = await generateSnowflakeId();
  userIds.push(userId);
  await db.insert(users).values({
    id: userId,
    username: `test-refund-${userId}`,
    displayName: 'Refund Fixture',
    updatedAt: new Date(),
  });
  const paymentIntentId = `pi_test_refund_${userId}`;
  const funded = await TradingBalanceFundingService.fundPurchase(
    userId,
    cents / 100,
    `cs_test_refund_${userId}`,
    paymentIntentId,
    'stripe'
  );
  expect(funded.success).toBe(true);
  return { userId, paymentIntentId };
}

async function balanceOf(userId: string) {
  const [row] = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId));
  return Number(row?.virtualBalance);
}

async function sendRefund(
  paymentIntentId: string,
  amountCents: number,
  amountRefundedCents: number
) {
  const payload = JSON.stringify({
    id: `evt_test_refund_${paymentIntentId}_${amountRefundedCents}`,
    object: 'event',
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_test_${paymentIntentId}`,
        object: 'charge',
        amount: amountCents,
        amount_refunded: amountRefundedCents,
        refunded: amountRefundedCents >= amountCents,
        payment_intent: paymentIntentId,
        metadata: { app: 'feed' },
      },
    },
  });
  const response = await POST(
    new NextRequest('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signPayload(payload) },
      body: payload,
    })
  );
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  ({ POST } = await import(
    '../../../apps/web/src/app/api/stripe/webhook/route'
  ));
  // Stripe's documented v1 scheme: HMAC-SHA256 of `${timestamp}.${payload}`.
  signPayload = (payload) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac(
      'sha256',
      process.env.STRIPE_WEBHOOK_SECRET as string
    )
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    return `t=${timestamp},v1=${signature}`;
  };
});

afterAll(async () => {
  for (const userId of userIds) {
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('charge.refunded takes back exactly the credited balance units', () => {
  it('a full refund of a $1.13 purchase returns the balance to its start', async () => {
    const { userId, paymentIntentId } = await seedPurchase(113);
    const funded = await balanceOf(userId);

    await sendRefund(paymentIntentId, 113, 113);

    expect(funded - (await balanceOf(userId))).toBe(113);
  });

  it('two partial refunds of a $20.07 purchase take back every charged cent', async () => {
    const { userId, paymentIntentId } = await seedPurchase(2007);
    const funded = await balanceOf(userId);

    await sendRefund(paymentIntentId, 2007, 1003);
    expect(funded - (await balanceOf(userId))).toBe(1003);

    await sendRefund(paymentIntentId, 2007, 2007);
    expect(funded - (await balanceOf(userId))).toBe(2007);
  });
});
