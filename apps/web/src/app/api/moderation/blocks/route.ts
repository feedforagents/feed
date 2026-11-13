/**
 * Moderation Blocks List API
 *
 * @route GET /api/moderation/blocks - Get blocked users
 * @access Authenticated
 *
 * @description
 * Returns list of users blocked by the current user with pagination support.
 * Includes blocked user details and block metadata.
 *
 * @openapi
 * /api/moderation/blocks:
 *   get:
 *     tags:
 *       - Moderation
 *     summary: Get blocked users
 *     description: Returns list of users blocked by current user
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
 *         description: Blocks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 blocks:
 *                   type: array
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * const { blocks } = await fetch('/api/moderation/blocks?limit=20', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 * ```
 */

import { authenticate, successResponse, withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { GetBlocksSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);

  const { searchParams } = new URL(request.url);
  const { limit, offset } = GetBlocksSchema.parse({
    limit: searchParams.get('limit') || '20',
    offset: searchParams.get('offset') || '0',
  });

  const allBlocks = await db.userBlock.findMany({
    where: { blockerId: authUser.userId },
    orderBy: { createdAt: 'desc' },
  });

  // Block rows can outlive the blocked user: the UserBlock table has no
  // foreign key to User and account deletion removes the user row
  // without removing blocks that point at it. Such orphaned blocks must
  // not count toward the total or consume a pagination slot, so resolve
  // targets first and page over the blocks whose user still exists.
  // (Resolving through a separate lookup also avoids the
  // include-with-select read, which fails for these relations.)
  const blockedUsers =
    allBlocks.length === 0
      ? []
      : await db.user.findMany({
          where: {
            id: { in: allBlocks.map((block) => block.blockedId) },
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
    blockedUsers.map((blockedUser) => [blockedUser.id, blockedUser])
  );

  const visibleBlocks = allBlocks.filter((block) =>
    userMap.has(block.blockedId)
  );
  const total = visibleBlocks.length;
  const blocks = visibleBlocks
    .slice(offset, offset + limit)
    .map((block) => ({ ...block, blocked: userMap.get(block.blockedId) }));

  return successResponse({
    blocks,
    pagination: {
      limit,
      offset,
      total,
    },
  });
});
