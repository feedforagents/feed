/**
 * Moderation Mutes List API
 *
 * @route GET /api/moderation/mutes - Get muted users
 * @access Authenticated
 *
 * @description
 * Returns list of users muted by the current user with pagination support.
 * Includes muted user details and mute metadata.
 *
 * @openapi
 * /api/moderation/mutes:
 *   get:
 *     tags:
 *       - Moderation
 *     summary: Get muted users
 *     description: Returns list of users muted by current user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Mutes retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 mutes:
 *                   type: array
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const { mutes } = await fetch('/api/moderation/mutes?limit=20', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import { authenticate, successResponse, withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { GetMutesSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const { limit, offset } = GetMutesSchema.parse({
    limit: searchParams.get('limit') || '20',
    offset: searchParams.get('offset') || '0',
  });

  const allMutes = await db.userMute.findMany({
    where: { muterId: authUser.userId },
    orderBy: { createdAt: 'desc' },
  });

  // Mute rows can outlive the muted user: the UserMute table has no
  // foreign key to User and account deletion removes the user row
  // without removing mutes that point at it. Such orphaned mutes must
  // not count toward the total or consume a pagination slot, so resolve
  // targets first and page over the mutes whose user still exists.
  // (Resolving through a separate lookup also avoids the
  // include-with-select read, which fails for these relations.)
  const mutedUsers =
    allMutes.length === 0
      ? []
      : await db.user.findMany({
          where: {
            id: { in: allMutes.map((mute) => mute.mutedId) },
          },
          select: {
            id: true,
            username: true,
            displayName: true,
            profileImageUrl: true,
            isActor: true,
          },
        });
  const userMap = new Map(
    mutedUsers.map((mutedUser) => [mutedUser.id, mutedUser])
  );

  const visibleMutes = allMutes.filter((mute) => userMap.has(mute.mutedId));
  const total = visibleMutes.length;
  const mutes = visibleMutes
    .slice(offset, offset + limit)
    .map((mute) => ({ ...mute, muted: userMap.get(mute.mutedId) }));

  return successResponse({
    mutes,
    pagination: {
      limit,
      offset,
      total,
    },
  });
});
