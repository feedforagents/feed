import {
  checkRateLimitAsync,
  FeedAppError,
  RATE_LIMIT_CONFIGS,
  RateLimitError,
  sharePost,
  unsharePost,
} from '@feed/api';
import { mcpOAuthAudit } from '@feed/db';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type FeedAgentContext,
  type FeedScope,
  OAuthError,
  opaque,
} from './contracts';
import type { FeedOAuthService } from './service';

export const PLAYER_ACTION_DESCRIPTORS = [
  {
    name: 'repost',
    title: 'Repost a Feed post',
    description:
      'Repost a public post as your connected Feed account. This creates a repost visible in your feed.',
    scope: 'social:write',
    destructive: false,
  },
  {
    name: 'unrepost',
    title: 'Remove your Feed repost',
    description:
      'Remove your own pure repost of a post. Quote posts must be deleted explicitly; this tool never deletes a quote.',
    scope: 'social:write',
    destructive: true,
  },
] as const;
const inputSchema = z.object({ postId: z.string().min(1).max(128) }).strict();
export function getPlayerActionScope(name: string): FeedScope | null {
  return (
    PLAYER_ACTION_DESCRIPTORS.find((tool) => tool.name === name)?.scope ?? null
  );
}

export function registerPlayerActions(
  server: McpServer,
  context: FeedAgentContext | null,
  _service: FeedOAuthService
): void {
  for (const tool of PLAYER_ACTION_DESCRIPTORS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool.destructive,
          openWorldHint: false,
        },
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: [tool.scope] }] },
      },
      async ({ postId }) => {
        if (!context) throw new OAuthError('authentication_required', 401);
        if (!context.scopes.includes(tool.scope))
          throw new OAuthError('insufficient_scope', 403);
        try {
          const observe = async (tx: import('@feed/db').Transaction) => {
            await tx.insert(mcpOAuthAudit).values({
              id: opaque('event'),
              userId: context.accountId,
              clientId: context.clientId,
              grantId: context.grantId,
              event: tool.name,
            });
          };
          if (tool.name === 'repost') {
            const quota = await checkRateLimitAsync(
              context.accountId,
              RATE_LIMIT_CONFIGS.SHARE_POST
            );
            if (!quota.allowed)
              throw new RateLimitError(
                'Too many reposts. Try again later.',
                quota.retryAfter
              );
            const result = await sharePost(
              context.accountId,
              postId,
              undefined,
              undefined,
              observe
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    postId: result.shareTargetPostId,
                    repostId: result.repostId,
                    shareCount: result.shareCount,
                    isShared: true,
                  }),
                },
              ],
            };
          }
          const result = await unsharePost(context.accountId, postId, observe, {
            pureOnly: true,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  postId: result.shareTargetPostId,
                  shareCount: result.shareCount,
                  isShared: false,
                }),
              },
            ],
          };
        } catch (error) {
          if (!(error instanceof FeedAppError)) throw error;
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: error.code,
                  message: error.message,
                }),
              },
            ],
          };
        }
      }
    );
  }
}
