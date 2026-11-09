/**
 * Chat Participants API
 *
 * @route GET /api/chats/[id]/participants - Get chat participants
 * @route POST /api/chats/[id]/participants - Add users to chat
 * @access Authenticated (participants only)
 *
 * @description
 * Manages chat participants. GET returns list of participants, POST adds new
 * users to a group chat. Includes automatic notifications for new participants.
 *
 * @openapi
 * /api/chats/{id}/participants:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get chat participants
 *     description: Returns list of users participating in the chat
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     responses:
 *       200:
 *         description: Participants retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 participants:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       chatId:
 *                         type: string
 *                       joinedAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a chat participant
 *       404:
 *         description: Chat not found
 *   post:
 *     tags:
 *       - Chats
 *     summary: Add users to chat
 *     description: Adds one or more users to a group chat
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userIds
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of user IDs to add
 *     responses:
 *       201:
 *         description: Users added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 participants:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not authorized to add participants
 *       404:
 *         description: Chat or user not found
 *
 * @example
 * ```typescript
 * // Get participants
 * const response = await fetch(`/api/chats/${chatId}/participants`, {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * });
 *
 * // Add participants
 * await fetch(`/api/chats/${chatId}/participants`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     userIds: ['user1', 'user2']
 *   })
 * });
 * ```
 *
 * @see {@link /lib/services/notification-service} Notification service
 */

import {
  authenticate,
  BusinessLogicError,
  NotFoundError,
  notifyGroupChatInvite,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { asSystem, asUser } from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const AddParticipantsSchema = z.object({
  userIds: z.array(z.string().min(1).max(128)).min(1).max(50),
});

async function loadChatWithParticipants(
  user: Awaited<ReturnType<typeof authenticate>>,
  chatId: string
) {
  return asUser(user, async (db) => {
    const [chat, participants] = await Promise.all([
      db.chat.findUnique({
        where: { id: chatId },
      }),
      db.chatParticipant.findMany({
        where: { chatId },
        select: {
          id: true,
          chatId: true,
          userId: true,
          joinedAt: true,
          isActive: true,
        },
      }),
    ]);

    if (!chat) {
      throw new NotFoundError('Chat', chatId);
    }

    return {
      ...chat,
      participants,
    };
  });
}

/**
 * POST /api/chats/[id]/participants
 * Add users to a group chat
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);
    const { id: chatId } = await context.params;

    if (!chatId) {
      throw new BusinessLogicError('Chat ID is required', 'CHAT_ID_REQUIRED');
    }

    // Validate request body
    const parsedBody = AddParticipantsSchema.safeParse(await request.json());
    if (!parsedBody.success) {
      throw new BusinessLogicError(
        'userIds must be a non-empty array of user IDs (max 50)',
        'USER_IDS_REQUIRED'
      );
    }
    const userIds = [...new Set(parsedBody.data.userIds)];

    // Check if chat exists and user is an active participant
    const chat = await loadChatWithParticipants(user, chatId);

    const isParticipant = (chat.participants || []).some(
      (p) => p.userId === user.userId && p.isActive
    );

    if (!isParticipant) {
      throw new BusinessLogicError(
        'You must be a participant to invite others',
        'NOT_PARTICIPANT'
      );
    }

    if (!chat.isGroup) {
      await asUser(user, async (db) => {
        await db.chat.update({
          where: { id: chatId },
          data: {
            isGroup: true,
            name: 'Group Chat',
            updatedAt: new Date(),
          },
        });
      });
    }

    // Verify all users exist and add them to the chat
    const addedUsers = await asSystem(async (db) => {
      // Verify users exist and are not actors
      const usersToAdd = await db.user.findMany({
        where: {
          id: { in: userIds },
          isActor: false,
          isBanned: false,
        },
        select: {
          id: true,
          displayName: true,
          username: true,
          profileImageUrl: true,
        },
      });

      if (usersToAdd.length === 0) {
        throw new BusinessLogicError('No valid users to add', 'NO_VALID_USERS');
      }

      // Filter out users already in the chat
      const existingParticipantIds = (chat.participants || []).map(
        (p) => p.userId
      );
      const newUsers = usersToAdd.filter(
        (u) => !existingParticipantIds.includes(u.id)
      );

      if (newUsers.length === 0) {
        throw new BusinessLogicError(
          'All users are already in the chat',
          'ALREADY_PARTICIPANTS'
        );
      }

      // Add new participants
      await Promise.all(
        newUsers.map(async (newUser) =>
          db.chatParticipant.create({
            data: {
              id: await generateSnowflakeId(),
              chatId,
              userId: newUser.id,
            },
          })
        )
      );

      // Get updated chat info (including groupId for notification linking)
      const updatedChat = await db.chat.findUnique({
        where: { id: chatId },
        select: {
          id: true,
          name: true,
          isGroup: true,
          groupId: true,
        },
      });

      // Send notifications to invited users
      await Promise.all(
        newUsers.map((newUser) =>
          notifyGroupChatInvite(
            newUser.id,
            user.userId,
            updatedChat?.groupId,
            updatedChat?.name || 'a group chat'
          )
        )
      );

      logger.info(
        'Users added to chat',
        {
          chatId,
          addedBy: user.userId,
          addedUsers: newUsers.map((u) => u.id),
        },
        'POST /api/chats/[id]/participants'
      );

      return { addedUsers: newUsers };
    });

    return successResponse({
      message: `Added ${addedUsers.addedUsers.length} user(s) to the chat`,
      data: {
        chatId,
        addedUsers: addedUsers.addedUsers.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          username: u.username,
          profileImageUrl: u.profileImageUrl,
        })),
      },
    });
  }
);

/**
 * GET /api/chats/[id]/participants
 * Get all participants in a chat
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const user = await authenticate(request);
    const { id: chatId } = await context.params;

    if (!chatId) {
      throw new BusinessLogicError('Chat ID is required', 'CHAT_ID_REQUIRED');
    }

    // Get chat participants
    const chat = await loadChatWithParticipants(user, chatId);
    const isParticipant = (chat.participants || []).some(
      (p) => p.userId === user.userId && p.isActive
    );

    if (!isParticipant) {
      throw new BusinessLogicError(
        'You must be a participant to view participants',
        'NOT_PARTICIPANT'
      );
    }

    // Only current participants are listed: a member moved out of the
    // chat (e.g. a tier demotion) keeps an isActive=false row, and this
    // route's own access check above already treats that as "not a
    // participant" — the returned list must apply the same rule.
    const userIds = (chat.participants || [])
      .filter((p) => p.isActive)
      .map((p) => p.userId);
    const participants = await asUser(user, async (db) => {
      return db.user.findMany({
        where: {
          id: { in: userIds },
        },
        select: {
          id: true,
          displayName: true,
          username: true,
          profileImageUrl: true,
        },
      });
    });

    logger.info(
      'Chat participants fetched',
      { chatId, participantCount: participants.length },
      'GET /api/chats/[id]/participants'
    );

    return successResponse({
      participants,
    });
  }
);
