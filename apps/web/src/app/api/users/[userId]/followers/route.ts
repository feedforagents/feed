/**
 * User Followers API
 *
 * @route GET /api/users/[userId]/followers - Get followers list
 * @access Public
 *
 * @description
 * Returns list of users and actors following the target user. Supports both
 * regular users and NPCs/actors.
 *
 * @openapi
 * /api/users/{userId}/followers:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get followers list
 *     description: Returns list of users/actors following the target user
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID, username, or wallet address
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Results per page
 *     responses:
 *       200:
 *         description: Followers list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 followers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       username:
 *                         type: string
 *                         nullable: true
 *                       profileImageUrl:
 *                         type: string
 *                         nullable: true
 *                       bio:
 *                         type: string
 *                       followedAt:
 *                         type: string
 *                         format: date-time
 *                       isActor:
 *                         type: boolean
 *                       tier:
 *                         type: string
 *                 count:
 *                   type: integer
 *                   description: Total number of relations (all pages)
 *                 hasMore:
 *                   type: boolean
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/users/user_123/followers');
 * const { followers, count } = await response.json();
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  optionalAuth,
  requireTargetByIdentifier,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  actorFollows,
  and,
  db,
  eq,
  followStatuses,
  follows,
  inArray,
  type SQL,
  sql,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import {
  toISO,
  UserFollowersQuerySchema,
  UserIdParamSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';

interface FollowerResponse {
  id: string;
  displayName: string;
  username: string | null;
  profileImageUrl: string | null;
  bio: string;
  followedAt: string;
  isActor: boolean;
  tier?: string;
  /** True when the authenticated viewer follows this entry. */
  viewerFollows?: boolean;
}

/** One page row of the merged relation sources. */
interface RelationRow {
  src: number;
  member_id: string;
  followed_at: string;
}

function sqlList(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  );
}

/**
 * Followers of an actor: registry actors (matched by id or lower-case
 * username, as StaticDataRegistry.getActor does) and users with a User row.
 * The human branch applies the hidden-tier membership every other
 * discovery surface uses: not a test account (isTest flag or 'test-' id)
 * and not banned. The predicate sits in the relation, before count and
 * paging, so totals and pages measure the same membership.
 */
function actorTargetRelations(targetId: string): SQL {
  const actors = StaticDataRegistry.getAllActors();
  const ids = actors.map((a) => a.id);
  const usernames = actors
    .map((a) => a.username?.toLowerCase())
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  const registryMatch =
    ids.length === 0
      ? sql`false`
      : usernames.length === 0
        ? sql`${actorFollows.followerId} IN (${sqlList(ids)})`
        : sql`(${actorFollows.followerId} IN (${sqlList(ids)}) OR lower(${actorFollows.followerId}) IN (${sqlList(usernames)}))`;
  return sql`
    SELECT 0 AS src, ${actorFollows.followerId} AS member_id,
      ${actorFollows.createdAt} AS followed_at, ${actorFollows.id} AS rel_id
    FROM ${actorFollows}
    WHERE ${actorFollows.followingId} = ${targetId} AND ${registryMatch}
    UNION ALL
    SELECT 1, ${userActorFollows.userId}, ${userActorFollows.createdAt}, ${userActorFollows.id}
    FROM ${userActorFollows}
    INNER JOIN ${users} ON ${users.id} = ${userActorFollows.userId}
    WHERE ${userActorFollows.actorId} = ${targetId}
      AND ${users.isTest} = false
      AND ${users.isBanned} = false
      AND ${users.id} NOT LIKE 'test-%'
  `;
}

/**
 * Followers of a user: users with a User row (same hidden-tier membership
 * as the actor target's human branch), and active NPC follows whose
 * reason is not 'user_followed' (NULL reasons stay excluded, as before).
 */
function userTargetRelations(targetId: string): SQL {
  return sql`
    SELECT 0 AS src, ${follows.followerId} AS member_id,
      ${follows.createdAt} AS followed_at, ${follows.id} AS rel_id
    FROM ${follows}
    INNER JOIN ${users} ON ${users.id} = ${follows.followerId}
    WHERE ${follows.followingId} = ${targetId}
      AND ${users.isTest} = false
      AND ${users.isBanned} = false
      AND ${users.id} NOT LIKE 'test-%'
    UNION ALL
    SELECT 1, ${followStatuses.npcId}, ${followStatuses.followedAt}, ${followStatuses.id}
    FROM ${followStatuses}
    WHERE ${followStatuses.userId} = ${targetId}
      AND ${followStatuses.isActive} = true
      AND NOT (${followStatuses.followReason} = 'user_followed')
  `;
}

/**
 * GET /api/users/[userId]/followers
 * Get list of users following the target user
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const authUser = await optionalAuth(request);
    const params = await context.params;
    const { userId: targetIdentifier } = UserIdParamSchema.parse(params);

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const { page, limit } = UserFollowersQuerySchema.parse({
      page: searchParams.get('page') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    });

    // Find target (user or actor) - throws NotFoundError if neither exists
    const { actor: targetActor, targetId } =
      await requireTargetByIdentifier(targetIdentifier);

    // Merge, order, count and page the relation rows in SQL; profiles are
    // loaded afterwards for the returned page only. Ties keep the previous
    // source order (actors before users for an actor target, users before
    // NPCs for a user target) and then the relation id.
    const offset = (page - 1) * limit;
    const relations = targetActor
      ? actorTargetRelations(targetId)
      : userTargetRelations(targetId);
    const [pageRows, countRows] = await Promise.all([
      db.execute(sql`
        SELECT src, member_id,
          to_char(followed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS followed_at
        FROM (${relations}) rel
        ORDER BY rel.followed_at DESC, src ASC, rel_id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`SELECT count(*)::int AS total FROM (${relations}) rel`),
    ]);
    const relationPage = pageRows as unknown as RelationRow[];
    const total = Number(
      (countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0
    );

    // Human source is 1 for an actor target and 0 for a user target.
    const humanSource = targetActor ? 1 : 0;
    const humanIds = relationPage
      .filter((r) => Number(r.src) === humanSource)
      .map((r) => r.member_id);
    const profiles =
      humanIds.length > 0
        ? await db
            .select({
              id: users.id,
              displayName: users.displayName,
              username: users.username,
              profileImageUrl: users.profileImageUrl,
              bio: users.bio,
            })
            .from(users)
            .where(inArray(users.id, humanIds))
        : [];
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    const followersList: FollowerResponse[] = relationPage.map((r) => {
      const followedAt = toISO(new Date(r.followed_at));
      if (Number(r.src) === humanSource) {
        const p = profileById.get(r.member_id);
        return {
          id: r.member_id,
          displayName: p?.displayName || '',
          username: p?.username || null,
          profileImageUrl: p?.profileImageUrl || null,
          bio: p?.bio || '',
          followedAt,
          isActor: false,
        };
      }
      // Actor followers of an actor target are registry members (id or
      // username) by the SQL filter; NPC followers of a user only use a
      // registry entry with that exact id and otherwise fall back to npcId.
      const found = StaticDataRegistry.getActor(r.member_id);
      const actor = targetActor || found?.id === r.member_id ? found : null;
      return {
        id: r.member_id,
        displayName: actor?.name || r.member_id,
        username: actor?.username || null,
        profileImageUrl: actor?.profileImageUrl || null,
        bio: actor?.description || '',
        followedAt,
        isActor: true,
        tier: actor?.tier || undefined,
      };
    });

    // Check if authenticated user follows each follower (for showing follow/unfollow button state)
    if (authUser?.userId) {
      const followerIds = followersList
        .filter((f) => !f.isActor)
        .map((f) => f.id);
      const actorFollowerIds = followersList
        .filter((f) => f.isActor)
        .map((f) => f.id);

      // Check which followers the authenticated user follows (using inArray for efficiency)
      const followedUserIds = new Set<string>();
      if (followerIds.length > 0) {
        const userFollowResults = await db
          .select({ followingId: follows.followingId })
          .from(follows)
          .where(
            and(
              eq(follows.followerId, authUser.userId),
              inArray(follows.followingId, followerIds)
            )
          );
        for (const f of userFollowResults) {
          followedUserIds.add(f.followingId);
        }
      }

      // Check actor follows (using inArray for efficiency)
      const followedActorIds = new Set<string>();
      if (actorFollowerIds.length > 0) {
        const actorFollowResults = await db
          .select({ actorId: userActorFollows.actorId })
          .from(userActorFollows)
          .where(
            and(
              eq(userActorFollows.userId, authUser.userId),
              inArray(userActorFollows.actorId, actorFollowerIds)
            )
          );
        for (const f of actorFollowResults) {
          followedActorIds.add(f.actorId);
        }
      }

      // Add viewerFollows to each follower (true if auth user follows them)
      for (const follower of followersList) {
        follower.viewerFollows = follower.isActor
          ? followedActorIds.has(follower.id)
          : followedUserIds.has(follower.id);
      }
    }

    return successResponse({
      followers: followersList,
      count: total,
      hasMore: offset + followersList.length < total,
    });
  }
);
