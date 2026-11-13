/**
 * Actor Statistics API
 *
 * @route GET /api/actors/[actorId]/stats
 * @access Public
 *
 * @description
 * Returns comprehensive statistics for a specific actor (NPC), including follower
 * counts (from both ActorFollow and UserActorFollow), following count, and post count.
 * Supports lookup by actor ID or name (case-insensitive).
 *
 * @openapi
 * /api/actors/{actorId}/stats:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get actor statistics
 *     description: Returns follower counts, following count, and post count for a specific actor. Supports lookup by ID or name.
 *     parameters:
 *       - in: path
 *         name: actorId
 *         required: true
 *         schema:
 *           type: string
 *         description: Actor ID or name (case-insensitive)
 *     responses:
 *       200:
 *         description: Actor statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     followers:
 *                       type: integer
 *                       description: Total followers (actors + users)
 *                     following:
 *                       type: integer
 *                       description: Number of actors this actor follows
 *                     posts:
 *                       type: integer
 *                       description: Total posts by this actor
 *                     actorFollowers:
 *                       type: integer
 *                       description: Followers who are NPCs
 *                     userFollowers:
 *                       type: integer
 *                       description: Followers who are users
 *       404:
 *         description: Actor not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *
 * @param {string} actorId - Actor ID or name (path parameter)
 *
 * @returns {Promise<NextResponse>} Actor statistics including followers, following, and posts
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/actors/actor_123/stats');
 * const { stats } = await response.json();
 * console.log(stats.followers); // Total follower count
 * ```
 *
 * @see {@link @feed/api} Error handling utilities
 */

import {
  BusinessLogicError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  count,
  db,
  eq,
  like,
  not,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/actors/[actorId]/stats
 *
 * @description Get actor statistics (followers, following, posts)
 *
 * @param {NextRequest} _request - Request object
 * @param {Promise<{actorId: string}>} context.params - Route parameters
 *
 * @returns {Promise<NextResponse>} Actor statistics
 */
export const GET = withErrorHandling(
  async (
    _request: NextRequest,
    context: { params: Promise<{ actorId: string }> }
  ) => {
    const params = await context.params;
    const { actorId } = params;

    // Try to find actor by ID first, then by name (case-insensitive)
    let actor = StaticDataRegistry.getActor(actorId);

    // If not found by ID, try finding by name
    if (!actor) {
      actor =
        StaticDataRegistry.getAllActors().find(
          (a) => a.name.toLowerCase() === actorId.toLowerCase()
        ) ?? null;
    }

    // Organization profiles are keyed by organization ID, but their social
    // graph lives on the organization's shadow actor (`org-<id>`). Resolve
    // the organization ID to that actor so the header counts agree with the
    // follow lists for every organization.
    if (!actor) {
      const organization = StaticDataRegistry.getOrganization(actorId);
      if (organization) {
        actor = StaticDataRegistry.getActor(`org-${organization.id}`);
      }
    }

    if (!actor) {
      throw new BusinessLogicError(`Actor ${actorId} not found`, 'NOT_FOUND');
    }

    const actualActorId = actor.id;

    // Get follower counts (both from ActorFollow and UserActorFollow)
    const [
      actorFollowerCount,
      userActorFollowerCount,
      followingCount,
      postCount,
    ] = await Promise.all([
      // NPCs following this actor (ActorFollow)
      db.actorFollow.count({
        where: { followingId: actualActorId },
      }),
      // Users following this actor (UserActorFollow), counting only the
      // visible membership: the actor followers list hides hidden account
      // tiers (test accounts: isTest flag or 'test-' id; banned accounts),
      // so the header count must use the same membership or the number
      // and the list disagree on the same profile screen.
      db
        .select({ count: count() })
        .from(userActorFollows)
        .innerJoin(users, eq(userActorFollows.userId, users.id))
        .where(
          and(
            eq(userActorFollows.actorId, actualActorId),
            eq(users.isTest, false),
            eq(users.isBanned, false),
            not(like(users.id, 'test-%'))
          )
        )
        .then((rows) => Number(rows[0]?.count ?? 0)),
      // This actor following others (only NPC-to-NPC follows via ActorFollow)
      db.actorFollow.count({
        where: { followerId: actualActorId },
      }),
      // Visible posts by this actor: not deleted and already published
      // (future-scheduled posts must not be counted or hinted at).
      db.post.count({
        where: {
          authorId: actualActorId,
          deletedAt: null,
          timestamp: { lte: new Date() },
        },
      }),
    ]);

    const totalFollowers = actorFollowerCount + userActorFollowerCount;

    logger.info(
      'Actor stats fetched successfully',
      {
        actorId,
        actualActorId,
        totalFollowers,
        actorFollowerCount,
        userActorFollowerCount,
        followingCount,
      },
      'GET /api/actors/[actorId]/stats'
    );

    return successResponse({
      stats: {
        followers: totalFollowers,
        following: followingCount,
        posts: postCount,
        actorFollowers: actorFollowerCount,
        userFollowers: userActorFollowerCount,
      },
    });
  }
);
