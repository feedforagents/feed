/** Authenticated SDK requests and web requests share account state and quota.
 * Uses genuine local JWT signatures for integration only, not live Steward proof.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  checkRateLimitAsync,
  RATE_LIMIT_CONFIGS,
  resetRateLimit,
} from '@feed/api';
import {
  and,
  dbWrite as db,
  eq,
  inArray,
  mcpOAuthAudit,
  mcpOAuthClients,
  mcpOAuthRequests,
  notifications,
  posts,
  shares,
  userBlocks,
  users,
} from '@feed/db';
import { FeedOAuthService, hash, opaque, serveFeedMcp } from '@feed/mcp';
import {
  FEED_ABOUT,
  FEED_HOW_TO_PLAY,
  generateSnowflakeId,
} from '@feed/shared';
import { z } from 'zod';
import { FEED_MCP_CAPABILITIES } from '../../mcp/src/oauth/contracts';

const origin = 'https://feed-actions.example';
const service = new FeedOAuthService(origin);
const ids: string[] = [];
const clients: string[] = [];
let actor: string;
let author: string;
async function createUser() {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    stewardId: id,
    username: `action_${id}`,
    profileComplete: true,
    tosAcceptedAt: new Date(),
    updatedAt: new Date(),
  });
  ids.push(id);
  return id;
}
async function createPost() {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    authorId: author,
    content: 'Public action integration post',
    timestamp: new Date(Date.now() - 60_000),
  });
  return id;
}
async function grant(scopes: ('read' | 'social:write')[]) {
  const client = await service.register({
    client_name: 'Player action test',
    redirect_uris: ['http://127.0.0.1/callback'],
  });
  clients.push(client.client_id);
  const browser = opaque('fmcpcb');
  const verifier = 'v'.repeat(64);
  const destination = await service.authorize(
    {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: scopes.join(' '),
    },
    browser
  );
  const requestId = new URL(destination).searchParams.get('request');
  if (!requestId) throw new Error('Missing approval');
  await service.approvalInfo(requestId, browser, actor);
  const approval = await service.approve(
    requestId,
    browser,
    actor,
    'approve',
    scopes
  );
  const code = new URL(approval.redirectUrl).searchParams.get('code');
  if (!code) throw new Error('Missing authorization code');
  return service.exchange({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1/callback',
    code,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  });
}
function rpc(name: string, args: object, token?: string) {
  return serveFeedMcp(
    new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    service,
    { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY }
  );
}
const resultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
  }),
});
async function parsed(response: Response) {
  return resultSchema.parse(await response.json()).result;
}

// A missing database must fail, not silently claim this acceptance passed.
describe('OAuth player actions use shared domain services', () => {
  beforeAll(async () => {
    actor = await createUser();
    author = await createUser();
  });
  afterAll(async () => {
    if (clients.length)
      await db
        .delete(mcpOAuthRequests)
        .where(inArray(mcpOAuthRequests.clientId, clients));
    await db.delete(notifications).where(inArray(notifications.userId, ids));
    await db.delete(shares).where(inArray(shares.userId, ids));
    await db.delete(posts).where(inArray(posts.authorId, ids));
    await db.delete(userBlocks).where(inArray(userBlocks.blockerId, ids));
    await db.delete(users).where(inArray(users.id, ids));
    if (clients.length)
      await db
        .delete(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, clients));
  });

  test('anonymous and read-only calls are challenged for social:write before any mutation', async () => {
    const postId = await createPost();
    const anonymous = await rpc('repost', { postId });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('social:write');
    expect(JSON.stringify(await anonymous.json())).toContain(
      'mcp/www_authenticate'
    );
    const token = await grant(['read']);
    const readOnly = await rpc('repost', { postId }, token.access_token);
    expect(readOnly.status).toBe(403);
    expect(readOnly.headers.get('www-authenticate')).toContain('social:write');
    expect(
      await db.select().from(shares).where(eq(shares.postId, postId))
    ).toHaveLength(0);
  });

  test('repost persists under the approved account, notifies author, records client, and unrepost reverses it', async () => {
    await resetRateLimit(actor, RATE_LIMIT_CONFIGS.SHARE_POST.actionType);
    const postId = await createPost();
    const token = await grant(['social:write']);
    const context = await service.authenticate(token.access_token);
    if (!context) throw new Error('Missing authenticated context');
    const created = await parsed(
      await rpc('repost', { postId }, token.access_token)
    );
    expect(created.isError).not.toBe(true);
    const result = z
      .object({ repostId: z.string(), isShared: z.literal(true) })
      .parse(JSON.parse(created.content[0]?.text ?? ''));
    const [persisted] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, result.repostId));
    expect(persisted?.authorId).toBe(actor);
    expect(persisted?.originalPostId).toBe(postId);
    expect(
      await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, author),
            eq(notifications.actorId, actor),
            eq(notifications.postId, postId)
          )
        )
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(mcpOAuthAudit)
        .where(
          and(
            eq(mcpOAuthAudit.grantId, context.grantId),
            eq(mcpOAuthAudit.event, 'repost')
          )
        )
    ).toHaveLength(1);
    const removed = await parsed(
      await rpc('unrepost', { postId }, token.access_token)
    );
    expect(removed.isError).not.toBe(true);
    expect(
      await db.select().from(posts).where(eq(posts.id, result.repostId))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(mcpOAuthAudit)
        .where(
          and(
            eq(mcpOAuthAudit.grantId, context.grantId),
            eq(mcpOAuthAudit.event, 'unrepost')
          )
        )
    ).toHaveLength(1);
  });

  test('strict input cannot substitute another account', async () => {
    const token = await grant(['social:write']);
    const postId = await createPost();
    const response = await parsed(
      await rpc('repost', { postId, userId: author }, token.access_token)
    );
    expect(response.isError).toBe(true);
    expect(
      await db.select().from(shares).where(eq(shares.postId, postId))
    ).toHaveLength(0);
  });

  test('web limiter and OAuth calls consume the same account quota', async () => {
    await resetRateLimit(actor, RATE_LIMIT_CONFIGS.SHARE_POST.actionType);
    for (let i = 0; i < RATE_LIMIT_CONFIGS.SHARE_POST.maxRequests; i++) {
      expect(
        (await checkRateLimitAsync(actor, RATE_LIMIT_CONFIGS.SHARE_POST))
          .allowed
      ).toBe(true);
    }
    const token = await grant(['social:write']);
    const postId = await createPost();
    const denied = await parsed(
      await rpc('repost', { postId }, token.access_token)
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('RATE_LIMIT');
    expect(
      await db.select().from(shares).where(eq(shares.postId, postId))
    ).toHaveLength(0);
  });
  test('SDK discovery agrees with actual capability names and strict action schemas', async () => {
    const response = await serveFeedMcp(
      new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      }),
      service,
      { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY }
    );
    const data = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              inputSchema: z.object({ additionalProperties: z.boolean() }),
            })
          ),
        }),
      })
      .parse(await response.json());
    expect(data.result.tools.map((tool) => tool.name).sort()).toEqual(
      [...FEED_MCP_CAPABILITIES.tools].sort()
    );
    expect(
      data.result.tools.find((tool) => tool.name === 'repost')?.inputSchema
        .additionalProperties
    ).toBe(false);
  });

  test('blocked, deleted, unknown, and duplicate posts never create extra shares', async () => {
    await resetRateLimit(actor, RATE_LIMIT_CONFIGS.SHARE_POST.actionType);
    const token = await grant(['social:write']);
    const postId = await createPost();
    for (const [blockerId, blockedId] of [
      [actor, author],
      [author, actor],
    ] as const) {
      const blockId = await generateSnowflakeId();
      await db.insert(userBlocks).values({ id: blockId, blockerId, blockedId });
      const denied = await parsed(
        await rpc('repost', { postId }, token.access_token)
      );
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain('BLOCKED_USER');
      await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
    }
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));
    expect(
      (await parsed(await rpc('repost', { postId }, token.access_token)))
        .isError
    ).toBe(true);
    expect(
      (
        await parsed(
          await rpc('repost', { postId: 'unknown-post' }, token.access_token)
        )
      ).isError
    ).toBe(true);
    expect(
      await db.select().from(shares).where(eq(shares.postId, postId))
    ).toHaveLength(0);
    await resetRateLimit(actor, RATE_LIMIT_CONFIGS.SHARE_POST.actionType);
    const freshPost = await createPost();
    expect(
      (
        await parsed(
          await rpc('repost', { postId: freshPost }, token.access_token)
        )
      ).isError
    ).not.toBe(true);
    const duplicate = await parsed(
      await rpc('repost', { postId: freshPost }, token.access_token)
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0]?.text).toContain('ALREADY_SHARED');
    expect(
      await db.select().from(shares).where(eq(shares.postId, freshPost))
    ).toHaveLength(1);
  });
});
