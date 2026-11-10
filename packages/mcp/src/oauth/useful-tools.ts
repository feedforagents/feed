import {
  checkRateLimitAsync,
  createFeedPost,
  FeedAppError,
  FeedPostCreationError,
  getClientIp,
  getHashedClientIp,
  getPostsFeed,
  getPublicPost,
  RATE_LIMIT_CONFIGS,
  RateLimitError,
} from '@feed/api';
import { mcpOAuthAudit } from '@feed/db';
import { CreatePostSchema } from '@feed/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type FeedAgentContext, OAuthError, opaque } from './contracts';

type PublicPost = Awaited<ReturnType<typeof getPublicPost>>;
type FeedPost = Awaited<ReturnType<typeof getPostsFeed>>['posts'][number];

/** Explicit public projection: REST comment previews and internal game/profile
 * metadata are not part of this read/post MCP flow. */
function publicPost(post: PublicPost | FeedPost) {
  const original = 'originalPost' in post ? post.originalPost : null;
  return {
    id: post.id,
    type: post.type,
    content: post.content,
    author: {
      handle: post.authorUsername ?? null,
      displayName: post.authorName,
      avatarUrl: post.authorProfileImageUrl ?? null,
    },
    timestamp: post.timestamp,
    likeCount: post.likeCount,
    replyCount: post.commentCount,
    shareCount: post.shareCount,
    ...(original
      ? {
          originalPost: {
            id: original.id,
            content: original.content,
            author: {
              handle: original.authorUsername,
              displayName: original.authorName,
              avatarUrl: original.authorProfileImageUrl,
            },
            timestamp: original.timestamp,
          },
        }
      : {}),
  };
}

function result(value: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}
function expectedError(error: FeedAppError | FeedPostCreationError) {
  if (error instanceof FeedPostCreationError) {
    return {
      isError: true,
      ...result({
        error: error.kind,
        message:
          error.kind === 'persistence'
            ? 'Post creation could not be confirmed. Check the feed before retrying.'
            : error.message,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      }),
    };
  }
  return {
    isError: true,
    ...result({ error: error.code, message: error.message }),
  };
}

export function registerUsefulTools(
  server: McpServer,
  context: FeedAgentContext | null,
  headers: Headers
) {
  const limitedRead = async (read: () => Promise<object>) => {
    try {
      const ip = context ? null : getClientIp(headers);
      const quota = await checkRateLimitAsync(
        context?.accountId ?? ip ?? 'anonymous',
        context
          ? RATE_LIMIT_CONFIGS.PUBLIC_READ_AUTHED
          : ip
            ? RATE_LIMIT_CONFIGS.PUBLIC_READ
            : RATE_LIMIT_CONFIGS.PUBLIC_READ_ANONYMOUS
      );
      if (!quota.allowed)
        throw new RateLimitError(
          'Too many public reads. Try again later.',
          quota.retryAfter
        );
      return result(await read());
    } catch (error) {
      if (!(error instanceof FeedAppError)) throw error;
      return expectedError(error);
    }
  };
  const publicSecurity = {
    securitySchemes: [{ type: 'noauth' }, { type: 'oauth2', scopes: ['read'] }],
  };
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    'get_home_feed',
    {
      title: 'Read the latest Feed posts',
      description:
        'Read public Latest posts in chronological order. Use the returned cursor when hasMore is true, including a page with no visible posts.',
      inputSchema: z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().min(1).max(512).optional(),
        })
        .strict(),
      annotations: readAnnotations,
      _meta: publicSecurity,
    },
    async ({ limit, cursor }) =>
      limitedRead(async () => {
        const feed = await getPostsFeed({
          limit,
          cursor,
          viewerId: context?.accountId,
        });
        return {
          posts: feed.posts.map(publicPost),
          cursor: feed.cursor,
          hasMore: feed.hasMore,
        };
      })
  );
  server.registerTool(
    'get_post',
    {
      title: 'Read a public Feed post',
      description:
        'Read a published post and its public author information. Use this to verify a requested post was persisted.',
      inputSchema: z.object({ postId: z.string().min(1).max(256) }).strict(),
      annotations: readAnnotations,
      _meta: publicSecurity,
    },
    async ({ postId }) =>
      limitedRead(async () =>
        publicPost(await getPublicPost(postId, context?.accountId))
      )
  );
  server.registerTool(
    'create_post',
    {
      title: 'Create a Feed post',
      description:
        'Publish a text post as your connected Feed account only when you request it. Do not automatically retry an ambiguous failure; check the feed first.',
      inputSchema: CreatePostSchema.pick({ content: true }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: {
        securitySchemes: [{ type: 'oauth2', scopes: ['social:write'] }],
      },
    },
    async ({ content }) => {
      if (!context) throw new OAuthError('authentication_required', 401);
      if (!context.scopes.includes('social:write'))
        throw new OAuthError('insufficient_scope', 403);
      try {
        const created = await createFeedPost(
          { content },
          {
            accountId: context.accountId,
            clientIpHash: getHashedClientIp(headers) ?? undefined,
            observeMutation: async (transaction, postId) => {
              await transaction.insert(mcpOAuthAudit).values({
                id: opaque('event'),
                userId: context.accountId,
                clientId: context.clientId,
                grantId: context.grantId,
                event: 'create_post',
                resourceId: postId,
              });
            },
          }
        );
        return result({
          postId: created.post.id,
          content: created.post.content,
          clientName: context.clientName,
        });
      } catch (error) {
        if (
          !(error instanceof FeedAppError) &&
          !(error instanceof FeedPostCreationError)
        )
          throw error;
        return expectedError(error);
      }
    }
  );
}
