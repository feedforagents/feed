/**
 * Create Post Action
 *
 * Creates a post on the Feed feed. The content is provided as a parameter
 * (determined by the LLM in the multi-step decision).
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { notifyMention } from '@feed/api';
import { db, inArray, posts, users } from '@feed/db';
import {
  type GeneratedTag,
  generateTagsFromPost,
  storeTagsForPost,
} from '@feed/engine';
import { logger } from '../../../../shared/logger';
import { generateSnowflakeId } from '../../../../shared/snowflake';

export interface CreatePostParams {
  content: string;
}

/**
 * CREATE_POST Action
 *
 * Creates a post on the Feed social feed.
 */
export const createPostAction: Action = {
  name: 'CREATE_POST',
  description: 'Create a post on the Feed social feed',

  parameters: {
    content: {
      type: 'string',
      description: 'The content/text of the post to create',
      required: true,
    },
  } as unknown as Action['parameters'],

  examples: [
    [
      {
        name: 'User',
        content: {
          text: 'Post about the current market conditions',
        },
      },
      {
        name: 'Agent',
        content: {
          text: 'Creating a post about market conditions...',
          actions: ['CREATE_POST'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Share your thoughts on BitcAIn',
        },
      },
      {
        name: 'Agent',
        content: {
          text: "I'll share my thoughts on BitcAIn...",
          actions: ['CREATE_POST'],
        },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const agentId = runtime.agentId;

    // Get parameters from state (set by multi-step decision)
    const actionParams = state?.data?.actionParams as
      | CreatePostParams
      | undefined;

    const rawContent: unknown = actionParams?.content;
    const content = typeof rawContent === 'string' ? rawContent : undefined;

    if (!content || content.trim().length === 0) {
      logger.error('[CREATE_POST] No content provided');
      return {
        success: false,
        text: 'No content provided.',
        error: 'No content provided',
      };
    }

    // Validate content length
    const trimmedContent = content.trim();
    if (trimmedContent.length < 5) {
      return {
        success: false,
        text: 'Content too short (min 5 chars).',
        error: 'Content too short',
      };
    }

    if (trimmedContent.length > 1000) {
      return {
        success: false,
        text: 'Content too long (max 1000 chars).',
        error: 'Content too long',
      };
    }

    try {
      // Create the post
      const postId = await generateSnowflakeId();
      await db.insert(posts).values({
        id: postId,
        content: trimmedContent,
        authorId: agentId,
        type: 'post',
        timestamp: new Date(),
        createdAt: new Date(),
      });

      // Same mention notifications as POST /api/posts. The post already
      // committed, so a notification failure is logged only.
      try {
        const mentions = trimmedContent.match(/@(\w+)/g) || [];
        const usernames = [
          ...new Set(mentions.map((m) => m.substring(1))),
        ];
        if (usernames.length > 0) {
          const mentionedUsers = await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.username, usernames));
          await Promise.all(
            mentionedUsers.map((mentionedUser) =>
              notifyMention(mentionedUser.id, agentId, postId)
            )
          );
        }
      } catch (error) {
        logger.warn('[CREATE_POST] Failed to notify mentioned users', {
          postId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.info(
        `[CREATE_POST] Post created: ${postId}`,
        undefined,
        'CreatePost'
      );

      // Generate and store tags asynchronously (don't block the response)
      void generateTagsFromPost(trimmedContent)
        .then((generatedTags: GeneratedTag[]) => {
          if (generatedTags.length > 0) {
            return storeTagsForPost(postId, generatedTags).then(() => {
              logger.info(
                '[CREATE_POST] Tagged post',
                { postId, tagCount: generatedTags.length },
                'CreatePost'
              );
            });
          }
          return Promise.resolve();
        })
        .catch((tagError: Error) => {
          logger.warn(
            '[CREATE_POST] Failed to tag post',
            { postId, error: String(tagError) },
            'CreatePost'
          );
        });

      return {
        success: true,
        text: 'Post created.',
        data: { postId, content: trimmedContent, authorId: agentId },
        values: { postId },
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('[CREATE_POST] Error:', errorMsg);

      return {
        success: false,
        text: `Failed to create post: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
