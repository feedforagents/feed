/**
 * Group Invites API
 *
 * @route GET /api/groups/invites - Get pending group invites
 * @access Authenticated
 */

import { authenticate, successResponse, withErrorHandling } from '@feed/api';
import {
  and,
  asUser,
  count,
  eq,
  groupMembers,
  inArray,
  like,
  not,
  users,
} from '@feed/db';
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

    // A block or mute hides the invite at read time, mirroring the
    // notification list (GET /api/notifications) and the unread count.
    // The notification for a blocked inviter is already suppressed at
    // creation, but the invite row itself is not — without this filter
    // the invite still reaches the invitee's list and can be accepted.
    const [blockedByMe, mutedByMe, blockedMe] = await Promise.all([
      db.userBlock.findMany({
        where: { blockerId: user.userId },
        select: { blockedId: true },
      }),
      db.userMute.findMany({
        where: { muterId: user.userId },
        select: { mutedId: true },
      }),
      db.userBlock.findMany({
        where: { blockedId: user.userId },
        select: { blockerId: true },
      }),
    ]);
    const hiddenInviters = new Set([
      ...blockedByMe.map((row) => row.blockedId),
      ...mutedByMe.map((row) => row.mutedId),
      ...blockedMe.map((row) => row.blockerId),
    ]);
    const visibleInvites = pendingInvites.filter(
      (invite) => !hiddenInviters.has(invite.invitedBy)
    );

    if (visibleInvites.length === 0) {
      return [];
    }

    // Fetch group details
    const groupIds = [...new Set(visibleInvites.map((inv) => inv.groupId))];
    const groups = await db.group.findMany({
      where: {
        id: { in: groupIds },
      },
    });

    // Aggregate only visible active memberships for the groups being returned.
    const memberCounts =
      groupIds.length > 0
        ? await db
            .select({ groupId: groupMembers.groupId, memberCount: count() })
            .from(groupMembers)
            .innerJoin(users, eq(users.id, groupMembers.userId))
            .where(
              and(
                inArray(groupMembers.groupId, groupIds),
                eq(groupMembers.isActive, true),
                eq(users.isTest, false),
                eq(users.isBanned, false),
                not(like(users.id, 'test-%'))
              )
            )
            .groupBy(groupMembers.groupId)
        : [];
    const memberCountMap = new Map(
      memberCounts.map((row) => [row.groupId, row.memberCount])
    );
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return visibleInvites.map((invite) => {
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
