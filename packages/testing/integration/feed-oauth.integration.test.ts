import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  dbWrite,
  eq,
  mcpOAuthGrants as grants,
  inArray,
  mcpOAuthClients,
  mcpOAuthRequests,
  mcpOAuthTokens,
  users,
} from '@feed/db';
import {
  appOrigin,
  FeedOAuthService,
  hash,
  opaque,
  serveFeedMcp,
} from '@feed/mcp';
import { FEED_ABOUT, FEED_HOW_TO_PLAY } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import {
  GET as approvalGet,
  POST as approvalPost,
} from '../../../apps/web/src/app/api/oauth/approve/route';
import {
  GET as mcpGet,
  POST as mcpPost,
} from '../../../apps/web/src/app/mcp/route';
import { GET as authorizeGet } from '../../../apps/web/src/app/oauth/authorize/route';
import { POST as registerPost } from '../../../apps/web/src/app/oauth/register/route';
import { POST as tokenPost } from '../../../apps/web/src/app/oauth/token/route';
import {
  browserAccount,
  formParameters,
  jsonObject,
} from '../../../apps/web/src/lib/auth/feed-oauth';

const databaseUrl = process.env.DATABASE_URL;
const canRun =
  !!databaseUrl &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname) &&
  process.env.NODE_ENV !== 'production';
const run = describe.skipIf(!canRun);
const origin = 'https://feed-oauth.example';
const service = new FeedOAuthService(origin);
const userId = `oauth-test-${randomUUID()}`;
const otherId = `oauth-test-${randomUUID()}`;
const clientIds: string[] = [];
const browser = opaque('fmcpcb');
const verifier = 'a'.repeat(64);
const callback = 'http://127.0.0.1:48291/callback';

run('Feed MCP OAuth with a real database', () => {
  beforeAll(async () => {
    await dbWrite.insert(users).values([
      {
        id: userId,
        stewardId: userId,
        username: userId,
        updatedAt: new Date(),
        profileComplete: true,
        tosAcceptedAt: new Date(),
      },
      {
        id: otherId,
        stewardId: otherId,
        username: otherId,
        updatedAt: new Date(),
        profileComplete: true,
        tosAcceptedAt: new Date(),
      },
    ]);
  });
  afterAll(async () => {
    if (clientIds.length)
      await dbWrite
        .delete(mcpOAuthRequests)
        .where(inArray(mcpOAuthRequests.clientId, clientIds));
    await dbWrite.delete(users).where(inArray(users.id, [userId, otherId]));
    if (clientIds.length)
      await dbWrite
        .delete(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, clientIds));
  });

  async function pending() {
    const client = await service.register({
      client_name: 'OAuth integration client',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      client_uri: 'https://client.example/',
    });
    clientIds.push(client.client_id);
    const destination = await service.authorize(
      {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: callback,
        state: 'opaque client state',
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        scope: 'read',
        resource: `${origin}/mcp/`,
      },
      browser
    );
    const requestId = new URL(destination).searchParams.get('request');
    if (!requestId) throw new Error('Missing approval request');
    return { clientId: client.client_id, requestId };
  }
  async function approved() {
    const current = await pending();
    const display = await service.approvalInfo(
      current.requestId,
      browser,
      userId
    );
    expect(display.account.handle).toBe(userId);
    const result = await service.approve(
      current.requestId,
      browser,
      userId,
      'approve',
      ['read']
    );
    const code = new URL(result.redirectUrl).searchParams.get('code');
    if (!code) throw new Error('Missing code');
    return { ...current, code };
  }
  async function redeemed() {
    const approval = await approved();
    const result = await service.exchange({
      grant_type: 'authorization_code',
      client_id: approval.clientId,
      code: approval.code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
    });
    return { approval, result };
  }

  test('PKCE redemption authenticates the same account, stores only hashes, and cannot replay the code', async () => {
    const { approval, result } = await redeemed();
    const context = await service.authenticate(result.access_token);
    expect(context?.accountId).toBe(userId);
    expect(context?.scopes).toEqual(['read']);
    const [stored] = await dbWrite
      .select()
      .from(mcpOAuthTokens)
      .where(eq(mcpOAuthTokens.hash, hash(result.access_token)));
    expect(stored?.hash).not.toBe(result.access_token);
    await expect(
      service.exchange({
        grant_type: 'authorization_code',
        client_id: approval.clientId,
        code: approval.code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: `${origin}/mcp`,
      })
    ).rejects.toThrow('invalid_grant');
  });

  test('wrong PKCE and wrong resource fail without consuming the valid code', async () => {
    const approval = await approved();
    const input = {
      grant_type: 'authorization_code',
      client_id: approval.clientId,
      code: approval.code,
      code_verifier: 'b'.repeat(64),
      redirect_uri: callback,
      resource: `${origin}/mcp`,
    };
    await expect(service.exchange(input)).rejects.toThrow('invalid_grant');
    await expect(
      service.exchange({
        ...input,
        code_verifier: verifier,
        resource: 'https://other.example/mcp',
      })
    ).rejects.toThrow('invalid_target');
    expect(
      (await service.exchange({ ...input, code_verifier: verifier }))
        .access_token
    ).toStartWith('fmcpa_');
  });

  test('refresh tokens rotate atomically and replay revokes the whole grant', async () => {
    const { approval, result } = await redeemed();
    const input = {
      grant_type: 'refresh_token',
      client_id: approval.clientId,
      refresh_token: result.refresh_token,
      resource: `${origin}/mcp`,
    };
    const next = await service.exchange(input);
    expect(next.refresh_token).not.toBe(result.refresh_token);
    await expect(service.exchange(input)).rejects.toThrow('invalid_grant');
    expect(await service.authenticate(next.access_token)).toBeNull();
    expect(await service.authenticate(result.access_token)).toBeNull();
  });

  test('concurrent redemption has one winner and one invalid_grant', async () => {
    const approval = await approved();
    const input = {
      grant_type: 'authorization_code',
      client_id: approval.clientId,
      code: approval.code,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
    };
    const results = await Promise.allSettled([
      service.exchange(input),
      service.exchange(input),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
  });

  test('browser and displayed account binding reject substitution and scope escalation', async () => {
    const approval = await pending();
    await expect(
      service.approvalInfo(approval.requestId, 'other-browser', userId)
    ).rejects.toThrow('invalid_request');
    await service.approvalInfo(approval.requestId, browser, userId);
    await expect(
      service.approve(approval.requestId, browser, otherId, 'approve', ['read'])
    ).rejects.toThrow('account_changed');
    await expect(
      service.approve(approval.requestId, browser, userId, 'approve', ['trade'])
    ).rejects.toThrow('invalid_scope');
    await expect(
      service.approve(approval.requestId, browser, userId, 'approve', [])
    ).rejects.toThrow('invalid_scope');
    const denied = await service.approve(
      approval.requestId,
      browser,
      userId,
      'deny',
      []
    );
    expect(new URL(denied.redirectUrl).searchParams.get('error')).toBe(
      'access_denied'
    );
    await expect(
      service.approvalInfo(approval.requestId, browser, userId)
    ).rejects.toThrow('invalid_request');
  });

  test('revocation is account-bound and effective on the next authenticated call', async () => {
    const { result } = await redeemed();
    const context = await service.authenticate(result.access_token);
    if (!context) throw new Error('Missing context');
    await service.revokeGrant(otherId, context.grantId);
    expect(await service.authenticate(result.access_token)).not.toBeNull();
    await service.revokeGrant(userId, context.grantId);
    expect(await service.authenticate(result.access_token)).toBeNull();
  });

  test('expired grants fail authentication', async () => {
    const { result } = await redeemed();
    const context = await service.authenticate(result.access_token);
    if (!context) throw new Error('Missing context');
    await dbWrite
      .update(grants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(grants.id, context.grantId));
    expect(await service.authenticate(result.access_token)).toBeNull();
  });

  test('denial remains available with incomplete profile and no selected scopes', async () => {
    const approval = await pending();
    await dbWrite
      .update(users)
      .set({ profileComplete: false })
      .where(eq(users.id, userId));
    await expect(
      service.approvalInfo(approval.requestId, browser, userId)
    ).rejects.toThrow('profile_required');
    const result = await service.approve(
      approval.requestId,
      browser,
      userId,
      'deny',
      []
    );
    expect(new URL(result.redirectUrl).searchParams.get('error')).toBe(
      'access_denied'
    );
    await dbWrite
      .update(users)
      .set({ profileComplete: true })
      .where(eq(users.id, userId));
  });

  test('banned users fail token authentication', async () => {
    const { result } = await redeemed();
    await dbWrite
      .update(users)
      .set({ isBanned: true })
      .where(eq(users.id, userId));
    expect(await service.authenticate(result.access_token)).toBeNull();
    await dbWrite
      .update(users)
      .set({ isBanned: false })
      .where(eq(users.id, userId));
  });

  test('HTTP MCP public preview works anonymously; whoami challenges then confirms account and Social privacy', async () => {
    const content = { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY };
    const call = (name: string, token?: string) =>
      serveFeedMcp(
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
            params: { name, arguments: {} },
          }),
        }),
        service,
        content
      );
    expect((await call('about_feed')).status).toBe(200);
    const denied = await call('whoami');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain(
      'oauth-protected-resource/mcp'
    );
    expect(JSON.stringify(await denied.json())).toContain(
      'mcp/www_authenticate'
    );
    const { result } = await redeemed();
    const response = await call('whoami', result.access_token);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(userId);
    await dbWrite
      .update(users)
      .set({ uiMode: 'social' })
      .where(eq(users.id, userId));
    const social = await call('whoami', result.access_token);
    const body = JSON.stringify(await social.json());
    expect(body).toContain('social');
    expect(body).not.toContain('balance');
    await dbWrite
      .update(users)
      .set({ uiMode: 'game' })
      .where(eq(users.id, userId));
  });

  test('actual Next routes enforce browser approval Origin and complete the OAuth-to-MCP handoff', async () => {
    const keys = [
      'NEXT_PUBLIC_APP_URL',
      'STEWARD_TENANT_ID',
      'STEWARD_JWT_SECRET',
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );
    try {
      process.env.NEXT_PUBLIC_APP_URL = origin;
      process.env.STEWARD_TENANT_ID = 'oauth-test';
      process.env.STEWARD_JWT_SECRET = 'oauth-route-test-secret';
      const token = await new SignJWT({ userId, tenantId: 'oauth-test' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('steward')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('oauth-route-test-secret'));
      const registration = await registerPost(
        new NextRequest(`${origin}/oauth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Next route client',
            redirect_uris: [callback],
            token_endpoint_auth_method: 'none',
          }),
        })
      );
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      clientIds.push(client.client_id);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: callback,
        state: 'original client state',
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        resource: `${origin}/mcp`,
        scope: 'read',
      });
      const authorization = await authorizeGet(
        new NextRequest(`${origin}/oauth/authorize?${params}`)
      );
      expect(authorization.status).toBe(307);
      const destination = new URL(authorization.headers.get('location') ?? '');
      const requestId = destination.searchParams.get('request');
      const bindingCookie = authorization.headers
        .get('set-cookie')
        ?.split(';')[0];
      if (!bindingCookie || !requestId)
        throw new Error('Missing browser-bound transaction');
      const bearerOnly = await approvalGet(
        new NextRequest(`${origin}/api/oauth/approve?request=${requestId}`, {
          headers: { cookie: bindingCookie, Authorization: `Bearer ${token}` },
        })
      );
      expect(bearerOnly.status).toBe(401);
      const cookie = `${bindingCookie}; steward-token=${token}`;
      const preview = await approvalGet(
        new NextRequest(`${origin}/api/oauth/approve?request=${requestId}`, {
          headers: { cookie },
        })
      );
      expect(preview.status).toBe(200);
      const body = JSON.stringify({
        requestId,
        action: 'approve',
        scopes: ['read'],
      });
      const forged = await approvalPost(
        new NextRequest(`${origin}/api/oauth/approve`, {
          method: 'POST',
          headers: {
            cookie,
            Origin: 'https://attacker.example',
            'Content-Type': 'application/json',
          },
          body,
        })
      );
      expect(forged.status).toBe(403);
      const approved = await approvalPost(
        new NextRequest(`${origin}/api/oauth/approve`, {
          method: 'POST',
          headers: {
            cookie,
            Origin: origin,
            'Content-Type': 'application/json',
          },
          body,
        })
      );
      expect(approved.status).toBe(200);
      const approval = (await approved.json()) as { redirectUrl: string };
      const callbackUrl = new URL(approval.redirectUrl);
      expect(callbackUrl.searchParams.get('state')).toBe(
        'original client state'
      );
      expect(callbackUrl.searchParams.get('iss')).toBe(origin);
      const redeemed = await tokenPost(
        new NextRequest(`${origin}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: callbackUrl.searchParams.get('code') ?? '',
            redirect_uri: callback,
            code_verifier: verifier,
            resource: `${origin}/mcp`,
          }).toString(),
        })
      );
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers.get('cache-control')).toBe('no-store');
      const credentials = (await redeemed.json()) as { access_token: string };
      const whoami = await mcpPost(
        new NextRequest(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.access_token}`,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'whoami', arguments: {} },
          }),
        })
      );
      expect(whoami.status).toBe(200);
      expect(JSON.stringify(await whoami.json())).toContain(userId);
      const unknownToken = await mcpPost(
        new NextRequest(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer unknown-token',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      );
      expect(unknownToken.status).toBe(401);
      expect(unknownToken.headers.get('www-authenticate')).toContain(
        'oauth-protected-resource'
      );
      const discovery = await mcpGet(
        new NextRequest(`${origin}/mcp`, {
          headers: { Accept: 'text/event-stream' },
        })
      );
      expect(discovery.status).toBe(405);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test('browser account uses the verified cookie, not a conflicting header; cross-tenant fails', async () => {
    const keys = [
      'NEXT_PUBLIC_APP_URL',
      'STEWARD_TENANT_ID',
      'STEWARD_JWT_SECRET',
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );
    try {
      process.env.NEXT_PUBLIC_APP_URL = origin;
      process.env.STEWARD_TENANT_ID = 'oauth-test';
      const secret = new TextEncoder().encode('oauth-integration-test-secret');
      process.env.STEWARD_JWT_SECRET = 'oauth-integration-test-secret';
      const sign = (id: string, tenantId = 'oauth-test') =>
        new SignJWT({ userId: id, tenantId })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('steward')
          .setExpirationTime('5m')
          .sign(secret);
      const cookie = await sign(userId);
      const header = await sign(otherId);
      const account = await browserAccount(
        new NextRequest(`${origin}/api/oauth/approve`, {
          headers: {
            cookie: `steward-token=${cookie}`,
            Authorization: `Bearer ${header}`,
          },
        })
      );
      expect(account).toBe(userId);
      await expect(
        browserAccount(
          new NextRequest(`${origin}/api/oauth/approve`, {
            headers: {
              cookie: `steward-token=${await sign(userId, 'other-tenant')}`,
            },
          })
        )
      ).rejects.toThrow('access_denied');
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});

describe('OAuth HTTP input boundaries', () => {
  test('trusted configured localhost works, arbitrary insecure origins fail', () => {
    expect(appOrigin('http://localhost:3199')).toBe('http://localhost:3199');
    expect(() => appOrigin('http://example.com')).toThrow();
    expect(() => appOrigin('https://feed.example/other')).toThrow();
  });
  test('bounds bodies before parsing and rejects duplicate form parameters', async () => {
    await expect(
      jsonObject(
        new NextRequest('https://feed.example/oauth/register', {
          method: 'POST',
          body: JSON.stringify({ name: 'x'.repeat(20_000) }),
        })
      )
    ).rejects.toThrow('invalid_request');
    await expect(
      formParameters(
        new NextRequest('https://feed.example/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'client_id=a&client_id=b',
        })
      )
    ).rejects.toThrow('invalid_request');
  });
});
