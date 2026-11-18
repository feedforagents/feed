/**
 * POST /api/stripe/webhook (charge.dispute.created, then charge.dispute.closed
 * with status "won") against a real database: a won dispute must give back
 * the balance units the dispute took, and no more.
 *
 * reversePurchaseFunding stops a dispute deduction at a zero balance. A user
 * who spent the purchased balance before the chargeback loses fewer units
 * than the disputed amount, so re-crediting the full disputed amount creates
 * balance units that were never taken.
 *
 * The webhook route handler and the database are real. Three things are
 * replaced: the `server-only` marker package (an empty module),
 * constructWebhookEvent (a hand-written v1 HMAC check, see below), and
 * stripe.charges.retrieve (no network call; the test charge ID names its
 * payment intent). This test proves the dispute and ledger behavior. It does
 * not prove the real Stripe signature-verification boundary, and no live
 * payment or dispute is made.
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
  amountCents: number
) {
  const eventId = `evt_test_${type}_${paymentIntentId}`;
  setup.relatedIds.push(eventId);
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    data: {
      object: {
        id: `dp_test_${paymentIntentId}`,
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
  expect(response.status).toBe(200);
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

describe('a won dispute gives back what the dispute took', () => {
  it('the full purchase is still on the balance: the full amount comes back', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(5000);
    const funded = await balanceOf(userId);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      5000
    );
    expect(funded - (await balanceOf(userId))).toBe(5000);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      5000
    );
    expect(await balanceOf(userId)).toBe(funded);
  });

  it('the balance was spent to 0: the dispute took nothing and gives back nothing', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(10000);
    await setBalance(userId, 0);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      10000
    );
    expect(await balanceOf(userId)).toBe(0);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      10000
    );
    expect(await balanceOf(userId)).toBe(0);
  });

  it('part of the balance was spent: only the units taken come back', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(5000);
    await setBalance(userId, 3000);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.created',
      5000
    );
    expect(await balanceOf(userId)).toBe(0);

    await sendDisputeEvent(
      setup,
      paymentIntentId,
      'charge.dispute.closed',
      5000
    );
    expect(await balanceOf(userId)).toBe(3000);
  });
});
