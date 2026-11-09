import {
  checkRateLimitAsync,
  FeedAppError,
  getClientIp,
  getPublicPost,
  getPublicProfile,
  NotFoundError,
  RATE_LIMIT_CONFIGS,
  RateLimitError,
} from '@feed/api';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FeedAgentContext } from './contracts';

export const PUBLIC_READ_DESCRIPTORS = [
  {
    name: 'get_post',
    title: 'Read a public Feed post',
    description:
      'Read a published Feed post, its public author information, and visible original post when it is a repost or quote.',
  },
  {
    name: 'get_profile',
    title: 'Read a public Feed profile',
    description:
      'Read a public account, character, or organization by ID or handle (optional @). Game values use virtual points with no cash value.',
  },
] as const;
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const security = {
  securitySchemes: [{ type: 'noauth' }, { type: 'oauth2', scopes: ['read'] }],
};

export function registerPublicReadTools(
  server: McpServer,
  context: FeedAgentContext | null,
  headers: Headers
): void {
  const limited = async <T>(read: () => Promise<T>) => {
    try {
      const ip = context ? null : getClientIp(headers);
      const key = context?.accountId ?? ip ?? 'anonymous';
      const config = context
        ? RATE_LIMIT_CONFIGS.PUBLIC_READ_AUTHED
        : ip
          ? RATE_LIMIT_CONFIGS.PUBLIC_READ
          : RATE_LIMIT_CONFIGS.PUBLIC_READ_ANONYMOUS;
      const quota = await checkRateLimitAsync(key, config);
      if (!quota.allowed)
        throw new RateLimitError(
          'Too many public reads. Try again later.',
          quota.retryAfter
        );
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(await read()) },
        ],
      };
    } catch (error) {
      if (!(error instanceof FeedAppError)) throw error;
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: error.code, message: error.message }),
          },
        ],
      };
    }
  };
  server.registerTool(
    'get_post',
    {
      title: PUBLIC_READ_DESCRIPTORS[0].title,
      description: PUBLIC_READ_DESCRIPTORS[0].description,
      inputSchema: z.object({ postId: z.string().min(1).max(256) }).strict(),
      annotations,
      _meta: security,
    },
    async ({ postId }) =>
      limited(async () => {
        const post = await getPublicPost(postId, context?.accountId);
        const original = post.originalPost;
        return {
          id: post.id,
          type: post.type,
          content: post.content,
          fullContent: post.fullContent,
          articleTitle: post.articleTitle,
          imageUrl: post.imageUrl,
          author: {
            id: post.authorId,
            handle: post.authorUsername ?? post.authorId,
            displayName: post.authorName,
            avatarUrl: post.authorProfileImageUrl,
          },
          timestamp: post.timestamp,
          likeCount: post.likeCount,
          replyCount: post.commentCount,
          shareCount: post.shareCount,
          ...(context?.scopes.includes('read')
            ? { isLiked: post.isLiked, isShared: post.isShared }
            : {}),
          ...(original
            ? {
                isRepost: true,
                isQuote: Boolean(post.isQuote),
                quoteComment: post.quoteComment,
                originalPost: {
                  id: original.id,
                  content: original.content,
                  author: {
                    id: original.authorId,
                    handle: original.authorUsername,
                    displayName: original.authorName,
                    avatarUrl: original.authorProfileImageUrl,
                  },
                  timestamp: original.timestamp,
                },
              }
            : {}),
        };
      })
  );
  server.registerTool(
    'get_profile',
    {
      title: PUBLIC_READ_DESCRIPTORS[1].title,
      description: PUBLIC_READ_DESCRIPTORS[1].description,
      inputSchema: z
        .object({ identifier: z.string().trim().min(1).max(256) })
        .strict(),
      annotations,
      _meta: security,
    },
    async ({ identifier }) =>
      limited(async () => {
        const normalized = identifier.startsWith('@')
          ? identifier.slice(1)
          : identifier;
        const profile = normalized
          ? await getPublicProfile(normalized, context?.accountId)
          : null;
        if (!profile) throw new NotFoundError('Profile', identifier);
        return profile;
      })
  );
}
