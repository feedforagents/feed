/**
 * POST /api/stripe/webhook (charge.refunded) against a real database: a full
 * refund must take back exactly the balance units the purchase credited,
 * including a legacy purchase written with the old floor conversion.
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
import { and, balanceTransactions, db, eq, inArray, users } from '@feed/db';
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

/**
 * A User row this test created, and the relatedId of every ledger row the
 * test caused for it (the purchase payment intent and each refund event).
 * A setup is registered only after its INSERT ... RETURNING succeeds, so a
 * rejected INSERT on an existing ID never makes that account ours to clean.
 */
type OwnedSetup = { userId: string; relatedIds: string[] };
const ownedSetups: OwnedSetup[] = [];

async function insertOwnedUser(userId: string): Promise<OwnedSetup> {
  const [row] = await db
    .insert(users)
    .values({
      id: userId,
      username: `test-refund-${userId}`,
      displayName: 'Refund Fixture',
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error(`INSERT User ${userId} returned no row`);
  const setup: OwnedSetup = { userId: row.id, relatedIds: [] };
  ownedSetups.push(setup);
  return setup;
}

async function seedPurchase(cents: number, userId?: string) {
  const setup = await insertOwnedUser(userId ?? (await generateSnowflakeId()));
  const paymentIntentId = `pi_test_refund_${setup.userId}`;
  setup.relatedIds.push(paymentIntentId);
  const funded = await TradingBalanceFundingService.fundPurchase(
    setup.userId,
    cents / 100,
    `cs_test_refund_${setup.userId}`,
    paymentIntentId,
    'stripe'
  );
  expect(funded.success).toBe(true);
  return { setup, userId: setup.userId, paymentIntentId };
}

async function seedLegacyPurchase(cents: number, creditedUnits: number) {
  const setup = await insertOwnedUser(await generateSnowflakeId());
  const paymentIntentId = `pi_test_refund_${setup.userId}`;
  setup.relatedIds.push(paymentIntentId);
  const balanceBefore = await balanceOf(setup.userId);
  const transactionId = await generateSnowflakeId();
  await db
    .update(users)
    .set({
      virtualBalance: String(balanceBefore + creditedUnits),
      totalDeposited: String(balanceBefore + creditedUnits),
    })
    .where(eq(users.id, setup.userId));
  await db.insert(balanceTransactions).values({
    id: transactionId,
    userId: setup.userId,
    type: 'stripe_purchase',
    amount: String(creditedUnits),
    balanceBefore: String(balanceBefore),
    balanceAfter: String(balanceBefore + creditedUnits),
    relatedId: paymentIntentId,
    description: JSON.stringify({ amountUSD: cents / 100 }),
  });
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

async function ledgerOf(userId: string) {
  return db
    .select({
      id: balanceTransactions.id,
      amount: balanceTransactions.amount,
      relatedId: balanceTransactions.relatedId,
    })
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId))
    .orderBy(balanceTransactions.id);
}

function postgresErrorOf(error: unknown) {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: candidate.constraint_name ?? candidate.constraint,
      };
    }
    current = candidate.cause;
  }
  return null;
}

async function balanceOf(userId: string) {
  const [row] = await db
    .select({ virtualBalance: users.virtualBalance })
    .from(users)
    .where(eq(users.id, userId));
  return Number(row?.virtualBalance);
}

async function sendRefund(
  setup: OwnedSetup,
  paymentIntentId: string,
  amountCents: number,
  amountRefundedCents: number
) {
  const eventId = `evt_test_refund_${paymentIntentId}_${amountRefundedCents}`;
  setup.relatedIds.push(eventId);
  const payload = JSON.stringify({
    id: eventId,
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
  const failures: unknown[] = [];
  for (const setup of ownedSetups) {
    await cleanupSetup(setup).catch((error) => failures.push(error));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'refund fixture cleanup refused');
  }
});

describe('charge.refunded takes back exactly the credited balance units', () => {
  it('a full refund of a $1.13 purchase returns the balance to its start', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(113);
    const funded = await balanceOf(userId);

    await sendRefund(setup, paymentIntentId, 113, 113);

    expect(funded - (await balanceOf(userId))).toBe(113);
  });

  it('two partial refunds of a $20.07 purchase take back every charged cent', async () => {
    const { setup, userId, paymentIntentId } = await seedPurchase(2007);
    const funded = await balanceOf(userId);

    await sendRefund(setup, paymentIntentId, 2007, 1003);
    expect(funded - (await balanceOf(userId))).toBe(1003);

    await sendRefund(setup, paymentIntentId, 2007, 2007);
    expect(funded - (await balanceOf(userId))).toBe(2007);
  });

  it('a refund never takes back more than a legacy purchase credited', async () => {
    const { setup, userId, paymentIntentId } = await seedLegacyPurchase(
      113,
      112
    );
    const funded = await balanceOf(userId);

    await sendRefund(setup, paymentIntentId, 113, 113);

    expect(funded - (await balanceOf(userId))).toBe(112);
  });
});

describe('refund fixture cleanup', () => {
  it('a rejected setup INSERT registers nothing, so the existing account and its ledger are kept', async () => {
    const existing = await seedPurchase(500);
    const ledgerBefore = await ledgerOf(existing.userId);
    const balanceBefore = await balanceOf(existing.userId);
    const setupsBefore = ownedSetups.length;

    const rejected = await seedPurchase(113, existing.userId).then(
      () => null,
      (error: unknown) => error
    );

    // PostgreSQL unique_violation on the User primary key.
    expect(postgresErrorOf(rejected)).toEqual({
      code: '23505',
      constraint: 'User_pkey',
    });
    expect(ownedSetups.length).toBe(setupsBefore);
    expect(ownedSetups.filter((s) => s.userId === existing.userId)).toEqual([
      existing.setup,
    ]);
    expect(await ledgerOf(existing.userId)).toEqual(ledgerBefore);
    expect(await balanceOf(existing.userId)).toBe(balanceBefore);
  });

  it('cleanup refuses to delete an account that has a ledger row the test did not create', async () => {
    const { setup, userId } = await seedPurchase(200);
    const balanceBefore = await balanceOf(userId);
    const foreignId = await generateSnowflakeId();
    await db.insert(balanceTransactions).values({
      id: foreignId,
      userId,
      type: 'test_foreign_row',
      amount: '0',
      balanceBefore: '0',
      balanceAfter: '0',
      relatedId: `foreign_${foreignId}`,
    });

    try {
      await expect(cleanupSetup(setup)).rejects.toThrow(
        `has ledger row ${foreignId} this test did not create`
      );
      expect((await ledgerOf(userId)).map((row) => row.id)).toEqual([
        foreignId,
      ]);
      expect(await balanceOf(userId)).toBe(balanceBefore);
    } finally {
      // The foreign row exists only to prove the refusal; remove it so
      // afterAll can clean this setup normally.
      await db
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.id, foreignId));
    }
  });
});
