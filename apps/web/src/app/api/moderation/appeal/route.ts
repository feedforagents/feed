/**
 * Moderation Appeal API
 *
 * @route POST /api/moderation/appeal - Appeal ban
 * @access Authenticated
 *
 * @description
 * Allows banned users to appeal their ban. Supports free appeals (limited)
 * and staked appeals ($10) for faster review. Uses AI evaluation and
 * human review workflow.
 *
 * @openapi
 * /api/moderation/appeal:
 *   post:
 *     tags:
 *       - Moderation
 *     summary: Appeal ban
 *     description: Submits ban appeal with optional stake for faster review
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 2000
 *                 description: Appeal reasoning
 *               stakeTxHash:
 *                 type: string
 *                 description: Optional payment tx hash of an admin-verified moderation escrow payment (staked appeal)
 *     responses:
 *       200:
 *         description: Appeal submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 appealStatus:
 *                   type: string
 *                 evaluation:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Invalid appeal or already appealed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: User not banned
 *
 * @example
 * ```typescript
 * await fetch('/api/moderation/appeal', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     reason: 'I believe this ban was a mistake...',
 *     stakeTxHash: '0x...' // Optional for staked appeal
 *   })
 * });
 * ```
 */

import {
  authenticate,
  callClaudeDirect,
  createNotification,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import type { JsonValue } from '@feed/db';
import { db } from '@feed/db';
import { WalletService } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const AppealSchema = z.object({
  reason: z.string().min(10).max(2000),
  /**
   * Payment tx hash of a moderation escrow payment that an admin has verified
   * (status `paid`). Raw on-chain transactions are not accepted as stakes:
   * there is no configured stake contract to verify them against.
   */
  stakeTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash')
    .optional(),
});

/** Evaluator output must be well-formed; anything else fails closed. */
const StrictAppealEvaluationSchema = z.object({
  isFalsePositive: z.boolean(),
  reasoning: z.string().min(1),
});

const LenientAppealEvaluationSchema = z.object({
  shouldDeny: z.boolean(),
  reasoning: z.string().min(1),
});

function parseEvaluation<T>(response: string, schema: z.ZodType<T>): T {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Appeal evaluation returned no JSON');
  }
  const parsed = schema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    throw new Error('Appeal evaluation returned an invalid result');
  }
  return parsed.data;
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId!;

  const body = await request.json();
  const { reason, stakeTxHash } = AppealSchema.parse(body);

  // Get user
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      isBanned: true,
      appealCount: true,
      appealStaked: true,
      appealStatus: true,
      bannedAt: true,
      bannedReason: true,
      falsePositiveHistory: true,
    },
  });

  if (!user) {
    return successResponse({ success: false, error: 'User not found' }, 404);
  }

  if (!user.isBanned) {
    return successResponse(
      { success: false, error: 'User is not banned' },
      400
    );
  }

  // A second appeal requires a stake (either already recorded or submitted now)
  if (user.appealCount >= 1 && !user.appealStaked && !stakeTxHash) {
    return successResponse(
      {
        success: false,
        error:
          'You have already used your free appeal. You must stake $10 for a second review.',
      },
      400
    );
  }

  if (user.appealStaked && user.appealStatus === 'human_review') {
    return successResponse(
      {
        success: false,
        error:
          'Your appeal is already in human review. Please wait for a decision.',
      },
      400
    );
  }

  // If this is a staked appeal, verify stake or escrow payment
  if (stakeTxHash && !user.appealStaked) {
    // First check if this is an escrow payment. No relation is loaded here:
    // the Drizzle schema has no `User` relation on moderation escrows (the
    // relations are `recipient` / `admin` / `refundedByUser`), and the
    // included user fields were never read below, so requesting them threw
    // while building the query and every staked appeal answered 500.
    const escrow = await db.moderationEscrow.findUnique({
      where: { paymentTxHash: stakeTxHash },
    });

    if (escrow) {
      // Validate escrow can be used for appeal
      if (escrow.recipientId !== userId) {
        return successResponse(
          {
            success: false,
            error: 'Escrow payment does not belong to you',
          },
          400
        );
      }

      if (escrow.status !== 'paid') {
        return successResponse(
          {
            success: false,
            error: `Escrow payment is ${escrow.status}, must be 'paid' to use for appeal`,
          },
          400
        );
      }

      if (escrow.refundTxHash) {
        return successResponse(
          {
            success: false,
            error:
              'Escrow payment has been refunded and cannot be used for appeal',
          },
          400
        );
      }

      // Check if escrow was already used for an appeal by any user
      const existingAppealWithEscrow = await db.user.findFirst({
        where: {
          appealStakeTxHash: stakeTxHash,
        },
      });

      if (existingAppealWithEscrow) {
        if (existingAppealWithEscrow.id === userId) {
          return successResponse(
            {
              success: false,
              error: 'You have already used this escrow payment for an appeal',
            },
            400
          );
        }
        return successResponse(
          {
            success: false,
            error:
              'This escrow payment has already been used for an appeal by another user',
          },
          400
        );
      }

      // Use escrow payment as stake
      await db.user.update({
        where: { id: userId },
        data: {
          appealStaked: true,
          appealStakeAmount: escrow.amountUSD.toString(),
          appealStakeTxHash: stakeTxHash,
        },
      });
    } else {
      return successResponse(
        {
          success: false,
          error:
            'Stake must be a verified moderation escrow payment that belongs to you.',
        },
        400
      );
    }
  }

  // Determine appeal type
  const isStakedAppeal = user.appealStaked || !!stakeTxHash;
  const appealType = isStakedAppeal ? 'lenient_review' : 'strict_review';

  // Update user appeal status
  await db.user.update({
    where: { id: userId },
    data: {
      appealCount: user.appealCount + 1,
      appealStatus: appealType,
      appealSubmittedAt: new Date(),
    },
  });

  // Process appeal based on type
  if (isStakedAppeal) {
    // Lenient review - only deny if VERY OBVIOUSLY a scammer
    const result = await processLenientAppeal(userId, reason, user);

    if (result.shouldDeny) {
      // Send to human review
      await db.user.update({
        where: { id: userId },
        data: {
          appealStatus: 'human_review',
        },
      });

      await createNotification({
        userId,
        type: 'system',
        title: 'Appeal Under Human Review',
        message:
          'Your staked appeal has been reviewed and requires human confirmation. A moderator will review your case shortly.',
      });

      return successResponse({
        success: true,
        message: 'Appeal submitted for human review',
        status: 'human_review',
      });
    }
    // Approved - restore account
    await restoreAccount(userId, result.reasoning);

    return successResponse({
      success: true,
      message: 'Appeal approved - account restored',
      status: 'approved',
    });
  }
  // Strict review - check if false positive
  const result = await processStrictAppeal(userId, reason, user);

  if (result.isFalsePositive) {
    // Restore account
    await restoreAccount(userId, result.reasoning);

    return successResponse({
      success: true,
      message: 'Appeal approved - false positive confirmed',
      status: 'approved',
    });
  }
  // Denied - user must stake for second review
  await db.user.update({
    where: { id: userId },
    data: {
      appealStatus: 'denied',
      appealReviewedAt: new Date(),
    },
  });

  await createNotification({
    userId,
    type: 'system',
    title: 'Appeal Denied',
    message:
      'Your appeal was denied. You can stake $10 for a second, more lenient review.',
  });

  return successResponse({
    success: false,
    message: 'Appeal denied. Stake $10 for a second review.',
    status: 'denied',
    requiresStake: true,
  });
});

/**
 * Process strict appeal (first appeal) - checks if false positive
 */
async function processStrictAppeal(
  userId: string,
  reason: string,
  user: { bannedReason: string | null; falsePositiveHistory: unknown }
): Promise<{ isFalsePositive: boolean; reasoning: string }> {
  // Collect context
  const context = await collectAppealContext(userId, user);

  const prompt = `You are a strict appeal judge. A user has been banned and is appealing.

BAN REASON: ${user.bannedReason || 'No reason provided'}
APPEAL REASON: ${reason}

USER CONTEXT:
${JSON.stringify(context, null, 2)}

FALSE POSITIVE HISTORY:
${user.falsePositiveHistory ? JSON.stringify(user.falsePositiveHistory, null, 2) : 'None'}

TASK: Determine if this ban was a FALSE POSITIVE (user was incorrectly banned).

A false positive means:
- User was NOT actually scamming or posting CSAM
- Ban was due to misunderstanding, technical error, or false report
- User's behavior was legitimate

If user WAS scamming or posting CSAM, this is NOT a false positive.

Respond with JSON:
{
  "isFalsePositive": true/false,
  "reasoning": "Detailed explanation"
}`;

  const response = await callClaudeDirect({
    prompt,
    system:
      'You are a strict appeal judge. Only approve appeals if the ban was clearly a false positive. Be conservative.',
    model: 'claude-sonnet-4-5',
    temperature: 0.2,
    maxTokens: 2048,
  });

  return parseEvaluation(response, StrictAppealEvaluationSchema);
}

/**
 * Process lenient appeal (after staking) - only deny if VERY OBVIOUSLY scammer
 */
async function processLenientAppeal(
  userId: string,
  reason: string,
  user: { bannedReason: string | null; falsePositiveHistory: unknown }
): Promise<{ shouldDeny: boolean; reasoning: string }> {
  const context = await collectAppealContext(userId, user);

  const prompt = `You are a lenient appeal judge. A user has staked $10 for a second review.

BAN REASON: ${user.bannedReason || 'No reason provided'}
APPEAL REASON: ${reason}

USER CONTEXT:
${JSON.stringify(context, null, 2)}

FALSE POSITIVE HISTORY:
${user.falsePositiveHistory ? JSON.stringify(user.falsePositiveHistory, null, 2) : 'None'}

TASK: Only deny if the user is VERY OBVIOUSLY a scammer or CSAM poster.

Be VERY lenient. Only deny if:
- Clear, undeniable evidence of scamming (stealing points/money)
- Clear, undeniable evidence of CSAM
- Multiple confirmed reports with strong evidence

DO NOT deny for:
- Accidental rate limit violations
- Double messages
- Misunderstandings
- Edge cases
- Single reports without strong evidence

If there's ANY doubt, approve the appeal.

Respond with JSON:
{
  "shouldDeny": true/false,
  "reasoning": "Detailed explanation"
}`;

  const response = await callClaudeDirect({
    prompt,
    system:
      'You are a lenient appeal judge. Be VERY lenient. Only deny if user is VERY OBVIOUSLY a scammer or CSAM poster. If there is ANY doubt, approve.',
    model: 'claude-sonnet-4-5',
    temperature: 0.3,
    maxTokens: 2048,
  });

  return parseEvaluation(response, LenientAppealEvaluationSchema);
}

/**
 * Collect context for appeal evaluation
 */
async function collectAppealContext(
  userId: string,
  user: { bannedReason: string | null }
) {
  const now = new Date();
  const [reports, recentPosts, recentMessages] = await Promise.all([
    db.report.findMany({
      where: { reportedUserId: userId },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        category: true,
        reason: true,
        status: true,
        resolution: true,
        createdAt: true,
      },
    }),
    db.post.findMany({
      where: {
        authorId: userId,
        deletedAt: null,
        timestamp: { lte: now }, // ✅ No future posts - prevent information leakage
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        content: true,
        createdAt: true,
      },
    }),
    db.message.findMany({
      where: { senderId: userId },
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        content: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    bannedReason: user.bannedReason,
    reportsCount: reports.length,
    recentReports: reports,
    recentPostsCount: recentPosts.length,
    recentMessagesCount: recentMessages.length,
  };
}

/**
 * Restore user account after successful appeal
 */
async function restoreAccount(userId: string, reasoning: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { falsePositiveHistory: true },
  });

  const falsePositiveHistory =
    (user?.falsePositiveHistory as Array<Record<string, unknown>> | null) || [];
  falsePositiveHistory.push({
    date: new Date().toISOString(),
    reason: reasoning,
    reviewedBy: 'ai',
  });

  await db.user.update({
    where: { id: userId },
    data: {
      isBanned: false,
      isScammer: false,
      isCSAM: false,
      bannedAt: null,
      bannedBy: null,
      bannedReason: null,
      appealStatus: 'approved',
      appealReviewedAt: new Date(),
      falsePositiveHistory: falsePositiveHistory as JsonValue,
    },
  });

  // Refund stake if staked
  const updatedUser = await db.user.findUnique({
    where: { id: userId },
    select: {
      appealStaked: true,
      appealStakeAmount: true,
      appealStakeTxHash: true,
    },
  });

  if (
    updatedUser?.appealStaked &&
    updatedUser.appealStakeAmount &&
    updatedUser.appealStakeTxHash
  ) {
    await refundAppealStake(
      userId,
      Number(updatedUser.appealStakeAmount),
      updatedUser.appealStakeTxHash
    );
  }

  await createNotification({
    userId,
    type: 'system',
    title: 'Appeal Approved - Account Restored',
    message: `Your appeal was approved. ${reasoning}`,
  });

  logger.info('Account restored after appeal', { userId, reasoning }, 'Appeal');
}

/**
 * Refund appeal stake to user's virtual balance
 */
async function refundAppealStake(
  userId: string,
  stakeAmount: number,
  stakeTxHash: string
): Promise<void> {
  await WalletService.credit(
    userId,
    stakeAmount,
    'appeal_stake_refund',
    'Appeal stake refund - account restored',
    stakeTxHash
  );

  // Clear stake flags. appealStakeTxHash is intentionally kept so the same
  // escrow payment cannot be reused (and refunded again) for a later appeal.
  await db.user.update({
    where: { id: userId },
    data: {
      appealStaked: false,
      appealStakeAmount: null,
    },
  });

  logger.info(
    'Appeal stake refunded',
    {
      userId,
      stakeAmount,
    },
    'Appeal'
  );
}
