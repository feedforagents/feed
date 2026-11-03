/**
 * User Signup API
 *
 * @route POST /api/users/signup - Complete user signup/onboarding
 * @access Authenticated
 *
 * @description
 * Completes off-chain user onboarding with profile creation, referral handling,
 * social account linking, and points awards. Supports waitlist users and legal
 * acceptance tracking.
 *
 * @openapi
 * /api/users/signup:
 *   post:
 *     tags:
 *       - Users
 *     summary: Complete user signup
 *     description: Completes off-chain onboarding with profile creation and points awards
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - displayName
 *             properties:
 *               username:
 *                 type: string
 *               displayName:
 *                 type: string
 *               bio:
 *                 type: string
 *               profileImageUrl:
 *                 type: string
 *               coverImageUrl:
 *                 type: string
 *               referralCode:
 *                 type: string
 *               identityToken:
 *                 type: string
 *                 description: Deprecated legacy field accepted for backwards compatibility
 *               isWaitlist:
 *                 type: boolean
 *                 default: false
 *               tosAccepted:
 *                 type: boolean
 *               privacyPolicyAccepted:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Signup completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 referral:
 *                   type: object
 *                   nullable: true
 *       400:
 *         description: Username taken or invalid input
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/users/signup', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     username: 'alice',
 *     displayName: 'Alice',
 *     bio: 'Hello world',
 *     referralCode: 'friend123'
 *   })
 * });
 * ```
 *
 * @see {@link /lib/services/points-service} Points service
 * @see {@link /lib/onboarding/types} Onboarding types
 */

import {
  authenticate,
  ConflictError,
  cachedDb,
  getHashedClientIp,
  InternalServerError,
  isReferralCodeAvailableForUser,
  notifyNewAccount,
  ReputationService,
  successResponse,
  TradingBalanceFundingService,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  db,
  eq,
  follows,
  isRetryableError,
  referrals,
  sql,
  toDatabaseErrorType,
  users,
  withRetry,
  withTransaction,
} from '@feed/db';
import { UserAlphaGroupAssignmentService } from '@feed/engine';
import {
  generateSnowflakeId,
  logger,
  OnboardingProfileSchema,
  POINTS,
  toISO,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { trackServerEvent } from '@/lib/posthog/server';

const SignupSchema = OnboardingProfileSchema.extend({
  identityToken: z
    .string()
    .min(1)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  isWaitlist: z.boolean().optional().default(false),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const privyId = authUser.privyId ?? authUser.userId;

  // identityToken is a deprecated field still accepted from older clients; it is
  // ignored. Social import fields (importedFrom/twitterId/twitterUsername) only
  // pre-fill display data on the client and never establish a linked account:
  // the onboarding import redirect is not a server-side proof of ownership.
  // Twitter linking goes through the verified /api/auth/twitter OAuth flow.
  const {
    identityToken: _identityToken,
    referralCode: rawReferralCode,
    isWaitlist,
    ...parsedProfile
  } = SignupSchema.parse(await request.json());
  const referralCode = rawReferralCode?.trim() || null;

  const canonicalUserId = authUser.dbUserId ?? authUser.userId;

  // Capture and hash IP address for self-referral detection
  const registrationIpHash = getHashedClientIp(request.headers);

  // Wrap transaction with retry logic for connection errors
  const result = await withRetry(
    async () => {
      return await withTransaction(async (tx) => {
        // Check if username is already taken by another user (case-insensitive)
        const [existingUsername] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            sql`lower(${users.username}) = lower(${parsedProfile.username})`
          )
          .limit(1);

        if (existingUsername && existingUsername.id !== canonicalUserId) {
          throw new ConflictError('Username is already taken', 'User.username');
        }

        // Resolve referral (if provided AND not already set)
        let resolvedReferrerId: string | null = null;
        let resolvedReferralRecordId: string | null = null;
        const normalizedCode = referralCode?.trim() || null;

        // Check if user already has referredBy (set in /api/users/me)
        const [existingUser] = await tx
          .select({ referredBy: users.referredBy })
          .from(users)
          .where(eq(users.id, canonicalUserId))
          .limit(1);

        // Only resolve referral if not already set
        if (!existingUser?.referredBy && normalizedCode) {
          // First, try to find referrer by username (legacy system, case-insensitive)
          const [referrerByUsername] = await tx
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.username}) = lower(${normalizedCode})`)
            .limit(1);

          if (referrerByUsername && referrerByUsername.id !== canonicalUserId) {
            resolvedReferrerId = referrerByUsername.id;
          } else {
            // If not found by username, look up who owns this referral code
            const [referralOwner] = await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.referralCode, normalizedCode))
              .limit(1);

            if (referralOwner && referralOwner.id !== canonicalUserId) {
              resolvedReferrerId = referralOwner.id;
            }
          }

          // Note: Referral record will be created AFTER user upsert to satisfy FK constraint
        } else if (existingUser?.referredBy) {
          // User already has referredBy (set in /api/users/me)
          resolvedReferrerId = existingUser.referredBy;
          logger.info(
            'Using existing referredBy from user record',
            {
              userId: canonicalUserId,
              referredBy: resolvedReferrerId,
            },
            'POST /api/users/signup'
          );
        }

        // Email is owned by the auth provider (set at login); signup never
        // writes email/emailVerified so an existing verified email is preserved.
        const baseUserData: Partial<typeof users.$inferInsert> = {
          username: parsedProfile.username,
          referralCode: parsedProfile.username,
          displayName: parsedProfile.displayName,
          bio: parsedProfile.bio ?? '',
          profileImageUrl: parsedProfile.profileImageUrl ?? null,
          coverImageUrl: parsedProfile.coverImageUrl ?? null,
          profileComplete: true,
          profileSetupCompletedAt: new Date(), // Track when profile was completed
          hasUsername: true,
          hasBio: Boolean(
            parsedProfile.bio && parsedProfile.bio.trim().length > 0
          ),
          hasProfileImage: Boolean(parsedProfile.profileImageUrl),
          // Store IP hash for self-referral detection
          ...(registrationIpHash ? { registrationIpHash } : {}),
          // Legal acceptance (GDPR compliance)
          ...(parsedProfile.tosAccepted
            ? {
                tosAccepted: true,
                tosAcceptedAt: new Date(),
                tosAcceptedVersion: '2025-11-11',
              }
            : {}),
          ...(parsedProfile.privacyPolicyAccepted
            ? {
                privacyPolicyAccepted: true,
                privacyPolicyAcceptedAt: new Date(),
                privacyPolicyAcceptedVersion: '2025-11-11',
              }
            : {}),
        };

        const isUsernameReferralCodeAvailable =
          await isReferralCodeAvailableForUser(
            canonicalUserId,
            parsedProfile.username
          );

        if (!isUsernameReferralCodeAvailable) {
          throw new ConflictError(
            `Username "${parsedProfile.username}" is already used as a referral code by another user`,
            'User.referralCode'
          );
        }

        // Upsert user (insert or update)
        let user: typeof users.$inferSelect;
        const [existingUserRecord] = await tx
          .select()
          .from(users)
          .where(eq(users.id, canonicalUserId))
          .limit(1);

        if (existingUserRecord) {
          // Waitlist users start with 100 points instead of 1000. Only apply on
          // the first profile completion so a signup replay never resets an
          // accumulated balance.
          const applyWaitlistStart =
            isWaitlist && !existingUserRecord.profileComplete;
          const [updatedUser] = await tx
            .update(users)
            .set({
              ...baseUserData,
              ...(applyWaitlistStart ? { reputationPoints: 100 } : {}),
              referredBy: resolvedReferrerId ?? existingUserRecord.referredBy,
              updatedAt: new Date(),
            })
            .where(eq(users.id, canonicalUserId))
            .returning();
          if (!updatedUser) {
            throw new InternalServerError('Failed to update user record');
          }
          user = updatedUser;
        } else {
          // Create new user
          const [newUser] = await tx
            .insert(users)
            .values({
              id: canonicalUserId,
              privyId,
              ...baseUserData,
              ...(isWaitlist ? { reputationPoints: 100 } : {}),
              referredBy: resolvedReferrerId,
              updatedAt: new Date(),
            })
            .returning();
          if (!newUser) {
            throw new InternalServerError('Failed to create user record');
          }
          user = newUser;
        }

        // Create referral record AFTER user exists (to satisfy FK constraint)
        if (resolvedReferrerId && normalizedCode) {
          // Check if referral record already exists
          const [existingReferral] = await tx
            .select({ id: referrals.id })
            .from(referrals)
            .where(
              and(
                eq(referrals.referralCode, normalizedCode),
                eq(referrals.referredUserId, user.id)
              )
            )
            .limit(1);

          if (existingReferral) {
            // Update existing record
            await tx
              .update(referrals)
              .set({ status: 'pending' })
              .where(eq(referrals.id, existingReferral.id));
            resolvedReferralRecordId = existingReferral.id;
          } else {
            // Create new referral record
            const referralId = await generateSnowflakeId();
            const [referralRecord] = await tx
              .insert(referrals)
              .values({
                id: referralId,
                referrerId: resolvedReferrerId,
                referralCode: normalizedCode,
                referredUserId: user.id,
                status: 'pending',
              })
              .returning({ id: referrals.id });
            if (!referralRecord) {
              throw new InternalServerError('Failed to create referral record');
            }
            resolvedReferralRecordId = referralRecord.id;
          }
        }

        return {
          user,
          referrerId: resolvedReferrerId,
          referralRecordId: resolvedReferralRecordId,
        };
      });
    },
    3, // maxRetries
    200 // delayMs
  ).catch((error: unknown) => {
    // Improve error message for connection errors
    if (isRetryableError(toDatabaseErrorType(error))) {
      logger.error(
        'Database connection error during signup transaction',
        { error: error instanceof Error ? error.message : String(error) },
        'POST /api/users/signup'
      );
      throw new Error(
        'Database connection error. Please try again in a moment.'
      );
    }
    throw error;
  });

  // Invalidate identifier caches for the new/updated user (clears negative cache)
  await cachedDb.invalidateUserIdentifierCaches({
    id: result.user.id,
    privyId: result.user.privyId,
    username: result.user.username,
  });

  // Fund the user's trading balance with the welcome bonus (idempotent).
  const userId = result.user.id;
  const welcomeBonus = POINTS.INITIAL_SIGNUP;
  const welcomeBonusResult =
    await TradingBalanceFundingService.awardWelcomeBonus(userId, welcomeBonus);

  if (!welcomeBonusResult.success) {
    throw new InternalServerError(
      welcomeBonusResult.error ?? 'Failed to fund signup welcome bonus'
    );
  }

  if (!welcomeBonusResult.alreadyProcessed) {
    logger.info(
      'Welcome bonus funded to trading balance at profile completion',
      { userId, amount: welcomeBonus },
      'POST /api/users/signup'
    );
  }

  const reputationBreakdown = {
    profile: 0,
    referral: 0,
    referralBonus: 0,
  };

  // Award referral reputation if user was referred.
  if (result.referrerId) {
    // Record the referral. awardReferralSignup no longer credits the referrer.
    const referralResult = await ReputationService.awardReferralSignup(
      result.referrerId,
      result.user.id
    );
    reputationBreakdown.referral = referralResult.reputationAwarded;

    // The referrer is not paid. PRD §9.6 removes referral signup rewards and
    // the new-user referral bonus. D-18 says points cannot be transferred
    // between users. Still record the referral and the follow.
    if (referralResult.success) {
      // Update referral status to completed
      if (result.referralRecordId) {
        await db
          .update(referrals)
          .set({
            status: 'completed',
            completedAt: new Date(),
          })
          .where(eq(referrals.id, result.referralRecordId));
      }

      // Auto-follow the referrer (new user follows the person who referred them)
      // Check if follow already exists
      const [existingFollow] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, result.user.id),
            eq(follows.followingId, result.referrerId)
          )
        )
        .limit(1);

      if (!existingFollow) {
        const followId = await generateSnowflakeId();
        await db.insert(follows).values({
          id: followId,
          followerId: result.user.id,
          followingId: result.referrerId,
        });
      }

      logger.info(
        'Recorded a referral without paying signup points',
        {
          referrerId: result.referrerId,
          referredUserId: result.user.id,
          referrerReputation: referralResult.reputationAwarded,
          refereeReputationBonus: 0,
        },
        'POST /api/users/signup'
      );
    } else {
      // Referral was blocked (self-referral, weekly limit, etc.)
      // Update referral status to rejected
      if (result.referralRecordId) {
        await db
          .update(referrals)
          .set({ status: 'rejected' })
          .where(eq(referrals.id, result.referralRecordId));
      }

      logger.warn(
        'Referral blocked - referrer not rewarded',
        {
          referrerId: result.referrerId,
          referredUserId: result.user.id,
          error: referralResult.error,
        },
        'POST /api/users/signup'
      );
    }
  }
  if (!result.user.pointsAwardedForProfile) {
    const pointsResult = await ReputationService.awardProfileCompletion(
      result.user.id
    );
    reputationBreakdown.profile = pointsResult.reputationAwarded;
    logger.info(
      'Awarded profile completion reputation',
      { userId: result.user.id, reputation: pointsResult.reputationAwarded },
      'POST /api/users/signup'
    );
  }

  const totalReputationAwarded = Object.values(reputationBreakdown).reduce(
    (sum, p) => sum + p,
    0
  );

  logger.info(
    'User completed off-chain onboarding',
    {
      userId: result.user.id,
      hasReferrer: Boolean(result.referrerId),
      reputationBreakdown,
      totalReputationAwarded,
      hasTwitter: result.user.hasTwitter,
    },
    'POST /api/users/signup'
  );

  await notifyNewAccount(result.user.id);

  // Track signup with PostHog
  await trackServerEvent(result.user.id, 'signup_completed', {
    username: result.user.username,
    hasReferrer: Boolean(result.referrerId),
    hasTwitter: result.user.hasTwitter,
    hasProfileImage: result.user.hasProfileImage,
    hasBio: result.user.hasBio,
    reputationAwarded: totalReputationAwarded,
    reputationBreakdown,
    importedFrom: parsedProfile.importedFrom || null,
  });

  // Assign default alpha groups (async, non-blocking)
  // New users get access to NPC group chats from day one
  // This runs after the main signup flow to avoid blocking the response
  if (!isWaitlist) {
    UserAlphaGroupAssignmentService.assignDefaultGroups(result.user.id)
      .then((assignmentResult) => {
        if (assignmentResult.groupsAssigned > 0) {
          logger.info(
            'Assigned default alpha groups to new user',
            {
              userId: result.user.id,
              groupsAssigned: assignmentResult.groupsAssigned,
              assignments: assignmentResult.assignments.map((a) => ({
                npc: a.npcName,
                tier: a.tier,
              })),
            },
            'POST /api/users/signup'
          );
          // Track successful assignment for monitoring
          trackServerEvent(result.user.id, 'alpha_group_assignment.success', {
            groupsAssigned: assignmentResult.groupsAssigned,
            assignments: assignmentResult.assignments.map((a) => a.npcName),
          }).catch((err) => {
            logger.debug(
              'Tracking event failed',
              { error: err, event: 'alpha_group_assignment.success' },
              'POST /api/users/signup'
            );
          });
        }
        if (assignmentResult.errors.length > 0) {
          logger.warn(
            'Some default group assignments had errors',
            {
              userId: result.user.id,
              errors: assignmentResult.errors,
            },
            'POST /api/users/signup'
          );
          // Track partial failures for monitoring
          trackServerEvent(
            result.user.id,
            'alpha_group_assignment.partial_failure',
            {
              groupsAssigned: assignmentResult.groupsAssigned,
              errorCount: assignmentResult.errors.length,
            }
          ).catch((err) => {
            logger.debug(
              'Tracking event failed',
              { error: err, event: 'alpha_group_assignment.partial_failure' },
              'POST /api/users/signup'
            );
          });
        }
      })
      .catch((error) => {
        // Log but don't fail signup - alpha group assignment is non-critical
        logger.warn(
          'Failed to assign default alpha groups',
          { userId: result.user.id, error: String(error) },
          'POST /api/users/signup'
        );
        // Track failures for monitoring and alerting
        trackServerEvent(result.user.id, 'alpha_group_assignment.failure', {
          error: String(error),
        }).catch((err) => {
          logger.debug(
            'Tracking event failed',
            { error: err, event: 'alpha_group_assignment.failure' },
            'POST /api/users/signup'
          );
        });
      });
  }

  return successResponse({
    user: {
      id: result.user.id,
      privyId: result.user.privyId,
      username: result.user.username,
      displayName: result.user.displayName,
      bio: result.user.bio,
      profileImageUrl: result.user.profileImageUrl,
      coverImageUrl: result.user.coverImageUrl,
      walletAddress: result.user.walletAddress,
      profileComplete: result.user.profileComplete,
      hasUsername: result.user.hasUsername,
      hasBio: result.user.hasBio,
      hasProfileImage: result.user.hasProfileImage,
      nftTokenId: result.user.nftTokenId,
      referralCode: result.user.referralCode,
      referredBy: result.user.referredBy,
      reputationPoints: result.user.reputationPoints,
      pointsAwardedForProfile: result.user.pointsAwardedForProfile,
      hasTwitter: result.user.hasTwitter,
      twitterUsername: result.user.twitterUsername,
      createdAt: toISO(result.user.createdAt),
      updatedAt: toISO(result.user.updatedAt),
    },
    referral: result.referrerId
      ? {
          referrerId: result.referrerId,
          referralRecordId: result.referralRecordId,
        }
      : null,
    reputationAwarded: totalReputationAwarded,
    reputationBreakdown,
  });
});
