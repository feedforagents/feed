/**
 * User Search API
 *
 * @description
 * Search for users by username or display name with fuzzy matching.
 * Returns real users only by default (excludes NPCs, agents, banned users, test users, and current user).
 * Designed for user mention autocomplete, friend finding, and social discovery.
 *
 * **Features:**
 * - Case-insensitive search
 * - Matches username OR display name
 * - Excludes current user (no self-mentions)
 * - Excludes NPCs/actors by default
 * - Excludes agents by default (use includeAgents=true to include)
 * - Excludes banned users
 * - Excludes test users (isTest flag or 'test-' id prefix)
 * - Limits to 20 results per offset window (performance)
 * - Alphabetically sorted results
 *
 * **Search Behavior:**
 * - Minimum 2 characters required
 * - Substring matching (contains)
 * - Searches both username and display name fields
 * - Returns empty array if query too short
 *
 * **Use Cases:**
 * - User mention autocomplete (@username)
 * - Friend search
 * - DM recipient selection
 * - Group chat member addition
 * - Follow/unfollow user search
 *
 * @openapi
 * /api/users/search:
 *   get:
 *     tags:
 *       - Users
 *     summary: Search for users
 *     description: Search for users by username or display name (min 2 chars, max 20 results)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search query (username or display name)
 *         example: alice
 *       - in: query
 *         name: includeAgents
 *         required: false
 *         schema:
 *           type: boolean
 *         description: Include AI agents in results (default false)
 *         example: false
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Skip ranked matches before the 20-result window (default 0)
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       profileImageUrl:
 *                         type: string
 *                       bio:
 *                         type: string
 *                       isAgent:
 *                         type: boolean
 *                         description: Present when includeAgents=true, indicates if this is a user-created agent
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Search for users
 * const response = await fetch('/api/users/search?q=alice', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 * const { users } = await response.json();
 *
 * // Display in autocomplete
 * users.forEach(user => {
 *   console.log(`@${user.username} - ${user.displayName}`);
 * });
 *
 * // Include agents in search
 * const withAgents = await fetch('/api/users/search?q=alice&includeAgents=true');
 *
 * // Too short query
 * const empty = await fetch('/api/users/search?q=a');
 * // Returns { users: [] }
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 * @see {@link /src/components/MentionAutocomplete} Autocomplete UI
 */

import {
  addPrivateReadHeaders,
  authenticate,
  publicRateLimit,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  asc,
  asUser,
  eq,
  getBlockedByUserIds,
  getBlockedUserIds,
  getMutedUserIds,
  ilike,
  not,
  notInArray,
  or,
  sql,
  users,
} from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/users/search
 * Search for users by username or display name
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const user = await authenticate(request);

  // Get query parameters
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeAgents = searchParams.get('includeAgents') === 'true';
  const parsedOffset = Number.parseInt(searchParams.get('offset') ?? '', 10);
  const offset =
    Number.isSafeInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  if (!query || query.trim().length < 2) {
    const res = successResponse({ users: [] });
    if (rateLimitInfo) addPrivateReadHeaders(res, rateLimitInfo);
    else res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }

  const rawSearchTerm = query.trim();
  const searchTerm = rawSearchTerm.toLowerCase();

  // Get blocked/muted users to exclude from search
  const [blockedIds, mutedIds, blockedByIds] = await Promise.all([
    getBlockedUserIds(user.userId),
    getMutedUserIds(user.userId),
    getBlockedByUserIds(user.userId),
  ]);

  const excludedUserIds = [...blockedIds, ...mutedIds, ...blockedByIds];

  // Match the adapter's literal LIKE escaping and retain its distinct case-folding inputs.
  const escapeLike = (value: string) =>
    value.replace(/[\\%_]/g, (char) => `\\${char}`);
  const usersFound = await asUser(user, async (db) => {
    const exact = sql`lower(${users.username}) = lower(${rawSearchTerm})`;
    const prefix = or(
      ilike(users.username, `${escapeLike(rawSearchTerm)}%`),
      ilike(users.displayName, `${escapeLike(rawSearchTerm)}%`)
    );
    const contains = or(
      ilike(users.username, `%${escapeLike(searchTerm)}%`),
      ilike(users.displayName, `%${escapeLike(rawSearchTerm)}%`)
    );
    const rank = sql`CASE WHEN ${exact} THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END`;

    return (
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          profileImageUrl: users.profileImageUrl,
          bio: users.bio,
          ...(includeAgents && { isAgent: users.isAgent }),
        })
        .from(users)
        .where(
          and(
            notInArray(users.id, [user.userId, ...excludedUserIds]),
            eq(users.isActor, false),
            ...(includeAgents ? [] : [eq(users.isAgent, false)]),
            eq(users.isBanned, false),
            eq(users.isTest, false),
            not(sql`${users.id} LIKE ${'test-%'}`),
            or(exact, prefix, contains)
          )
        )
        // Keep username ASC / NULLS LAST; id makes otherwise tied pages deterministic.
        .orderBy(rank, asc(users.username), asc(users.id))
        .limit(20)
        .offset(offset)
    );
  });

  logger.info(
    'User search completed',
    {
      userId: user.userId,
      query: searchTerm,
      results: usersFound.length,
      includeAgents,
    },
    'GET /api/users/search'
  );

  const res = successResponse({
    users: usersFound,
  });
  if (rateLimitInfo) addPrivateReadHeaders(res, rateLimitInfo);
  else res.headers.set('Cache-Control', 'private, no-store');
  return res;
});
