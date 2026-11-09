import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  dbWrite,
  inArray,
  mcpOAuthClients,
  mcpOAuthRequests,
  users,
} from '@feed/db';
import { FeedOAuthService, hash, opaque, serveFeedMcp } from '@feed/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import {
  DELETE as disconnectConnection,
  GET as listConnections,
} from '../../../apps/web/src/app/oauth/consents/route';
import { accountConnections } from '../../../apps/web/src/lib/auth/connected-agents';

const databaseUrl = process.env.DATABASE_URL;
const allowed = databaseUrl ? new URL(databaseUrl) : null;
const safeDatabase =
  !!allowed &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(allowed.hostname) &&
  /^\/(?:test_db|feed_pr\d+|feed_onboarding_[a-z0-9_]+)$/.test(
    allowed.pathname
  ) &&
  ['test', 'development'].includes(process.env.NODE_ENV ?? '');
const run = describe.skipIf(!safeDatabase);
const ownerA = `connections-A-${randomUUID()}`;
const ownerB = `connections-B-${randomUUID()}`;
const identityA = `steward-A-${randomUUID()}`;
const identityB = `steward-B-${randomUUID()}`;
const clientIds: string[] = [];
const sdkClients: Client[] = [];
const previous = {
  app: process.env.NEXT_PUBLIC_APP_URL,
  secret: process.env.STEWARD_JWT_SECRET,
  tenant: process.env.STEWARD_TENANT_ID,
};
const tenant = 'connections-settings-fixture';
const secret = `local-test-only-${randomUUID()}`;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let service: FeedOAuthService;
let cookieA: string;
let cookieB: string;
const mcpRequests: { status: number; authorizationHash: string }[] = [];

async function cookie(identity: string) {
  const jwt = await new SignJWT({ userId: identity, tenantId: tenant })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(secret));
  return `steward-token=${jwt}`;
}
run('Connected agents settings over real HTTP and MCP SDK', () => {
  beforeAll(async () => {
    process.env.STEWARD_JWT_SECRET = secret;
    process.env.STEWARD_TENANT_ID = tenant;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/oauth/consents') {
          const next = new NextRequest(request);
          return request.method === 'DELETE'
            ? disconnectConnection(next)
            : listConnections(next);
        }
        if (path === '/mcp') {
          const response = await serveFeedMcp(request, service, {
            about: 'Feed test world',
            howToPlay: 'Use virtual points with no cash value.',
          });
          mcpRequests.push({
            status: response.status,
            authorizationHash: hash(request.headers.get('authorization') ?? ''),
          });
          return response;
        }
        return new Response('Not found', { status: 404 });
      },
    });
    origin = server.url.origin;
    process.env.NEXT_PUBLIC_APP_URL = origin;
    service = new FeedOAuthService(origin);
    await dbWrite.insert(users).values([
      {
        id: ownerA,
        stewardId: identityA,
        username: ownerA,
        profileComplete: true,
        tosAcceptedAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: ownerB,
        stewardId: identityB,
        username: ownerB,
        profileComplete: true,
        tosAcceptedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    cookieA = await cookie(identityA);
    cookieB = await cookie(identityB);
  });
  afterAll(async () => {
    await Promise.all(sdkClients.map((client) => client.close()));
    server?.stop(true);
    if (clientIds.length)
      await dbWrite
        .delete(mcpOAuthRequests)
        .where(inArray(mcpOAuthRequests.clientId, clientIds));
    await dbWrite.delete(users).where(inArray(users.id, [ownerA, ownerB]));
    if (clientIds.length)
      await dbWrite
        .delete(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, clientIds));
    for (const [name, value] of [
      ['NEXT_PUBLIC_APP_URL', previous.app],
      ['STEWARD_JWT_SECRET', previous.secret],
      ['STEWARD_TENANT_ID', previous.tenant],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  async function mint(ownerId: string, name: string) {
    const client = await service.register({
      client_name: name,
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    });
    clientIds.push(client.client_id);
    const verifier = 'v'.repeat(64);
    const browser = opaque('fmcpcb');
    const redirect = 'http://127.0.0.1:49810/callback';
    const approval = await service.authorize(
      {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirect,
        state: 'settings-test',
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        scope: 'read',
        resource: `${origin}/mcp`,
      },
      browser
    );
    const requestId = new URL(approval).searchParams.get('request');
    if (!requestId) throw new Error('No approval request');
    await service.approvalInfo(requestId, browser, ownerId);
    const approved = await service.approve(
      requestId,
      browser,
      ownerId,
      'approve',
      ['read']
    );
    const code = new URL(approved.redirectUrl).searchParams.get('code');
    if (!code) throw new Error('No authorization code');
    return service.exchange({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: `${origin}/mcp`,
    });
  }
  async function connect(token: string) {
    const client = new Client({
      name: 'Feed connections settings test',
      version: '1.0.0',
    });
    sdkClients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    return client;
  }
  async function list(session: string) {
    const response = await fetch(`${origin}/oauth/consents`, {
      headers: { Cookie: session },
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function revoke(
    session: string,
    grantId: string,
    requestOrigin = origin
  ) {
    return fetch(`${origin}/oauth/consents`, {
      method: 'DELETE',
      headers: {
        Cookie: session,
        Origin: requestOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grantId }),
    });
  }
  test('lists the canonical Feed owner, rejects mismatched responses, and revokes only the chosen grant', async () => {
    const first = await mint(ownerA, 'First agent');
    const second = await mint(ownerA, 'Second agent');
    await mint(ownerB, 'Other account agent');
    const original = await list(cookieA);
    const parsed = accountConnections(original, ownerA);
    if (!parsed.ok) throw new Error('Owner list did not match');
    expect(parsed.grants).toHaveLength(2);
    expect(accountConnections(original, identityA)).toEqual({
      ok: false,
      error: 'account_changed',
    });
    expect(accountConnections(original, ownerB)).toEqual({
      ok: false,
      error: 'account_changed',
    });
    expect(JSON.stringify(original)).not.toContain('access_token');
    expect(JSON.stringify(original)).not.toContain('refresh_token');
    const firstContext = await service.authenticate(first.access_token);
    const secondContext = await service.authenticate(second.access_token);
    if (!firstContext || !secondContext)
      throw new Error('Missing token context');
    const firstClient = await connect(first.access_token);
    const secondClient = await connect(second.access_token);
    expect(
      (await firstClient.callTool({ name: 'whoami', arguments: {} })).isError
    ).not.toBe(true);
    expect((await revoke(cookieB, firstContext.grantId)).status).toBe(200);
    expect(
      (await firstClient.callTool({ name: 'whoami', arguments: {} })).isError
    ).not.toBe(true);
    expect(
      (await revoke(cookieA, firstContext.grantId, 'https://other.example'))
        .status
    ).toBe(403);
    expect(
      (await firstClient.callTool({ name: 'whoami', arguments: {} })).isError
    ).not.toBe(true);
    expect((await revoke(cookieA, firstContext.grantId)).status).toBe(200);
    const refreshed = accountConnections(await list(cookieA), ownerA);
    if (!refreshed.ok) throw new Error('Readback owner mismatch');
    expect(
      refreshed.grants.find((grant) => grant.id === firstContext.grantId)
        ?.revokedAt
    ).not.toBeNull();
    expect(
      refreshed.grants.find((grant) => grant.id === secondContext.grantId)
        ?.revokedAt
    ).toBeNull();
    await expect(
      firstClient.callTool({ name: 'whoami', arguments: {} })
    ).rejects.toThrow();
    const failed = mcpRequests.at(-1);
    expect(failed?.status).toBe(401);
    expect(failed?.authorizationHash).toBe(
      hash(`Bearer ${first.access_token}`)
    );
    expect(
      (await secondClient.callTool({ name: 'whoami', arguments: {} })).isError
    ).not.toBe(true);
    expect((await revoke(cookieA, firstContext.grantId)).status).toBe(200);
    const others = accountConnections(await list(cookieB), ownerB);
    expect(others.ok ? others.grants.length : -1).toBe(1);
  });
  test('requires a browser session and ignores a conflicting bearer identity', async () => {
    expect((await fetch(`${origin}/oauth/consents`)).status).toBe(401);
    const headers = {
      Cookie: cookieA,
      Authorization: `Bearer ${cookieB.slice('steward-token='.length)}`,
    };
    const response = await fetch(`${origin}/oauth/consents`, { headers });
    expect(response.status).toBe(200);
    expect(accountConnections(await response.json(), ownerA).ok).toBe(true);
  });
});
