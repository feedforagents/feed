import { dbWrite, eq, users } from '@feed/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { type FeedAgentContext, OAuthError } from './contracts';
import type { FeedOAuthService } from './service';

export interface FeedMcpContent {
  about: string;
  howToPlay: string;
}
export async function serveFeedMcp(
  request: Request,
  service: FeedOAuthService,
  content: FeedMcpContent
) {
  const origin = request.headers.get('origin');
  if (origin && origin !== service.origin)
    return new Response('Forbidden origin', { status: 403 });
  const authorization = request.headers.get('authorization');
  let context: FeedAgentContext | null = null;
  if (authorization) {
    if (!authorization.startsWith('Bearer ') || authorization.length > 256)
      return challenge(service);
    context = await service.authenticate(authorization.slice(7));
    if (!context) return challenge(service);
  }
  // Transport-level challenge is required by hosts that cannot initiate OAuth
  // from a normal MCP tool error alone. Public discovery remains anonymous.
  let parsedBody: unknown;
  if (request.method === 'POST') {
    parsedBody = await readBody(request);
    if (isWhoami(parsedBody)) {
      if (!context) return challenge(service, requestId(parsedBody));
      if (!context.scopes.includes('read'))
        return challenge(service, requestId(parsedBody), 403);
    }
  }
  const server = new McpServer({ name: 'Feed', version: '2.0.0' });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    'about_feed',
    {
      title: 'About Feed',
      description:
        'Learn about Feed, a social game using virtual points with no cash value.',
      inputSchema: z.object({}).strict(),
      annotations,
      _meta: { securitySchemes: [{ type: 'noauth' }] },
    },
    async () => ({ content: [{ type: 'text', text: content.about }] })
  );
  server.registerTool(
    'how_to_play',
    {
      title: 'How to play Feed',
      description:
        'Read the Feed guide. All game points are virtual points with no cash value.',
      inputSchema: z.object({}).strict(),
      annotations,
      _meta: { securitySchemes: [{ type: 'noauth' }] },
    },
    async () => ({ content: [{ type: 'text', text: content.howToPlay }] })
  );
  server.registerTool(
    'whoami',
    {
      title: 'Your Feed account',
      description:
        'Confirm the account and agent connection. Game balances use virtual points with no cash value.',
      inputSchema: z.object({}).strict(),
      annotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] },
    },
    async () => {
      if (!context || !context.scopes.includes('read'))
        throw new OAuthError('authentication_required', 401);
      const [user] = await dbWrite
        .select({
          handle: users.username,
          displayName: users.displayName,
          mode: users.uiMode,
          balance: users.virtualBalance,
        })
        .from(users)
        .where(eq(users.id, context.accountId))
        .limit(1);
      if (!user) throw new OAuthError('access_denied', 403);
      const result = {
        handle: user.handle,
        displayName: user.displayName,
        mode: user.mode,
        clientName: context.clientName,
        ...(user.mode === 'game'
          ? {
              balance: user.balance,
              currency: 'virtual points with no cash value',
            }
          : {}),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request, { parsedBody });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
function challenge(
  service: FeedOAuthService,
  id: string | number | null = null,
  status = 401
) {
  const value = `Bearer resource_metadata="${service.origin}/.well-known/oauth-protected-resource/mcp", scope="read"${status === 403 ? ', error="insufficient_scope"' : ''}`;
  return Response.json(
    {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [
          { type: 'text', text: 'Connect your Feed account to continue.' },
        ],
        _meta: { 'mcp/www_authenticate': [value] },
      },
    },
    {
      status,
      headers: { 'WWW-Authenticate': value, 'Cache-Control': 'no-store' },
    }
  );
}

function isWhoami(body: unknown): boolean {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('method' in body) ||
    body.method !== 'tools/call' ||
    !('params' in body)
  )
    return false;
  return (
    !!body.params &&
    typeof body.params === 'object' &&
    'name' in body.params &&
    body.params.name === 'whoami'
  );
}
function requestId(body: unknown): string | number | null {
  if (
    body &&
    typeof body === 'object' &&
    'id' in body &&
    (typeof body.id === 'string' || typeof body.id === 'number')
  )
    return body.id;
  return null;
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new OAuthError('invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel();
        throw new OAuthError('invalid_request');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OAuthError('invalid_request');
  }
}
