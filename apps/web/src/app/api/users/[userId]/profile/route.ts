/**
 * User Profile API Route
 *
 * @description Retrieves comprehensive user profile information including stats, social connections, and account details
 *
 * @route GET /api/users/[userId]/profile
 * @access Public (no authentication required)
 *
 * @openapi
 * /api/users/{userId}/profile:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get user profile
 *     description: Retrieves comprehensive profile information for a specific user including stats, social connections, and account details
 *     operationId: getUserProfile
 *     parameters:
 *       - name: userId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *         example: "user_123abc"
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Unique user identifier
 *                     username:
 *                       type: string
 *                       description: Username
 *                     displayName:
 *                       type: string
 *                       description: Display name
 *                     bio:
 *                       type: string
 *                       nullable: true
 *                       description: User biography
 *                     profileImageUrl:
 *                       type: string
 *                       nullable: true
 *                       description: Profile image URL
 *                     coverImageUrl:
 *                       type: string
 *                       nullable: true
 *                       description: Cover image URL
 *                     walletAddress:
 *                       type: string
 *                       nullable: true
 *                       description: Blockchain wallet address
 *                     virtualBalance:
 *                       type: number
 *                       description: Virtual balance in game currency
 *                     lifetimePnL:
 *                       type: number
 *                       description: Lifetime profit and loss
 *                     reputationPoints:
 *                       type: integer
 *                       description: Reputation points earned
 *                     isActor:
 *                       type: boolean
 *                       description: Whether this is an NPC actor
 *                     profileComplete:
 *                       type: boolean
 *                       description: Whether profile setup is complete
 *                     hasTwitter:
 *                       type: boolean
 *                       description: Whether Twitter is linked
 *                     stats:
 *                       type: object
 *                       description: User statistics
 *                       properties:
 *                         positions:
 *                           type: integer
 *                           description: Number of open positions
 *                         comments:
 *                           type: integer
 *                           description: Total comments made
 *                         reactions:
 *                           type: integer
 *                           description: Total reactions given
 *                         followers:
 *                           type: integer
 *                           description: Number of followers
 *                         following:
 *                           type: integer
 *                           description: Number of users/actors following
 *                         posts:
 *                           type: integer
 *                           description: Total posts created
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

import {
  addPrivateReadHeaders,
  addPublicReadHeaders,
  getPublicUserProfile,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { sanitizeForJson } from '@/lib/json/sanitize';

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const { error, user, rateLimitInfo } = await publicRateLimit(request);
    if (error) return error;
    const { userId } = UserIdParamSchema.parse(await context.params);
    const profile = await getPublicUserProfile(userId, user?.userId);
    const response = successResponse(sanitizeForJson({ user: profile }));
    if (user) {
      if (rateLimitInfo) addPrivateReadHeaders(response, rateLimitInfo);
      else response.headers.set('Cache-Control', 'private, no-store');
    } else if (rateLimitInfo) addPublicReadHeaders(response, rateLimitInfo);
    return response;
  }
);
