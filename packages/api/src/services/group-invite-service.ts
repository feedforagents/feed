/**
 * Group invite transitions (accept / decline).
 *
 * Canonical implementation shared by the HTTP routes, the A2A executor and
 * the MCP tool handlers so every transport applies the same rules.
 *
 * Concurrency: the invite is claimed first with a conditional UPDATE
 * (status = 'pending'), inside the same transaction as the membership writes.
 * Concurrent accept/decline of one invite therefore serialize on the invite
 * row; exactly one transition wins and the others fail with "already
 * processed". Any later failure rolls the claim back.
 */

import {
  asUser,
  chatParticipants,
  type DrizzleClient,
  generateSnowflakeId,
  groupMembers,
  sql,
} from '@feed/db';
import { GROUP_CONFIG } from '@feed/shared';
import { ApiError } from '../errors';

type InviteStatus = 'accepted' | 'declined';

/**
 * Atomically move a pending invite owned by `userId` to `status`.
 * Throws the precise ApiError when the claim fails.
 */
async function claimPendingInvite(
  db: DrizzleClient,
  userId: string,
  inviteId: string,
  status: InviteStatus
): Promise<{ groupId: string; invitedBy: string | null }> {
  const claimed = await db.groupInvite.updateMany({
    where: { id: inviteId, invitedUserId: userId, status: 'pending' },
    data: { status, respondedAt: new Date() },
  });

  const invite = await db.groupInvite.findUnique({
    where: { id: inviteId },
  });

  if (claimed.count === 1 && invite) {
    return { groupId: invite.groupId, invitedBy: invite.invitedBy };
  }
  if (!invite) {
    throw new ApiError('Invite not found', 404);
  }
  if (invite.invitedUserId !== userId) {
    throw new ApiError('This invite is not for you', 403);
  }
  throw new ApiError('This invite has already been processed', 400);
}

async function markInviteNotificationRead(
  db: DrizzleClient,
  userId: string,
  inviteId: string
): Promise<void> {
  await db.notification.updateMany({
    where: { userId, type: 'group_invite', inviteId },
    data: { read: true },
  });
}

/**
 * Accept a group invite: claim the invite, (re)activate group membership and
 * chat participation, post the join system message and mark the invite
 * notification read — all in one transaction.
 */
export async function acceptGroupInvite(
  userId: string,
  inviteId: string
): Promise<{ groupId: string; chatId: string | null }> {
  return asUser(userId, async (db) => {
    const invite = await claimPendingInvite(db, userId, inviteId, 'accepted');

    // Both invite-creating entry points refuse banned users, but a ban can
    // land after the invite was sent and the ban write does not touch
    // pending invites. Accept is the step that grants membership, so the
    // ban is re-checked here; throwing rolls the invite claim back and the
    // invite stays pending.
    const acceptingUser = await db.user.findUnique({
      where: { id: userId },
      select: { isBanned: true },
    });
    if (acceptingUser?.isBanned) {
      throw new ApiError('Cannot accept a group invite while banned', 400);
    }

    const invitedGroup = await db.group.findUnique({
      where: { id: invite.groupId },
      select: { type: true },
    });
    if (!invitedGroup) {
      throw new ApiError('Group not found', 404);
    }

    // Only NPC groups count toward the active-membership limit.
    if (invitedGroup.type === 'npc') {
      const activeMemberships = await db.groupMember.findMany({
        where: { userId, isActive: true },
      });
      const groupIds = activeMemberships.map((m) => m.groupId);
      const memberGroups =
        groupIds.length > 0
          ? await db.group.findMany({
              where: { id: { in: groupIds } },
              select: { id: true, type: true },
            })
          : [];
      const npcGroupCount = memberGroups.filter((g) => g.type === 'npc').length;
      if (npcGroupCount >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
        throw new ApiError(
          `You can only be in ${GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS} NPC groups at a time. Leave a group first.`,
          400
        );
      }
    }

    const existingActiveMember = await db.groupMember.findFirst({
      where: { groupId: invite.groupId, userId, isActive: true },
    });
    if (existingActiveMember) {
      throw new ApiError('You are already a member of this group', 400);
    }

    const groupChat = await db.chat.findFirst({
      where: { groupId: invite.groupId },
      select: { id: true },
    });

    const now = new Date();
    await db
      .insert(groupMembers)
      .values({
        id: await generateSnowflakeId(),
        groupId: invite.groupId,
        userId,
        role: 'member',
        addedBy: invite.invitedBy,
        joinedAt: now,
        isActive: true,
        messageCount: 0,
        qualityScore: 1.0,
      })
      .onConflictDoUpdate({
        target: [groupMembers.groupId, groupMembers.userId],
        set: {
          isActive: true,
          role: 'member',
          addedBy: invite.invitedBy,
          joinedAt: now,
          kickedAt: sql`NULL`,
          kickReason: sql`NULL`,
        },
      });

    if (groupChat) {
      await db
        .insert(chatParticipants)
        .values({
          id: await generateSnowflakeId(),
          chatId: groupChat.id,
          userId,
          joinedAt: now,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [chatParticipants.chatId, chatParticipants.userId],
          set: { isActive: true, joinedAt: now },
        });

      const joiningUser = await db.user.findUnique({
        where: { id: userId },
        select: { displayName: true, username: true },
      });
      const joinerName =
        joiningUser?.displayName || joiningUser?.username || 'Someone';
      await db.message.create({
        data: {
          id: await generateSnowflakeId(),
          chatId: groupChat.id,
          senderId: 'system',
          type: 'system',
          content: `${joinerName} joined the group`,
          createdAt: now,
        },
      });
    }

    await markInviteNotificationRead(db, userId, inviteId);

    return { groupId: invite.groupId, chatId: groupChat?.id ?? null };
  });
}

/**
 * Decline a group invite and mark its notification read.
 */
export async function declineGroupInvite(
  userId: string,
  inviteId: string
): Promise<void> {
  await asUser(userId, async (db) => {
    await claimPendingInvite(db, userId, inviteId, 'declined');
    await markInviteNotificationRead(db, userId, inviteId);
  });
}
