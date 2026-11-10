/**
 * Group Messages API
 *
 * @route GET /api/groups/[groupId]/messages - List group chat messages
 * @access Authenticated members only
 */

import {
  ApiError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { and, asUser, desc, eq, messages, sql } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const MessagesQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ groupId: string }> }
  ) => {
    const user = await authenticate(request);
    const { groupId } = await params;
    const { searchParams } = new URL(request.url);
    const query = MessagesQuerySchema.safeParse({
      cursor: searchParams.get('cursor') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    });
    if (!query.success) {
      throw new ApiError('Invalid cursor or limit', 400);
    }
    const { cursor, limit } = query.data;

    const result = await asUser(user, async (db) => {
      const group = await db.group.findUnique({
        where: { id: groupId },
        select: { id: true, name: true },
      });

      if (!group) {
        throw new ApiError('Group not found', 404);
      }

      const membership = await db.groupMember.findFirst({
        where: {
          groupId,
          userId: user.userId,
          isActive: true,
        },
      });

      if (!membership) {
        throw new ApiError('You are not a member of this group', 403);
      }

      const groupChat = await db.chat.findFirst({
        where: { groupId },
        select: { id: true, name: true },
      });

      if (!groupChat) {
        throw new ApiError('Group chat not found', 404);
      }

      // The cursor must be a message in this group's chat; an unknown cursor
      // is an error rather than silently restarting from the latest page.
      // Keep the stored timestamp's full PostgreSQL precision: the Date
      // decoder would discard microseconds before the next comparison.
      // The unique ID breaks ties, so a page boundary inside a shared
      // timestamp resumes exactly instead of dropping the tied messages.
      const [cursorMessage] = cursor
        ? await db
            .select({
              createdAt: sql<string>`${messages.createdAt}::text`,
              id: messages.id,
            })
            .from(messages)
            .where(
              and(eq(messages.id, cursor), eq(messages.chatId, groupChat.id))
            )
            .limit(1)
        : [];

      if (cursor && !cursorMessage) {
        throw new ApiError('Invalid cursor', 400);
      }

      const messageRows = await db
        .select({
          id: messages.id,
          content: messages.content,
          createdAt: messages.createdAt,
          senderId: messages.senderId,
          type: messages.type,
        })
        .from(messages)
        .where(
          cursorMessage
            ? and(
                eq(messages.chatId, groupChat.id),
                sql`(${messages.createdAt}, ${messages.id}) < (${cursorMessage.createdAt}::text::timestamp without time zone, ${cursorMessage.id}::text)`
              )
            : eq(messages.chatId, groupChat.id)
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);

      const hasMore = messageRows.length > limit;
      const visibleMessages = hasMore
        ? messageRows.slice(0, limit)
        : messageRows;

      const senderIds = Array.from(
        new Set(
          visibleMessages
            .map((message) => message.senderId)
            .filter((senderId) => senderId !== 'system')
        )
      );

      const senderUsers =
        senderIds.length > 0
          ? await db.user.findMany({
              where: {
                id: { in: senderIds },
              },
              select: {
                id: true,
                displayName: true,
                username: true,
                profileImageUrl: true,
                isActor: true,
              },
            })
          : [];
      const senderUserMap = new Map(
        senderUsers.map((senderUser) => [senderUser.id, senderUser])
      );

      return {
        groupId,
        groupName: group.name,
        chatId: groupChat.id,
        messages: visibleMessages.map((message) => {
          if (message.senderId === 'system') {
            return {
              id: message.id,
              content: message.content,
              createdAt: message.createdAt,
              type: message.type,
              sender: {
                id: 'system',
                name: 'System',
                username: null,
                profileImageUrl: null,
                isNPC: false,
              },
            };
          }

          const senderUser = senderUserMap.get(message.senderId);
          const actor = StaticDataRegistry.getActor(message.senderId);

          return {
            id: message.id,
            content: message.content,
            createdAt: message.createdAt,
            type: message.type,
            sender: {
              id: message.senderId,
              name:
                senderUser?.displayName ||
                senderUser?.username ||
                actor?.name ||
                'Unknown',
              username: senderUser?.username ?? null,
              profileImageUrl:
                senderUser?.profileImageUrl || actor?.profileImageUrl || null,
              isNPC: actor !== null || senderUser?.isActor === true,
            },
          };
        }),
        pagination: {
          limit,
          hasMore,
          nextCursor: hasMore
            ? (visibleMessages[visibleMessages.length - 1]?.id ?? null)
            : null,
        },
      };
    });

    logger.info(
      'Group messages retrieved',
      {
        userId: user.userId,
        groupId,
        count: result.messages.length,
        limit,
        hasCursor: !!cursor,
      },
      'GET /api/groups/:groupId/messages'
    );

    return successResponse(result);
  }
);
