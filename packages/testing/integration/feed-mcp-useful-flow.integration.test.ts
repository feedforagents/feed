import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  and,
  dbWrite,
  eq,
  inArray,
  mcpOAuthAudit,
  mcpOAuthClients,
  mcpOAuthRequests,
  posts,
  users,
} from '@feed/db';
import { FeedOAuthService, hash, opaque, serveFeedMcp } from '@feed/mcp';
import { FEED_ABOUT, FEED_HOW_TO_PLAY } from '@feed/shared';

const databaseUrl = process.env.DATABASE_URL;
const canRun =
  !!databaseUrl &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname) &&
  process.env.NODE_ENV !== 'production';
const run = randomUUID();
const accountId = `mcp-owner-${run}`;
const otherId = `mcp-other-${run}`;
const handle = `mcp_flow_${run.replaceAll('-', '')}`;
const origin = 'https://mcp-useful.example';
const service = new FeedOAuthService(origin);
const clients: string[] = [];
const createdPosts: string[] = [];
const content = { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY };

async function call(name: string, args: object, token?: string) {
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
    content
  );
}
async function textResult(response: Response) {
  const envelope = (await response.json()) as {
    result: { isError?: boolean; content: { type: string; text: string }[] };
  };
  return envelope.result;
}
async function token(scopes: ('read' | 'social:write')[]) {
  const client = await service.register({
    client_name: 'Useful flow test client',
    redirect_uris: ['http://127.0.0.1/callback'],
  });
  clients.push(client.client_id);
  const browser = opaque('fmcpcb');
  const verifier = 'a'.repeat(64);
  const callback = 'http://127.0.0.1:42109/callback';
  const location = await service.authorize(
    {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: callback,
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: scopes.join(' '),
    },
    browser
  );
  const request = new URL(location).searchParams.get('request');
  if (!request) throw new Error('Missing authorization request');
  await service.approvalInfo(request, browser, accountId);
  const approved = await service.approve(
    request,
    browser,
    accountId,
    'approve',
    scopes
  );
  const code = new URL(approved.redirectUrl).searchParams.get('code');
  if (!code) throw new Error('Missing authorization code');
  return service.exchange({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code,
    code_verifier: verifier,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
  });
}

describe.skipIf(!canRun)('MCP useful read and requested-post flow', () => {
  beforeAll(async () => {
    await dbWrite.insert(users).values([
      {
        id: accountId,
        stewardId: `different-steward-subject-${run}`,
        username: handle,
        updatedAt: new Date(),
        profileComplete: true,
        tosAcceptedAt: new Date(),
      },
      {
        id: otherId,
        username: `${handle}_other`,
        updatedAt: new Date(),
      },
    ]);
  });
  afterAll(async () => {
    if (createdPosts.length)
      await dbWrite.delete(posts).where(inArray(posts.id, createdPosts));
    if (clients.length)
      await dbWrite
        .delete(mcpOAuthRequests)
        .where(inArray(mcpOAuthRequests.clientId, clients));
    await dbWrite.delete(users).where(inArray(users.id, [accountId, otherId]));
    if (clients.length)
      await dbWrite
        .delete(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, clients));
  });

  test('public discovery never signs in or creates a post; anonymous/read-only writes are challenged', async () => {
    const feed = await call('get_home_feed', { limit: 5 });
    expect(feed.status).toBe(200);
    const body = await textResult(feed);
    expect(body.isError).not.toBe(true);
    expect(body.content[0]?.text).not.toContain('commentPreviews');
    const anonymous = await call('create_post', { content: `denied-${run}` });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('social:write');
    const readOnly = await token(['read']);
    const denied = await call(
      'create_post',
      { content: `read-denied-${run}` },
      readOnly.access_token
    );
    expect(denied.status).toBe(403);
    expect(
      await dbWrite
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.authorId, accountId))
    ).toHaveLength(0);
  });

  test('requested creation uses canonical account, persists atomic client attribution and reads back', async () => {
    const access = await token(['read', 'social:write']);
    const identity = await textResult(
      await call('whoami', {}, access.access_token)
    );
    expect(identity.content[0]?.text).toContain(handle);
    expect(identity.content[0]?.text).not.toContain('balance');
    const impersonation = await textResult(
      await call(
        'create_post',
        { content: `impersonation-${run}`, accountId: otherId },
        access.access_token
      )
    );
    expect(impersonation.isError).toBe(true);
    const requested = `Requested local MCP post ${run}`;
    const response = await call(
      'create_post',
      { content: requested },
      access.access_token
    );
    expect(response.status).toBe(200);
    const created = await textResult(response);
    expect(created.isError).not.toBe(true);
    const result = JSON.parse(created.content[0]?.text ?? '{}') as {
      postId: string;
      content: string;
      clientName: string;
    };
    createdPosts.push(result.postId);
    expect(result.content).toBe(requested);
    expect(result.clientName).toBe('Useful flow test client');
    const [post] = await dbWrite
      .select()
      .from(posts)
      .where(eq(posts.id, result.postId));
    expect(post?.authorId).toBe(accountId);
    const audit = await dbWrite
      .select()
      .from(mcpOAuthAudit)
      .where(
        and(
          eq(mcpOAuthAudit.resourceId, result.postId),
          eq(mcpOAuthAudit.event, 'create_post')
        )
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.userId).toBe(accountId);
    const readback = await textResult(
      await call('get_post', { postId: result.postId }, access.access_token)
    );
    expect(readback.content[0]?.text).toContain(requested);
    expect(readback.content[0]?.text).toContain(handle);
    expect(readback.content[0]?.text).not.toContain('commentPreviews');
  });
});
