/**
 * Chat Message API
 *
 * @route POST /api/chats/[id]/message - Send message to chat
 * @access Authenticated
 *
 * @description
 * Sends a message to a group chat or DM with comprehensive quality checks, rate
 * limiting, duplicate detection, and game mechanics integration. Includes group
 * chat sweep mechanics, invite chances, and automatic notifications.
 *
 * @openapi
 * /api/chats/{id}/message:
 *   post:
 *     tags:
 *       - Chats
 *     summary: Send chat message
 *     description: Sends a message to a group chat or DM with quality checks and rate limiting
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
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 minLength: 1
 *                 description: Message content
 *               replyToMessageId:
 *                 type: string
 *                 description: Optional ID of the message being replied to
 *     responses:
 *       201:
 *         description: Message sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     content:
 *                       type: string
 *                     chatId:
 *                       type: string
 *                     authorId:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                 quality:
 *                   type: object
 *                 sweep:
 *                   type: object
 *       400:
 *         description: Quality check failed or rate limit exceeded
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a chat participant or blocked user
 *       404:
 *         description: Chat not found
 *       429:
 *         description: Rate limit exceeded
 *
 * @example
 * ```typescript
 * const response = await fetch(`/api/chats/${chatId}/message`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     content: 'Hello everyone!'
 *   })
 * });
 * const { message, quality } = await response.json();
 * ```
 *
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  broadcastChatMessage,
  checkProgress,
  checkRateLimitAndDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
  notifyDMMessage,
  notifyGroupChatMessage,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, asUser, db, eq, hasBlocked, messages, users } from '@feed/db';
import {
  GroupChatService,
  MessageQualityChecker,
  type SweepDecision,
} from '@feed/engine';
import {
  ChatMessageCreateSchema,
  generateSnowflakeId,
  logger,
  toISO,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';
import { getOtherDmParticipantId } from '../../_lib/dm-chat-id';

/**
 * POST /api/chats/[id]/message
 *
 * Sends a message to a group chat or DM with quality checks and rate limiting.
 *
 * @param request - Next.js request containing message content
 * @param context - Route context with chat ID parameter
 * @returns Created message with quality metrics and sweep results
 */
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    // 1. Authenticate user
    const user = await authenticate(request);
    const { id: chatId } = await context.params;

    if (!chatId) {
      throw new BusinessLogicError('Chat ID is required', 'CHAT_ID_REQUIRED');
    }

    // 2. Validate request body
    const body = await request.json();
    const { content, replyToMessageId } = ChatMessageCreateSchema.parse(body);

    // 3. Apply rate limiting and duplicate detection
    const rateLimitError = await checkRateLimitAndDuplicates(
      user.userId,
      content,
      RATE_LIMIT_CONFIGS.SEND_MESSAGE,
      DUPLICATE_DETECTION_CONFIGS.MESSAGE
    );
    if (rateLimitError) {
      return rateLimitError;
    }

    // 4. Determine chat type and check membership
    const chatData = await asUser(user, async (db) => {
      const [chat, participants] = await Promise.all([
        db.chat.findUnique({
          where: { id: chatId },
        }),
        db.chatParticipant.findMany({
          // Retain departed peers for DM identity and block checks. Active
          // membership and notification eligibility are checked separately.
          where: { chatId: { equals: chatId } },
        }),
      ]);
      return { chat, participants };
    });

    let chat = chatData?.chat || null;
    let chatParticipantsList = chatData?.participants || [];

    // If chat doesn't exist and it's a DM format, create it automatically
    if (!chat && chatId.startsWith('dm-')) {
      const otherUserId = getOtherDmParticipantId(chatId, user.userId);

      if (!otherUserId) {
        throw new BusinessLogicError(
          'Invalid DM chat participants',
          'INVALID_DM_PARTICIPANTS'
        );
      }

      // Create the DM chat
      const chatDataResult = await asUser(user, async (db) => {
        // Verify other user exists and is not an actor
        const otherUser = await db.user.findUnique({
          where: { id: otherUserId },
          select: { id: true, isActor: true },
        });

        if (!otherUser) {
          throw new BusinessLogicError(
            'Other user not found',
            'USER_NOT_FOUND'
          );
        }

        if (otherUser.isActor) {
          throw new BusinessLogicError(
            'Cannot DM actors/NPCs',
            'CANNOT_DM_ACTOR'
          );
        }

        // Create the chat
        const now = new Date();
        await db.chat.create({
          data: {
            id: chatId,
            name: null,
            isGroup: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        // Add both participants
        await Promise.all([
          db.chatParticipant.create({
            data: {
              id: await generateSnowflakeId(),
              chatId,
              userId: user.userId,
            },
          }),
          db.chatParticipant.create({
            data: {
              id: await generateSnowflakeId(),
              chatId,
              userId: otherUserId,
            },
          }),
        ]);

        // Reload chat and get participants separately
        const [reloadedChat, reloadedParticipants] = await Promise.all([
          db.chat.findUnique({
            where: { id: chatId },
          }),
          db.chatParticipant.findMany({
            where: { chatId },
          }),
        ]);

        return { chat: reloadedChat, participants: reloadedParticipants };
      });

      // Update chat and participants from reloaded data
      if (
        chatDataResult &&
        typeof chatDataResult === 'object' &&
        'chat' in chatDataResult &&
        chatDataResult.chat
      ) {
        chat = chatDataResult.chat;
        chatParticipantsList = chatDataResult.participants || [];
      }
    }

    if (!chat) {
      throw new BusinessLogicError('Chat not found', 'CHAT_NOT_FOUND');
    }

    // Continuous game chats are NPC-driven and have no user message
    // pipeline; reject instead of fabricating an unpersisted message.
    if (chat.isGroup && chat.gameId === 'continuous') {
      throw new BusinessLogicError(
        'Sending messages to game chats is not supported',
        'GAME_CHAT_READ_ONLY'
      );
    }

    // Determine chat type
    const isDMChat = !chat.isGroup;
    const isGroupChat = chat.isGroup;

    // Check membership
    let isMember = true;
    // For DMs, check ChatParticipant
    if (isDMChat) {
      isMember = chatParticipantsList.some(
        (p) => p.userId === user.userId && p.isActive
      );
      if (!isMember) {
        throw new AuthorizationError(
          'You are not a participant in this DM',
          'chat',
          'write'
        );
      }

      // Check if the other participant is an NPC or has blocked the user
      const otherParticipant = chatParticipantsList.find(
        (p) => p.userId !== user.userId
      );
      if (otherParticipant) {
        const [otherUser, isBlocked, hasBlockedMe] = await Promise.all([
          db
            .select({ isActor: users.isActor })
            .from(users)
            .where(eq(users.id, otherParticipant.userId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          hasBlocked(user.userId, otherParticipant.userId),
          hasBlocked(otherParticipant.userId, user.userId),
        ]);

        if (otherUser?.isActor) {
          throw new BusinessLogicError(
            'Cannot send direct messages to NPC actors. Use group chats to interact with NPCs.',
            'CANNOT_DM_ACTOR'
          );
        }

        if (isBlocked || hasBlockedMe) {
          throw new BusinessLogicError(
            'Cannot send messages to this user',
            'BLOCKED_USER'
          );
        }
      }
    }
    // For group chats, check GroupChatMembership
    else if (isGroupChat) {
      isMember = await GroupChatService.isInChat(user.userId, chatId);
      if (!isMember) {
        throw new AuthorizationError(
          'You are not a member of this group chat',
          'chat',
          'write'
        );
      }
    }
    // 5. Check kick probability for group chats (not DMs) - skip for now since we don't want to kick during message send
    let sweepDecision: SweepDecision | null = null;

    if (isGroupChat) {
      sweepDecision = await GroupChatService.calculateKickChance(
        user.userId,
        chatId
      );
      // Note: We don't actually kick here, just calculate stats for response
      // Actual kicks happen via sweep background job
    }

    // 6. Check message quality
    const contextType = isDMChat ? 'dm' : 'groupchat';
    const qualityResult = await MessageQualityChecker.checkQuality(
      content,
      user.userId,
      contextType,
      chatId
    );

    if (!qualityResult.passed) {
      throw new BusinessLogicError(
        qualityResult.errors.join('; '),
        'QUALITY_CHECK_FAILED'
      );
    }

    // 7. Validate reply target and build reply snippet (if replying)
    const effectiveReplyToMessageId = replyToMessageId;
    let replyToMessage: {
      id: string;
      content: string;
      senderId: string;
      senderName?: string;
    } | null = null;

    if (effectiveReplyToMessageId) {
      const [replyMsg] = await db
        .select({
          id: messages.id,
          content: messages.content,
          senderId: messages.senderId,
          senderName: users.displayName,
        })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderId))
        .where(
          and(
            eq(messages.id, effectiveReplyToMessageId),
            eq(messages.chatId, chatId)
          )
        )
        .limit(1);

      if (!replyMsg) {
        throw new BusinessLogicError(
          'Invalid reply target message',
          'INVALID_REPLY_TARGET'
        );
      }

      replyToMessage = {
        id: replyMsg.id,
        content: replyMsg.content.slice(0, 200),
        senderId: replyMsg.senderId,
        senderName: replyMsg.senderName ?? undefined,
      };
    }

    // 8. Create message
    const { message, membership } = await asUser(user, async (db) => {
      const msg = await db.message.create({
        data: {
          id: await generateSnowflakeId(),
          content: content.trim(),
          chatId,
          senderId: user.userId,
          createdAt: new Date(),
          replyToMessageId: effectiveReplyToMessageId ?? null,
        },
      });

      // 8. Update user's quality score in group chat (not DMs)
      if (isGroupChat) {
        await GroupChatService.updateQualityScore(
          user.userId,
          chatId,
          qualityResult.score
        );

        // 9. Get updated membership stats
        const chatForGroup = await db.chat.findUnique({
          where: { id: chatId },
          select: { groupId: true },
        });
        const mem = chatForGroup?.groupId
          ? await db.groupMember.findFirst({
              where: {
                groupId: chatForGroup.groupId,
                userId: user.userId,
              },
            })
          : null;
        return { message: msg, membership: mem };
      }

      return { message: msg, membership: null };
    });

    // 9. Broadcast message via SSE (await for reliability)
    await broadcastChatMessage(chatId, {
      id: message.id,
      content: message.content,
      chatId: message.chatId,
      senderId: message.senderId,
      type: message.type ?? 'user',
      createdAt: toISO(message.createdAt),
      isDMChat,
      replyToMessageId: effectiveReplyToMessageId ?? undefined,
      replyToMessage,
    });

    // 12. Send notifications to other participants
    if (isDMChat) {
      // Departed peers retain block protection but do not receive previews.
      const otherParticipant = chatParticipantsList.find(
        (p) => p.userId !== user.userId && p.isActive
      );
      if (otherParticipant) {
        await notifyDMMessage(
          otherParticipant.userId,
          user.userId,
          chatId,
          content.trim()
        );
      }
    } else if (isGroupChat) {
      // For group chats, notify all participants except sender
      const recipientUserIds = chatParticipantsList
        .filter((p) => p.userId !== user.userId && p.isActive)
        .map((p) => p.userId);
      const chatInfo = await asUser(user, async (db) => {
        return await db.chat.findUnique({
          where: { id: chatId },
          select: { name: true },
        });
      });

      await notifyGroupChatMessage(
        recipientUserIds,
        user.userId,
        chatId,
        chatInfo?.name || 'Group Chat',
        content.trim()
      );
    }
    // 13. Return success with feedback
    logger.info(
      'Message sent successfully',
      {
        chatId,
        userId: user.userId,
        chatType: isDMChat ? 'dm' : 'group',
        qualityScore: qualityResult.score,
      },
      'POST /api/chats/[id]/message'
    );

    // Track message sent event
    trackServerEvent(user.userId, 'message_sent', {
      chatId,
      messageLength: content.length,
      chatType: isDMChat ? 'dm' : 'group',
      qualityScore: qualityResult.score,
    }).catch((error) => {
      logger.warn('Failed to track message_sent event', { error });
    });

    if (isGroupChat) {
      void checkProgress(user.userId, { type: 'group_message_sent' });
    }

    return successResponse(
      {
        message: {
          id: message.id,
          content: message.content,
          chatId: message.chatId,
          senderId: message.senderId,
          createdAt: message.createdAt,
        },
        quality: {
          score: qualityResult.score,
          warnings: qualityResult.warnings,
          factors: qualityResult.factors,
        },
        membership: isGroupChat
          ? {
              messageCount: membership?.messageCount || 0,
              qualityScore: membership?.qualityScore || 0,
              lastMessageAt: membership?.lastMessageAt,
              messagesLast24h: sweepDecision?.stats.messagesLast24h || 0,
              status: 'active',
            }
          : undefined,
        warnings: qualityResult.warnings,
        chatType: isDMChat ? 'dm' : 'group',
      },
      201
    );
  }
);
