/**
 * Moderation escrow transitions.
 *
 * Canonical implementation used by the A2A/MCP escrow handlers and the admin
 * HTTP routes. Every state change is a conditional UPDATE on the expected
 * current status, so concurrent verify/refund/expire calls cannot overwrite
 * each other, and no network call happens inside a database transaction.
 *
 * State machine: pending -> paid | expired; paid -> refunded.
 */

import { and, db, eq, isNull, moderationEscrows } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { getAddress, isAddress, parseEther } from 'ethers';
import { getSharedX402Manager } from './shared-manager';

export type EscrowRecord = typeof moderationEscrows.$inferSelect;

export type EscrowErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid_params'
  | 'invalid_state'
  | 'expired'
  | 'not_configured'
  | 'verification_failed';

export type EscrowResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EscrowErrorCode; message: string };

/** HTTP status for an escrow error code (used by the admin HTTP routes). */
export function escrowErrorHttpStatus(code: EscrowErrorCode): number {
  switch (code) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'not_configured':
      return 503;
    default:
      return 400;
  }
}

function fail<T>(code: EscrowErrorCode, message: string): EscrowResult<T> {
  return { ok: false, code, message };
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Escrow receiver (treasury). Returns null when not configured: escrow
 * payment requests are refused rather than directed at the zero address.
 */
export function getEscrowReceiver(): string | null {
  const receiver =
    process.env.MODERATION_ESCROW_RECEIVER ||
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
  if (!receiver || !isAddress(receiver) || BigInt(receiver) === 0n) {
    return null;
  }
  return getAddress(receiver);
}

export interface CreateEscrowInput {
  adminId: string;
  recipientId: string;
  amountUSD: number;
  reason?: string;
  recipientWalletAddress: string;
}

export async function createEscrowPayment(input: CreateEscrowInput): Promise<
  EscrowResult<{
    escrow: EscrowRecord;
    paymentRequest: {
      requestId: string;
      amount: string;
      from: string;
      to: string;
      expiresAt: number;
    };
  }>
> {
  const receiver = getEscrowReceiver();
  if (!receiver) {
    return fail(
      'not_configured',
      'MODERATION_ESCROW_RECEIVER (or NEXT_PUBLIC_TREASURY_ADDRESS) is not configured'
    );
  }

  const admin = await db.user.findUnique({
    where: { id: input.adminId },
    select: { id: true, isAdmin: true, walletAddress: true },
  });
  if (!admin?.isAdmin) {
    return fail('forbidden', 'Only admins can create escrow payments');
  }
  if (!admin.walletAddress) {
    return fail(
      'invalid_params',
      'Admin must have a connected wallet address to create escrow payments'
    );
  }
  if (input.recipientId === input.adminId) {
    return fail('invalid_params', 'Cannot create escrow payment to yourself');
  }

  const recipient = await db.user.findUnique({
    where: { id: input.recipientId },
    select: { id: true, isActor: true, walletAddress: true },
  });
  if (!recipient) {
    return fail('not_found', 'Recipient user not found');
  }
  if (recipient.isActor) {
    return fail('invalid_params', 'Cannot send escrow payment to NPCs/actors');
  }
  if (
    recipient.walletAddress &&
    input.recipientWalletAddress.toLowerCase() !==
      recipient.walletAddress.toLowerCase()
  ) {
    return fail(
      'invalid_params',
      "Recipient wallet address does not match user's registered wallet address"
    );
  }

  const recentDuplicate = await db.moderationEscrow.findFirst({
    where: {
      recipientId: input.recipientId,
      adminId: input.adminId,
      amountUSD: input.amountUSD.toString(),
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      status: { in: ['pending', 'paid'] },
    },
  });
  if (recentDuplicate) {
    return fail(
      'invalid_params',
      'A similar escrow payment was created recently. Please wait before creating another.'
    );
  }

  // Existing conversion policy: 1 USD = 0.001 ETH.
  const amountInWei = parseEther(
    (input.amountUSD * 0.001).toFixed(18)
  ).toString();

  const x402Manager = await getSharedX402Manager();
  const paymentRequest = await x402Manager.createPaymentRequest(
    admin.walletAddress, // Admin sends
    receiver, // to the treasury/escrow account
    amountInWei,
    'moderation_escrow',
    {
      adminId: input.adminId,
      recipientId: input.recipientId,
      recipientWalletAddress: input.recipientWalletAddress,
      amountUSD: input.amountUSD,
      reason: input.reason || null,
    }
  );

  const [escrow] = await db
    .insert(moderationEscrows)
    .values({
      id: await generateSnowflakeId(),
      recipientId: input.recipientId,
      adminId: input.adminId,
      amountUSD: input.amountUSD.toString(),
      amountWei: amountInWei,
      status: 'pending',
      reason: input.reason || null,
      paymentRequestId: paymentRequest.requestId,
      expiresAt: new Date(paymentRequest.expiresAt),
      metadata: {
        recipientWalletAddress: input.recipientWalletAddress,
        adminWalletAddress: admin.walletAddress,
      },
      updatedAt: new Date(),
    })
    .returning();
  if (!escrow) {
    throw new Error('Failed to create escrow record');
  }

  return {
    ok: true,
    value: {
      escrow,
      paymentRequest: {
        requestId: paymentRequest.requestId,
        amount: paymentRequest.amount,
        from: paymentRequest.from,
        to: paymentRequest.to,
        expiresAt: paymentRequest.expiresAt,
      },
    },
  };
}

export interface VerifyEscrowInput {
  escrowId: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
}

export async function verifyEscrowPayment(
  input: VerifyEscrowInput
): Promise<EscrowResult<EscrowRecord>> {
  const [escrow] = await db
    .select()
    .from(moderationEscrows)
    .where(eq(moderationEscrows.id, input.escrowId))
    .limit(1);
  if (!escrow) {
    return fail('not_found', 'Escrow payment not found');
  }

  // Check the current state BEFORE expiring: a paid/refunded escrow must
  // never be moved to expired by a late verification call.
  if (escrow.status !== 'pending') {
    return fail('invalid_state', `Escrow payment is already ${escrow.status}`);
  }

  if (new Date() > escrow.expiresAt) {
    await db
      .update(moderationEscrows)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(moderationEscrows.id, input.escrowId),
          eq(moderationEscrows.status, 'pending')
        )
      );
    return fail('expired', 'Escrow payment has expired');
  }

  if (!escrow.paymentRequestId) {
    return fail('invalid_state', 'Escrow payment request ID not found');
  }

  const expectedFromAddress = (
    escrow.metadata as { adminWalletAddress?: string } | null
  )?.adminWalletAddress;
  if (
    expectedFromAddress &&
    input.fromAddress.toLowerCase() !== expectedFromAddress.toLowerCase()
  ) {
    return fail(
      'invalid_params',
      'Transaction sender does not match admin wallet address'
    );
  }

  // On-chain verification happens outside any database transaction.
  const x402Manager = await getSharedX402Manager();
  const x402Result = await x402Manager.verifyPayment({
    requestId: escrow.paymentRequestId,
    txHash: input.txHash,
    from: input.fromAddress,
    to: input.toAddress,
    amount: input.amount,
    timestamp: Date.now(),
    confirmed: true,
  });
  if (!x402Result.verified) {
    return fail(
      'verification_failed',
      x402Result.error || 'Payment verification failed'
    );
  }

  const [updated] = await db
    .update(moderationEscrows)
    .set({ status: 'paid', paymentTxHash: input.txHash, updatedAt: new Date() })
    .where(
      and(
        eq(moderationEscrows.id, input.escrowId),
        eq(moderationEscrows.status, 'pending')
      )
    )
    .returning();
  if (!updated) {
    return fail('invalid_state', 'Escrow payment is no longer pending');
  }
  return { ok: true, value: updated };
}

export interface RefundEscrowInput {
  escrowId: string;
  refundTxHash: string;
  reason?: string;
  refundedBy: string;
}

export async function refundEscrowPayment(
  input: RefundEscrowInput
): Promise<EscrowResult<EscrowRecord>> {
  const [escrow] = await db
    .select()
    .from(moderationEscrows)
    .where(eq(moderationEscrows.id, input.escrowId))
    .limit(1);
  if (!escrow) {
    return fail('not_found', 'Escrow payment not found');
  }
  if (escrow.status !== 'paid') {
    return fail(
      'invalid_state',
      `Cannot refund escrow payment with status: ${escrow.status}. Only 'paid' escrows can be refunded.`
    );
  }
  if (escrow.refundTxHash) {
    return fail('invalid_state', 'Escrow payment has already been refunded');
  }
  if (!TX_HASH_PATTERN.test(input.refundTxHash)) {
    return fail('invalid_params', 'Invalid refund transaction hash format');
  }

  // Refund evidence: the refund transaction must actually return the
  // escrowed funds — sent from the treasury that received the escrow, to
  // one of the escrow's recorded parties (the admin who paid it in, or
  // the recipient), for at least the escrowed amount. Checking only that
  // *some* transaction succeeded would let any unrelated hash mark the
  // escrow refunded while the money never moved.
  const receiver = getEscrowReceiver();
  const metadata = (escrow.metadata ?? {}) as {
    adminWalletAddress?: string;
    recipientWalletAddress?: string;
  };
  const refundRecipients = [
    metadata.adminWalletAddress,
    metadata.recipientWalletAddress,
  ].filter((address): address is string => Boolean(address));
  if (!receiver || refundRecipients.length === 0) {
    return fail(
      'invalid_state',
      'Cannot verify refund: escrow receiver or refund recipient wallet is not recorded'
    );
  }
  const x402Manager = await getSharedX402Manager();
  const refundResult = await x402Manager.verifyRefundTransaction({
    txHash: input.refundTxHash,
    from: receiver,
    to: refundRecipients,
    amount: escrow.amountWei,
  });
  if (!refundResult.verified) {
    return fail(
      'verification_failed',
      refundResult.error || 'Refund verification failed'
    );
  }

  const [updated] = await db
    .update(moderationEscrows)
    .set({
      status: 'refunded',
      refundTxHash: input.refundTxHash,
      refundedBy: input.refundedBy,
      refundedAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        ...((escrow.metadata as Record<string, unknown> | null) ?? {}),
        refundReason: input.reason || null,
      },
    })
    .where(
      and(
        eq(moderationEscrows.id, input.escrowId),
        eq(moderationEscrows.status, 'paid'),
        isNull(moderationEscrows.refundTxHash)
      )
    )
    .returning();
  if (!updated) {
    return fail('invalid_state', 'Escrow payment is no longer refundable');
  }
  return { ok: true, value: updated };
}
