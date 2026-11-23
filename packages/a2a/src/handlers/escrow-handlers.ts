/**
 * A2A Escrow Handlers
 *
 * Handlers for moderation escrow payment methods via A2A protocol
 */

import {
  and,
  db,
  eq,
  isNull,
  lt,
  moderationEscrows,
  sql,
  users,
} from '@feed/db';
import { logger, MIN_APPEAL_STAKE_USD } from '@feed/shared';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  createEscrowPayment,
  type EscrowErrorCode,
  refundEscrowPayment,
  verifyEscrowPayment,
} from '../payments/escrow-service';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResult,
} from '../types/a2a';
import { ErrorCode } from '../types/a2a';

function escrowErrorResponse(
  request: JsonRpcRequest,
  code: EscrowErrorCode,
  message: string
): JsonRpcResponse {
  const rpcCode =
    code === 'forbidden'
      ? ErrorCode.FORBIDDEN
      : code === 'expired'
        ? ErrorCode.EXPIRED_REQUEST
        : code === 'verification_failed'
          ? ErrorCode.PAYMENT_FAILED
          : code === 'not_configured'
            ? ErrorCode.INTERNAL_ERROR
            : ErrorCode.INVALID_PARAMS;
  return { jsonrpc: '2.0', error: { code: rpcCode, message }, id: request.id };
}

async function requireAdmin(
  agentId: string,
  request: JsonRpcRequest,
  action: string
): Promise<JsonRpcResponse | null> {
  const admin = await db.user.findUnique({
    where: { id: agentId },
    select: { id: true, isAdmin: true },
  });
  if (!admin?.isAdmin) {
    return escrowErrorResponse(
      request,
      'forbidden',
      `Only admins can ${action} escrow payments`
    );
  }
  return null;
}

// Validation schemas
const CreateEscrowPaymentParamsSchema = z.object({
  recipientId: z.string().min(1),
  amountUSD: z.number().positive(),
  reason: z.string().optional(),
  recipientWalletAddress: z.string().min(1),
});

const VerifyEscrowPaymentParamsSchema = z.object({
  escrowId: z.string().min(1),
  txHash: z.string().min(1),
  fromAddress: z.string().min(1),
  toAddress: z.string().min(1),
  amount: z.string().min(1),
});

const RefundEscrowPaymentParamsSchema = z.object({
  escrowId: z.string().min(1),
  refundTxHash: z.string().min(1),
  reason: z.string().optional(),
});

const ListEscrowPaymentsParamsSchema = z.object({
  recipientId: z.string().optional(),
  adminId: z.string().optional(),
  status: z.enum(['pending', 'paid', 'refunded', 'expired']).optional(),
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

/**
 * Handle create escrow payment request (Admin only)
 */
export async function handleCreateEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const params = CreateEscrowPaymentParamsSchema.parse(request.params);
  const result = await createEscrowPayment({ adminId: agentId, ...params });
  if (!result.ok) {
    return escrowErrorResponse(request, result.code, result.message);
  }
  const { escrow, paymentRequest } = result.value;

  logger.info('A2A Escrow payment created', {
    agentId,
    escrowId: escrow.id,
    recipientId: params.recipientId,
    amountUSD: params.amountUSD,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: escrow.id,
        recipientId: escrow.recipientId,
        amountUSD: escrow.amountUSD.toString(),
        status: escrow.status,
        reason: escrow.reason,
        paymentRequestId: escrow.paymentRequestId,
        expiresAt: escrow.expiresAt.toISOString(),
      },
      paymentRequest,
    },
    id: request.id,
  };
}

/**
 * Handle verify escrow payment request
 */
export async function handleVerifyEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const denied = await requireAdmin(agentId, request, 'verify');
  if (denied) return denied;

  const params = VerifyEscrowPaymentParamsSchema.parse(request.params);
  const result = await verifyEscrowPayment(params);
  if (!result.ok) {
    return escrowErrorResponse(request, result.code, result.message);
  }
  const escrow = result.value;

  logger.info('A2A Escrow payment verified', {
    agentId,
    escrowId: params.escrowId,
    txHash: params.txHash,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: escrow.id,
        recipientId: escrow.recipientId,
        amountUSD: escrow.amountUSD.toString(),
        status: escrow.status,
        paymentTxHash: escrow.paymentTxHash,
      },
    },
    id: request.id,
  };
}

/**
 * Handle refund escrow payment request (Admin only)
 */
export async function handleRefundEscrowPayment(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const denied = await requireAdmin(agentId, request, 'refund');
  if (denied) return denied;

  const params = RefundEscrowPaymentParamsSchema.parse(request.params);
  const result = await refundEscrowPayment({ ...params, refundedBy: agentId });
  if (!result.ok) {
    return escrowErrorResponse(request, result.code, result.message);
  }
  const updatedEscrow = result.value;

  logger.info('A2A Escrow payment refunded', {
    agentId,
    escrowId: params.escrowId,
    refundTxHash: params.refundTxHash,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrow: {
        id: updatedEscrow.id,
        recipientId: updatedEscrow.recipientId,
        amountUSD: updatedEscrow.amountUSD.toString(),
        status: updatedEscrow.status,
        refundTxHash: updatedEscrow.refundTxHash,
        refundedAt: updatedEscrow.refundedAt?.toISOString(),
      },
    } as JsonRpcResult,
    id: request.id,
  };
}

/**
 * Handle list escrow payments request
 */
export async function handleListEscrowPayments(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const denied = await requireAdmin(agentId, request, 'list');
  if (denied) return denied;

  const params = ListEscrowPaymentsParamsSchema.parse(request.params);

  // Auto-expire old pending escrows before querying
  const now = new Date();
  await db
    .update(moderationEscrows)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(moderationEscrows.status, 'pending'),
        lt(moderationEscrows.expiresAt, now)
      )
    );

  const whereConditions: SQL<unknown>[] = [];
  if (params.recipientId)
    whereConditions.push(eq(moderationEscrows.recipientId, params.recipientId));
  if (params.adminId)
    whereConditions.push(eq(moderationEscrows.adminId, params.adminId));
  if (params.status)
    whereConditions.push(eq(moderationEscrows.status, params.status));
  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const [escrowsRaw, totalResult] = await Promise.all([
    db.query.moderationEscrows.findMany({
      where: whereClause
        ? (moderationEscrows, { eq, and: andFn }) => {
            const conditions: SQL<unknown>[] = [];
            if (params.recipientId)
              conditions.push(
                eq(moderationEscrows.recipientId, params.recipientId)
              );
            if (params.adminId)
              conditions.push(eq(moderationEscrows.adminId, params.adminId));
            if (params.status)
              conditions.push(eq(moderationEscrows.status, params.status));
            return conditions.length > 0 ? andFn(...conditions) : undefined;
          }
        : undefined,
      orderBy: (moderationEscrows, { desc: descFn }) => [
        descFn(moderationEscrows.createdAt),
      ],
      limit: params.limit,
      offset: params.offset,
      with: {
        recipient: {
          columns: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
          },
        },
        admin: {
          columns: {
            id: true,
            username: true,
            displayName: true,
          },
        },
        refundedByUser: {
          columns: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(moderationEscrows)
      .where(whereClause),
  ]);

  const total = Number(totalResult[0]?.count ?? 0);

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      escrows: escrowsRaw.map((escrow) => ({
        id: escrow.id,
        recipientId: escrow.recipientId,
        recipient: escrow.recipient,
        adminId: escrow.adminId,
        admin: escrow.admin,
        amountUSD: escrow.amountUSD.toString(),
        amountWei: escrow.amountWei,
        status: escrow.status,
        reason: escrow.reason,
        paymentRequestId: escrow.paymentRequestId,
        paymentTxHash: escrow.paymentTxHash,
        refundTxHash: escrow.refundTxHash,
        refundedBy: escrow.refundedBy,
        refundedByUser: escrow.refundedByUser,
        refundedAt: escrow.refundedAt?.toISOString(),
        createdAt: escrow.createdAt.toISOString(),
        expiresAt: escrow.expiresAt.toISOString(),
      })),
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
      },
    } as JsonRpcResult,
    id: request.id,
  };
}

/**
 * Handle appeal ban with escrow payment
 */
export async function handleAppealBanWithEscrow(
  agentId: string,
  request: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const params = z
    .object({
      reason: z.string().min(10).max(2000),
      escrowPaymentTxHash: z.string().min(1), // Escrow payment transaction hash
    })
    .parse(request.params);

  // Get user
  const user = await db.user.findUnique({
    where: { id: agentId },
    select: {
      id: true,
      isBanned: true,
      appealCount: true,
      appealStaked: true,
      appealStatus: true,
      bannedAt: true,
      bannedReason: true,
      appealStakeTxHash: true,
    },
  });

  if (!user) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'User not found',
      },
      id: request.id,
    };
  }

  if (!user.isBanned) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'User is not banned',
      },
      id: request.id,
    };
  }

  // Find escrow payment by transaction hash
  const escrow = await db.moderationEscrow.findUnique({
    where: { paymentTxHash: params.escrowPaymentTxHash },
  });

  if (!escrow) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment not found for this transaction hash',
      },
      id: request.id,
    };
  }

  if (escrow.recipientId !== agentId) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Escrow payment does not belong to this user',
      },
      id: request.id,
    };
  }

  if (escrow.status !== 'paid') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: `Escrow payment is not paid (status: ${escrow.status})`,
      },
      id: request.id,
    };
  }

  if (escrow.refundTxHash) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'Escrow payment has been refunded and cannot be used for appeal',
      },
      id: request.id,
    };
  }

  // Check if escrow was already used for an appeal
  const existingAppealWithEscrow = await db.user.findFirst({
    where: {
      appealStakeTxHash: params.escrowPaymentTxHash,
    },
  });

  if (existingAppealWithEscrow) {
    if (existingAppealWithEscrow.id === agentId) {
      return {
        jsonrpc: '2.0',
        error: {
          code: ErrorCode.INVALID_PARAMS,
          message: 'You have already used this escrow payment for an appeal',
        },
        id: request.id,
      };
    }
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'This escrow payment has already been used for an appeal by another user',
      },
      id: request.id,
    };
  }

  // This escrow IS the stake for a (second) appeal, so a used free appeal is
  // not a reason to reject; the stake must meet the advertised minimum.
  if (Number(escrow.amountUSD) < MIN_APPEAL_STAKE_USD) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: `Appeal stake must be at least $${MIN_APPEAL_STAKE_USD}`,
      },
      id: request.id,
    };
  }

  if (user.appealStaked && user.appealStatus === 'human_review') {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message:
          'Your appeal is already in human review. Please wait for a decision.',
      },
      id: request.id,
    };
  }

  // Update user appeal status (using escrow as stake). Conditional on the
  // user not already having a staked appeal recorded with another escrow, so
  // concurrent submissions cannot both be applied.
  const [updated] = await db
    .update(users)
    .set({
      appealCount: sql`COALESCE(${users.appealCount}, 0) + 1`,
      appealStaked: true,
      appealStakeAmount: escrow.amountUSD.toString(),
      appealStakeTxHash: params.escrowPaymentTxHash,
      appealStatus: 'lenient_review',
      appealSubmittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, agentId),
        user.appealStakeTxHash === null
          ? isNull(users.appealStakeTxHash)
          : eq(users.appealStakeTxHash, user.appealStakeTxHash)
      )
    )
    .returning({ id: users.id });
  if (!updated) {
    return {
      jsonrpc: '2.0',
      error: {
        code: ErrorCode.INVALID_PARAMS,
        message: 'Your appeal changed concurrently. Please retry.',
      },
      id: request.id,
    };
  }

  logger.info('A2A Ban appeal with escrow', {
    agentId,
    escrowId: escrow.id,
    amountUSD: escrow.amountUSD,
  });

  return {
    jsonrpc: '2.0',
    result: {
      success: true,
      message:
        'Appeal submitted with escrow payment. Your appeal is under lenient review.',
      appeal: {
        status: 'lenient_review',
        escrowId: escrow.id,
        amountUSD: escrow.amountUSD.toString(),
      },
    },
    id: request.id,
  };
}
