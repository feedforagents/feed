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
import { count, db, desc, eq, userMutes, users } from '@feed/db';
import { GetMutesSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const { limit, offset } = GetMutesSchema.parse({
    limit: searchParams.get('limit') || '20',
    offset: searchParams.get('offset') || '0',
  });

  // Apply target existence before counting and paging. Deleted targets leave
  // moderation edges behind; provisioned NPC User rows remain valid targets.
  const owned = eq(userMutes.muterId, authUser.userId);
  const [[totalRow], mutes] = await Promise.all([
    db
      .select({ total: count() })
      .from(userMutes)
      .innerJoin(users, eq(users.id, userMutes.mutedId))
      .where(owned),
    db
      .select({
        id: userMutes.id,
        muterId: userMutes.muterId,
        mutedId: userMutes.mutedId,
        reason: userMutes.reason,
        createdAt: userMutes.createdAt,
        muted: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          profileImageUrl: users.profileImageUrl,
          isActor: users.isActor,
        },
      })
      .from(userMutes)
      .innerJoin(users, eq(users.id, userMutes.mutedId))
      .where(owned)
      .orderBy(desc(userMutes.createdAt), desc(userMutes.id))
      .limit(limit)
      .offset(offset),
  ]);
  const total = totalRow?.total ?? 0;

  return successResponse({
    mutes,
    pagination: {
      limit,
      offset,
      total,
    },
  });
});
