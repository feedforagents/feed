/**
 * API Route: /api/chats/[id]
 * Methods: GET (get chat details and messages)
 *
 * @openapi
 * /api/chats/{id}:
 *   get:
 *     tags:
 *       - Chats
 *     summary: Get chat details and messages
 *     description: Returns chat details with paginated messages. Supports cursor-based pagination.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chat ID
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor for pagination (message ID)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Messages per page
 *     responses:
 *       200:
 *         description: Chat details with messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chat:
 *                   type: object
 *                 messages:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Chat not found
 */

import {
  AuthorizationError,
  authenticate,
  BusinessLogicError,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  and,
  asc,
  asSystem,
  asUser,
  chatParticipants,
  chats,
  count,
  desc,
  eq,
  gt,
  inArray,
  messageReactions,
  messages,
  sql,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { CHAT_PAGE_SIZE } from '@/lib/constants';

const ChatHistoryQuerySchema = z
  .object({
    /** Message ID — loads messages OLDER than this message. */
    cursor: z.string().min(1).max(128).optional(),
    /** ISO timestamp — loads messages NEWER than this time. */
    after: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be a positive integer')
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(CHAT_PAGE_SIZE),
  })
  .refine((q) => !(q.cursor && q.after), {
    message: 'cursor and after are mutually exclusive',
  });

/**
 * GET /api/chats/[id]
 * Get chat details and messages
 */
export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: chatId } = await context.params;

    // Validate query parameters
    const { searchParams } = new URL(request.url);
    const { cursor, after, limit } = ChatHistoryQuerySchema.parse({
      cursor: searchParams.get('cursor') ?? undefined,
      after: searchParams.get('after') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    });
    const effectiveLimit = limit;

    // Authenticate before touching the chat so existence is not disclosed to
    // anonymous callers.
    const authUser = await authenticate(request);
    const userId = authUser.userId;

    const [chat] = await asSystem(async (db) => {
      return await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    }, 'get-chat-by-id');

    if (!chat) {
      throw new NotFoundError('Chat', chatId);
    }

    const isGameChat = chat.isGroup && chat.gameId === 'continuous';

    const [isMember] = await asUser(authUser, async (db) => {
      return await db
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, chatId),
            eq(chatParticipants.userId, userId),
            eq(chatParticipants.isActive, true)
          )
        )
        .limit(1);
    });

    if (!isMember) {
      throw new AuthorizationError(
        'You do not have access to this chat',
        'chat',
        'read'
      );
    }

    // Get chat with messages
    const fetchChatData = async (
      db: Parameters<Parameters<typeof asSystem>[0]>[0]
    ) => {
      // Get chat participants
      const participantsList = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, chatId));

      // Build message query — three modes:
      // 1. `after` (ISO timestamp): fetch messages NEWER than this time (ASC order, for sync)
      // 2. `cursor` (message ID): fetch messages OLDER than this cursor (DESC order, for load-more)
      // 3. Neither: fetch latest messages (DESC order, initial load)
      let messagesList: Array<typeof messages.$inferSelect>;
      if (after) {
        // Incremental sync: only messages after the given timestamp
        messagesList = await db
          .select()
          .from(messages)
          .where(
            and(eq(messages.chatId, chatId), gt(messages.createdAt, after))
          )
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(effectiveLimit);
      } else if (cursor) {
        // Keep the stored timestamp's full PostgreSQL precision: the Date
        // decoder would discard microseconds before the next comparison.
        // Bind as text too, so the driver does not serialize it as a Date.
        // The unique ID breaks ties, and the cursor must belong to this chat.
        const [cursorMessage] = await db
          .select({
            createdAt: sql<string>`${messages.createdAt}::text`,
            id: messages.id,
          })
          .from(messages)
          .where(and(eq(messages.id, cursor), eq(messages.chatId, chatId)))
          .limit(1);

        if (!cursorMessage) {
          throw new BusinessLogicError(
            'Invalid pagination cursor',
            'INVALID_CURSOR'
          );
        }

        messagesList = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.chatId, chatId),
              sql`(${messages.createdAt}, ${messages.id}) < (${cursorMessage.createdAt}::text::timestamp without time zone, ${cursorMessage.id}::text)`
            )
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(effectiveLimit + 1);
      } else {
        // Initial load: latest messages. Order by (createdAt, id) so the
        // page boundary inside a shared timestamp is deterministic
        // and the cursor walk above can resume from it exactly.
        messagesList = await db
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(effectiveLimit + 1);
      }

      return { chat, participants: participantsList, messages: messagesList };
    };

    const fullChat = await asUser(authUser, fetchChatData);

    // Get participant details
    const fetchParticipantDetails = async (
      db: Parameters<Parameters<typeof asSystem>[0]>[0]
    ) => {
      const participantUserIds = fullChat.participants.map((p) => p.userId);
      const senderIds = [...new Set(fullChat.messages.map((m) => m.senderId))];

      // Combine participant IDs and sender IDs to include users who left but still have messages
      const allUserIds = [
        ...new Set([...participantUserIds, ...(senderIds as string[])]),
      ].filter((id) => id !== 'system'); // Exclude system sender

      const usersList =
        allUserIds.length > 0
          ? await db
              .select({
                id: users.id,
                displayName: users.displayName,
                username: users.username,
                profileImageUrl: users.profileImageUrl,
                isAgent: users.isAgent,
                managedBy: users.managedBy,
              })
              .from(users)
              .where(inArray(users.id, allUserIds))
          : [];

      const actorsList = (senderIds as string[])
        .map((id) => StaticDataRegistry.getActor(id))
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => ({
          id: a.id,
          name: a.name,
          profileImageUrl: a.profileImageUrl,
        }));

      return { users: usersList, actors: actorsList };
    };

    const { users: usersList, actors: actorsList } = await asUser(
      authUser,
      fetchParticipantDetails
    );

    const usersMap = new Map(usersList.map((u) => [u.id, u]));
    const actorsMap = new Map(actorsList.map((a) => [a.id, a]));

    // Get unique sender IDs from messages
    const senderIds = [...new Set(fullChat.messages.map((m) => m.senderId))];
    const participantUserIds = new Set(
      fullChat.participants.map((p) => p.userId)
    );

    // Build participants list including both active participants AND message senders
    // This ensures users who left the chat still have their names displayed on old messages
    const participantsInfo = [
      // Active participants
      ...fullChat.participants.map((p) => {
        const user = usersMap.get(p.userId);
        const actor = actorsMap.get(p.userId);
        return {
          id: p.userId,
          displayName: user?.displayName || actor?.name || 'Unknown',
          username: user?.username,
          profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
        };
      }),
      // Message senders who are no longer participants (left the chat)
      ...(senderIds as string[])
        .filter((id) => id !== 'system' && !participantUserIds.has(id))
        .map((senderId) => {
          const user = usersMap.get(senderId);
          const actor = actorsMap.get(senderId);
          return {
            id: senderId,
            displayName: user?.displayName || actor?.name || 'Unknown',
            username: user?.username,
            profileImageUrl: user?.profileImageUrl || actor?.profileImageUrl,
          };
        }),
    ];

    // For DMs, get the other participant's name and details
    // Include isAgent and managedBy to detect if this is the user's own agent
    let displayName = chat.name;
    let otherUser: {
      id: string;
      displayName: string | null;
      username: string | null;
      profileImageUrl: string | null;
      isAgent?: boolean;
      managedBy?: string | null;
    } | null = null;
    if (!chat.isGroup && !chat.name) {
      const otherParticipant = fullChat.participants.find(
        (p) => p.userId !== userId
      );
      if (otherParticipant) {
        const otherUserData = usersMap.get(otherParticipant.userId);
        if (otherUserData) {
          displayName =
            otherUserData.displayName || otherUserData.username || 'Unknown';
          otherUser = {
            id: otherParticipant.userId,
            displayName: otherUserData.displayName,
            username: otherUserData.username,
            profileImageUrl: otherUserData.profileImageUrl,
            isAgent: otherUserData.isAgent,
            managedBy: otherUserData.managedBy,
          };
        }
      }
    }

    // Check if there are more messages.
    // For `after` queries: if we got exactly `limit` rows, there may be more
    // beyond this page. Signal hasMore so the client can paginate.
    // For cursor/initial queries: the +1 overfetch trick detects more pages.
    const isAfterQuery = !!after;
    const hasMore = isAfterQuery
      ? fullChat.messages.length >= effectiveLimit
      : fullChat.messages.length > effectiveLimit;
    const messagesList = isAfterQuery
      ? fullChat.messages
      : hasMore
        ? fullChat.messages.slice(0, effectiveLimit)
        : fullChat.messages;

    // For cursor/initial queries: reverse from DESC to chronological order.
    // For after queries: already in ASC order from the query.
    const messagesInOrder = isAfterQuery
      ? messagesList
      : [...messagesList].reverse();

    // Message reactions summary (counts + reactedByMe)
    const messageIds = messagesInOrder.map((m) => m.id);
    const reactionsByMessageId = new Map<
      string,
      { emoji: string; count: number; reactedByMe: boolean }[]
    >();
    if (messageIds.length > 0) {
      const [counts, mine] = await Promise.all([
        asSystem(async (db) => {
          return await db
            .select({
              messageId: messageReactions.messageId,
              emoji: messageReactions.emoji,
              count: count(),
            })
            .from(messageReactions)
            .where(inArray(messageReactions.messageId, messageIds))
            .groupBy(messageReactions.messageId, messageReactions.emoji);
        }, 'get-message-reaction-counts'),
        asSystem(async (db) => {
          return await db
            .select({
              messageId: messageReactions.messageId,
              emoji: messageReactions.emoji,
            })
            .from(messageReactions)
            .where(
              and(
                inArray(messageReactions.messageId, messageIds),
                eq(messageReactions.userId, userId)
              )
            );
        }, 'get-message-reactions-mine'),
      ]);

      const mineSet = new Set(mine.map((r) => `${r.messageId}:${r.emoji}`));
      for (const row of counts) {
        const arr = reactionsByMessageId.get(row.messageId) ?? [];
        arr.push({
          emoji: row.emoji,
          count: Number(row.count ?? 0),
          reactedByMe: mineSet.has(`${row.messageId}:${row.emoji}`),
        });
        reactionsByMessageId.set(row.messageId, arr);
      }
    }

    // Resolve replied-to messages in batch
    const replyToIds = [
      ...new Set(
        messagesInOrder
          .map((m) => m.replyToMessageId)
          .filter((id): id is string => !!id)
      ),
    ];
    const replyToMessagesMap = new Map<
      string,
      { id: string; content: string; senderId: string; senderName?: string }
    >();
    if (replyToIds.length > 0) {
      const replyMessages = await asSystem(async (db) => {
        return await db
          .select({
            id: messages.id,
            content: messages.content,
            senderId: messages.senderId,
          })
          .from(messages)
          .where(
            and(inArray(messages.id, replyToIds), eq(messages.chatId, chatId))
          );
      }, 'get-reply-to-messages');

      for (const rm of replyMessages) {
        const sender = usersMap.get(rm.senderId);
        const actor = actorsMap.get(rm.senderId);
        replyToMessagesMap.set(rm.id, {
          id: rm.id,
          content: rm.content.slice(0, 200),
          senderId: rm.senderId,
          senderName: sender?.displayName || actor?.name || undefined,
        });
      }
    }

    // Get the cursor for the next page (oldest message ID in this batch)
    const nextCursor = hasMore
      ? fullChat.messages[effectiveLimit - 1]?.id
      : null;

    logger.info(
      'Chat fetched successfully',
      {
        chatId,
        isGameChat,
        isDM: !chat.isGroup,
        messagesReturned: messagesList.length,
        hasMore,
        nextCursor,
      },
      'GET /api/chats/[id]'
    );

    const chatResponse: {
      id: string;
      name: string | null;
      isGroup: boolean;
      createdAt: Date;
      updatedAt: Date;
      otherUser: typeof otherUser;
    } = {
      id: chat.id,
      name: displayName || chat.name,
      isGroup: chat.isGroup,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      otherUser: otherUser,
    };

    return successResponse({
      chat: chatResponse,
      messages: messagesInOrder.map((msg) => ({
        id: msg.id,
        content: msg.content,
        senderId: msg.senderId,
        type: msg.type,
        createdAt: msg.createdAt,
        metadata: msg.metadata,
        reactions: reactionsByMessageId.get(msg.id) ?? [],
        replyToMessageId: msg.replyToMessageId ?? null,
        replyToMessage: msg.replyToMessageId
          ? (replyToMessagesMap.get(msg.replyToMessageId) ?? null)
          : null,
      })),
      participants: participantsInfo,
      pagination: {
        hasMore,
        nextCursor,
        limit: effectiveLimit,
      },
    });
  }
);
