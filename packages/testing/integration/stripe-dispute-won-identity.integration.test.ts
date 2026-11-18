/**
 * POST /api/stripe/webhook: a won dispute restores exactly what THAT dispute
 * took — dispute identity, not the payment-intent sum.
 *
 * Single-dispute over-credit is owned by open PR #1959: it clamps the win to
 * the sum of all dispute deductions for the payment intent. These two cases
 * are the gaps that clamp leaves:
 * 1. Two $100 disputes on one $100 payment. The first takes 10,000 units,
 *    the second only 6,000 (balance floor). Winning the second must restore
 *    6,000 — the PI-sum clamp gives back min($100, 16,000) = 10,000.
 * 2. A second won notice for the same dispute (new event id) must restore
 *    nothing: the deduction was already restored once.
 *
 * Basis: PRD §9.1 / MVP Phase 6 accounting consistency, as the maintainer
 * stated when closing #1624: "a credit must be backed by a recorded
 * deduction and that deduction must not be restored more than once", and
 * "Match the dispute identity as well as the payment intent".
 *
 * The webhook route handler and the database are real. Three things are
 * replaced: the `server-only` marker package (an empty module),
 * constructWebhookEvent (a hand-written v1 HMAC check, see below), and
 * stripe.charges.retrieve (no network call; the test charge ID names its
 * payment intent). The refund in case 1 is set up with a direct service
 * call — only the dispute created/won path goes through the real POST.
 * This test proves the dispute and ledger behavior. It does not prove the
 * real Stripe signature-verification boundary, and no live payment or
 * dispute is made.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { TradingBalanceFundingService } from '@feed/api';
import { and, balanceTransactions, db, eq, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

mock.module('server-only', () => ({}));

// Under Bun, the stripe package resolves its `bun` export (the worker build),
// whose synchronous constructEvent cannot use SubtleCrypto. Production runs
// `next start` on Node and gets the Node build. Keep the route's verification
// step but check the same v1 HMAC with node:crypto.
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
  stripe: {
    charges: {
      retrieve: async (chargeId: string) => ({
        id: chargeId,
        payment_intent: { id: chargeId.replace(/^ch_test_/, '') },
      }),
    },
  },
}));

process.env.STRIPE_SECRET_KEY ??= 'sk_test_synthetic_dispute_won';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic_dispute_won';

let POST: typeof import('../../../apps/web/src/app/api/stripe/webhook/route').POST;

/**
 * A User row this test created, and the relatedId of every ledger row the
 * test caused for it. A setup is registered only after its INSERT ...
 * RETURNING succeeds, so an existing account never becomes ours to clean.
 */
type OwnedSetup = { userId: string; relatedIds: string[] };
const ownedSetups: OwnedSetup[] = [];

async function seedPurchase(cents: number) {
  const [row] = await db
    .insert(users)
    .values({
      id: await generateSnowflakeId(),
      username: `test-dispute-won-${Date.now()}-${Math.random()}`,
      displayName: 'Dispute Fixture',
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error('INSERT User returned no row');
  const setup: OwnedSetup = { userId: row.id, relatedIds: [] };
  ownedSetups.push(setup);
  const paymentIntentId = `pi_test_dispute_won_${setup.userId}`;
  setup.relatedIds.push(paymentIntentId);
  const funded = await TradingBalanceFundingService.fundPurchase(
    setup.userId,
    cents / 100,
    `cs_test_dispute_won_${setup.userId}`,
    paymentIntentId,
    'stripe'
  );
  expect(funded.success).toBe(true);
  return { setup, userId: setup.userId, paymentIntentId };
}

// Deletes only the ledger rows this test caused, then the User row. If the
// account has any other ledger row, cleanup refuses instead of deleting it.
async function cleanupSetup(setup: OwnedSetup) {
  if (setup.relatedIds.length > 0) {
    await db
      .delete(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, setup.userId),
          inArray(balanceTransactions.relatedId, setup.relatedIds)
        )
      );
  }
  const [foreignRow] = await db
    .select({ id: balanceTransactions.id })
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, setup.userId))
    .limit(1);
  if (foreignRow) {
    throw new Error(
      `User ${setup.userId} has ledger row ${foreignRow.id} this test did not create; not deleting the account`
    );
  }
  await db.delete(users).where(eq(users.id, setup.userId));
}

async function balanceOf(userId: string) {
  const [row] = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId));
  return Number(row?.virtualBalance);
}

// The user spends part of the balance (trading) before the chargeback.
async function setBalance(userId: string, units: number) {
  await db
    .update(users)
    .set({ virtualBalance: String(units) })
    .where(eq(users.id, userId));
}

function sign(payload: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac(
    'sha256',
    process.env.STRIPE_WEBHOOK_SECRET as string
  )
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function sendDisputeEvent(
  setup: OwnedSetup,
  paymentIntentId: string,
  type: 'charge.dispute.created' | 'charge.dispute.closed',
  amountCents: number,
  disputeTag = '',
  eventTag = '',
  expectedStatus = 200
) {
  const eventId = `evt_test_${type}_${paymentIntentId}${eventTag}`;
  setup.relatedIds.push(eventId);
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    data: {
      object: {
        id: `dp_test_${paymentIntentId}${disputeTag}`,
        object: 'dispute',
        amount: amountCents,
        charge: `ch_test_${paymentIntentId}`,
        reason: 'fraudulent',
        status: type === 'charge.dispute.closed' ? 'won' : 'needs_response',
      },
    },
  });
  const response = await POST(
    new NextRequest('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sign(payload) },
      body: payload,
    })
  );
  expect(response.status).toBe(expectedStatus);
}

beforeAll(async () => {
  ({ POST } = await import(
    '../../../apps/web/src/app/api/stripe/webhook/route'
  ));
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const setup of ownedSetups) {
    await cleanupSetup(setup).catch((error) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'dispute fixture cleanup refused');
  }
});

describe('a won dispute restores only what that dispute took', () => {
  it('retries a win before its debit and ignores a second created event', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(10000);
    const beforeDispute = await balanceOf(userId);
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      5000,
      '',
      '',
      500
    );
    expect(await balanceOf(userId)).toBe(beforeDispute);
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      5000
    );
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      5000,
      '',
      '_duplicate'
    );
    expect(await balanceOf(userId)).toBe(beforeDispute - 5000);
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      5000
    );
    expect(await balanceOf(userId)).toBe(beforeDispute);
  });

  it('winning the clamped second of two disputes restores only that dispute', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(10000);
    // Top-up $100 on another payment so the second dispute can still deduct.
    const topupPi = `pi_test_dispute_won_topup_${setup.userId}`;
    setup.relatedIds.push(topupPi);
    const topup = await TradingBalanceFundingService.fundPurchase(
      userId,
      100,
      `cs_test_dispute_won_topup_${setup.userId}`,
      topupPi,
      'stripe'
    );
    expect(topup.success).toBe(true);
    // Seeded users start at virtualBalance 1000 by DB default; normalize.
    await setBalance(userId, 20000);
    // $40 partial refund on the disputed payment (setup via service).
    const refundEventId = `evt_test_refund_${paymentIntentId}`;
    setup.relatedIds.push(refundEventId);
    const refunded = await TradingBalanceFundingService.reversePurchaseFunding(
      userId,
      paymentIntentId,
      'refund',
      40,
      refundEventId
    );
    expect(refunded.success).toBe(true);
    expect(await balanceOf(userId)).toBe(16000);

    // Two $100 disputes on the same payment, real POSTs.
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      10000,
      '_a',
      '_a'
    );
    expect(await balanceOf(userId)).toBe(6000);
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      10000,
      '_b',
      '_b'
    );
    expect(await balanceOf(userId)).toBe(0);

    // Win the SECOND (clamped, took 6,000): expect 6,000 back.
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      10000,
      '_b',
      '_wb'
    );
    expect(await balanceOf(userId)).toBe(6000);

    // Win the first (took 10,000): expect 16,000 total.
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      10000,
      '_a',
      '_wa'
    );
    expect(await balanceOf(userId)).toBe(16000);
  });

  it('a second won notice for the same dispute restores nothing', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(10000);
    const topupPi = `pi_test_dispute_won_topup_${setup.userId}`;
    setup.relatedIds.push(topupPi);
    const topup = await TradingBalanceFundingService.fundPurchase(
      userId,
      100,
      `cs_test_dispute_won_topup_${setup.userId}`,
      topupPi,
      'stripe'
    );
    expect(topup.success).toBe(true);
    await setBalance(userId, 20000);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      10000
    );
    expect(await balanceOf(userId)).toBe(10000);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      10000,
      '',
      '_w1'
    );
    expect(await balanceOf(userId)).toBe(20000);

    // Same dispute, NEW event id: must not restore again.
    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      10000,
      '',
      '_w2'
    );
    expect(await balanceOf(userId)).toBe(20000);
  });
});
