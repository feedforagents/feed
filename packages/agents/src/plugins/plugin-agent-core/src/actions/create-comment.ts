/**
 * CREATE_COMMENT Action
 *
 * Creates a comment on a post or replies to an existing comment.
 * Use CHECK_POST_DETAIL or CHECK_COMMENT_DETAIL first to get IDs.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import {
  and,
  createCommentWithParentCheck,
  db,
  eq,
  isNull,
  posts,
} from '@feed/db';
import { CreateCommentSchema } from '@feed/shared';
import { logger } from '../../../../shared/logger';
import { generateSnowflakeId } from '../../../../shared/snowflake';

export const createCommentAction: Action = {
  name: 'CREATE_COMMENT',
  description: 'Create a comment on a post or reply to an existing comment.',

  parameters: {
    postId: {
      type: 'string',
      description: 'The ID of the post to comment on (required)',
      required: true,
    },
    parentCommentId: {
      type: 'string',
      description:
        'The ID of the comment to reply to (optional - omit to comment directly on the post)',
      required: false,
    },
    content: {
      type: 'string',
      description: 'The content of your comment (required)',
      required: true,
    },
  } as unknown as Action['parameters'],

  examples: [
    [
      {
        name: 'user',
        content: { text: 'Comment on post 123 saying "Great point!"' },
      },
      {
        name: 'assistant',
        content: { text: "I'll add that comment to the post..." },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Reply to comment 456 disagreeing with their take' },
      },
      {
        name: 'assistant',
        content: { text: "I'll reply to that comment..." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const agentUserId = runtime.agentId;
    // Validate untyped action params with the same contract as the comments API.
    const parsed = CreateCommentSchema.safeParse(
      state?.data?.actionParams ?? {}
    );
    if (!parsed.success) {
      return {
        success: false,
        text: `Invalid comment parameters: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`
          )
          .join('; ')}`,
        error: 'Invalid parameters',
      };
    }
    const { postId, parentCommentId, content } = parsed.data;

    // Validate required parameters
    if (!postId) {
      return {
        success: false,
        text: 'Missing postId parameter. Use CHECK_POST_DETAIL first to get the post ID.',
        error: 'Missing postId',
      };
    }

    try {
      // Verify the post exists and is not deleted
      const [post] = await db
        .select({ id: posts.id, authorId: posts.authorId })
        .from(posts)
        .where(and(eq(posts.id, postId), isNull(posts.deletedAt)))
        .limit(1);

      if (!post) {
        return {
          success: false,
          text: `Post not found or deleted. Use CHECK_POST_DETAIL to verify the post ID.`,
          error: 'Post not found',
        };
      }

      // Create the comment
      const commentId = await generateSnowflakeId();
      const now = new Date();

      const result = await createCommentWithParentCheck({
        id: commentId,
        content: content,
        postId,
        authorId: agentUserId,
        parentCommentId: parentCommentId || null,
        createdAt: now,
        updatedAt: now,
      });

      if (result.status === 'parent-post-mismatch') {
        return {
          success: false,
          text: 'Parent comment does not belong to the specified post.',
          error: 'Comment/post mismatch',
        };
      }
      if (result.status !== 'created') {
        return {
          success: false,
          text: 'Parent comment not found or deleted. Use CHECK_POST_DETAIL to see available comments.',
          error: 'Parent comment not found',
        };
      }

      const isReply = !!parentCommentId;
      const actionDescription = isReply
        ? `Replied to comment ${parentCommentId}`
        : `Commented on post ${postId}`;

      logger.info(
        `[CREATE_COMMENT] ${actionDescription}`,
        { commentId, postId, parentCommentId },
        'CreateComment'
      );

      return {
        success: true,
        text: isReply
          ? `Reply created successfully (ID: ${commentId}).`
          : `Comment created successfully (ID: ${commentId}).`,
        data: {
          commentId,
          postId,
          parentCommentId: parentCommentId || null,
          content: content,
          isReply,
        },
        values: {
          commentId,
          postId,
          parentCommentId: parentCommentId || null,
          isReply,
          contentPreview:
            content.length > 50 ? `${content.substring(0, 50)}...` : content,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CREATE_COMMENT] Error:', errorMsg);

      return {
        success: false,
        text: `Failed to create comment: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
