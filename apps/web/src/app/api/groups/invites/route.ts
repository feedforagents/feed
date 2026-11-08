/**
 * Group Invites API
 *
 * @route GET /api/groups/invites - Get pending group invites
 * @access Authenticated
 */

import { authenticate, successResponse, withErrorHandling } from '@feed/api';
import { asUser } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

/**
 * GET /api/groups/invites
 * Get all pending group invites for the current user
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  const invites = await asUser(user, async (db) => {
    // Get pending invites
    const pendingInvites = await db.groupInvite.findMany({
      where: {
        invitedUserId: user.userId,
        status: 'pending',
      },
      orderBy: {
        invitedAt: 'desc',
      },
    });

    if (pendingInvites.length === 0) {
      return [];
    }

    // Fetch group details
    const groupIds = pendingInvites.map((inv) => inv.groupId);
    const groups = await db.group.findMany({
      where: {
        id: { in: groupIds },
      },
    });

    // Get member counts for each group. The count must use the same
    // membership the member roster shows: hidden account tiers never
    // appear on people surfaces (test accounts: isTest flag or 'test-'
    // id; banned accounts), so memberships held by those accounts — or
    // by a user row that no longer exists — are not counted.
    const activeMemberships =
      groupIds.length > 0
        ? await db.groupMember.findMany({
            where: { groupId: { in: groupIds }, isActive: true },
            select: { groupId: true, userId: true },
          })
        : [];
    const memberUserIds = [...new Set(activeMemberships.map((m) => m.userId))];
    const memberUsers =
      memberUserIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: memberUserIds } },
            select: { id: true, isTest: true, isBanned: true },
          })
        : [];
    const visibleMemberIds = new Set(
      memberUsers
        .filter((u) => !u.isTest && !u.isBanned && !u.id.startsWith('test-'))
        .map((u) => u.id)
    );
    const memberCountMap = new Map(
      groupIds.map((gid) => [
        gid,
        activeMemberships.filter(
          (m) => m.groupId === gid && visibleMemberIds.has(m.userId)
        ).length,
      ])
    );
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return pendingInvites.map((invite) => {
      const group = groupMap.get(invite.groupId);
      return {
        inviteId: invite.id,
        groupId: invite.groupId,
        groupName: group?.name || 'Unknown Group',
        groupDescription: group?.description,
        groupType: group?.type,
        memberCount: memberCountMap.get(invite.groupId) ?? 0,
        invitedAt: invite.invitedAt,
        invitedBy: invite.invitedBy,
        message: invite.message,
      };
    });
  });

  logger.info(
    'Group invites retrieved',
    { userId: user.userId, inviteCount: invites.length },
    'GET /api/groups/invites'
  );

  return successResponse({ invites });
});
