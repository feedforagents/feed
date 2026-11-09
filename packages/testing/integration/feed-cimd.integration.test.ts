import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  mcpOAuthClients as clients,
  dbWrite,
  mcpOAuthDevices as devices,
  eq,
  inArray,
  mcpOAuthRequests as requests,
  users,
} from '@feed/db';
import {
  type CimdNetwork,
  DEVICE_GRANT_TYPE,
  FeedDeviceService,
  FeedOAuthService,
  hash,
  opaque,
} from '@feed/mcp';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET as metadataGet } from '../../../apps/web/src/app/.well-known/oauth-authorization-server/route';
import {
  GET as approvalGet,
  POST as approvalPost,
} from '../../../apps/web/src/app/api/oauth/approve/route';
import { POST as mcpPost } from '../../../apps/web/src/app/mcp/route';
import { GET as authorizeGet } from '../../../apps/web/src/app/oauth/authorize/route';
import { POST as revokePost } from '../../../apps/web/src/app/oauth/revoke/route';
import { POST as tokenPost } from '../../../apps/web/src/app/oauth/token/route';

const databaseUrl = process.env.DATABASE_URL;
const canRun =
  !!databaseUrl &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname) &&
  process.env.NODE_ENV !== 'production';
const origin = 'https://feed-cimd.example';
const metadataOrigin = 'https://metadata.example.com';
const actor = `cimd-${randomUUID()}`;
const clientIds: string[] = [];
const verifier = 'a'.repeat(64);
const browser = opaque('fmcpcb');

// Network responses are isolated contract fixtures. Persistence, approvals,
// PKCE, token rotation and resulting identity use the real local database.
function fixture(grantTypes = ['authorization_code'], cache = 'no-store') {
  const clientId = `${metadataOrigin}/client-${'fixture-'.repeat(8)}${randomUUID()}.json`;
  clientIds.push(clientId);
  const state = {
    calls: 0,
    callback: 'http://127.0.0.1:9001/callback',
    grantTypes,
    cache,
    unknown: 'discard me',
  };
  const network: CimdNetwork = {
    resolveAddresses: async () => ['1.1.1.1'],
    fetchMetadata: async () => {
      state.calls++;
      return new Response(
        JSON.stringify({
          client_id: clientId,
          client_name: 'CIMD fixture',
          redirect_uris: state.grantTypes.includes('authorization_code')
            ? [state.callback]
            : [],
          grant_types: state.grantTypes,
          unknown_extension: state.unknown,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': state.cache,
          },
        }
      );
    },
  };
  const service = new FeedOAuthService(origin, {
    allowedOrigins: [metadataOrigin],
    network,
  });
  const authorize = async (scope = 'read') => {
    const location = await service.authorize(
      {
        client_id: clientId,
        response_type: 'code',
        redirect_uri: state.callback,
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        resource: `${origin}/mcp`,
        scope,
      },
      browser
    );
    const requestId = new URL(location).searchParams.get('request');
    if (!requestId) throw new Error('Missing fixture approval request');
    return requestId;
  };
  return { clientId, state, service, authorize };
}
describe.skipIf(!canRun)('CIMD registration with real Postgres', () => {
  beforeAll(async () => {
    await dbWrite.insert(users).values({
      id: actor,
      stewardId: actor,
      username: actor,
      profileComplete: true,
      tosAcceptedAt: new Date(),
      updatedAt: new Date(),
    });
  });
  afterAll(async () => {
    if (clientIds.length) {
      await dbWrite.delete(devices).where(inArray(devices.clientId, clientIds));
      await dbWrite
        .delete(requests)
        .where(inArray(requests.clientId, clientIds));
    }
    await dbWrite.delete(users).where(eq(users.id, actor));
    if (clientIds.length)
      await dbWrite.delete(clients).where(inArray(clients.id, clientIds));
  });
  test('DCR ignores extensions without accepting unsupported authentication or grants', async () => {
    const service = new FeedOAuthService(origin);
    const registered = await service.register({
      client_name: 'Extension fixture',
      redirect_uris: ['http://127.0.0.1:9001/callback'],
      software_id: 'fixture-extension',
      example_extension: { nested: true },
    });
    clientIds.push(registered.client_id);
    expect('software_id' in registered).toBe(false);
    expect('example_extension' in registered).toBe(false);
    const row = await service.resolveClient(registered.client_id);
    expect(row?.name).toBe('Extension fixture');
    expect('example_extension' in (row ?? {})).toBe(false);
    for (const unsupported of [
      { token_endpoint_auth_method: 'client_secret_basic' },
      { grant_types: ['client_credentials'] },
    ])
      await expect(
        service.register({
          client_name: 'Unsupported fixture',
          redirect_uris: ['http://127.0.0.1:9001/callback'],
          ...unsupported,
        })
      ).rejects.toThrow();
  });
  test('cache reuses only explicitly fresh validated registry fields', async () => {
    const { service, state, clientId } = fixture(
      ['authorization_code'],
      'max-age=120'
    );
    const first = await service.resolveClient(clientId);
    const second = await service.resolveClient(clientId);
    expect(first?.id).toBe(clientId);
    expect(second?.name).toBe('CIMD fixture');
    expect(state.calls).toBe(1);
    expect('unknown_extension' in (second ?? {})).toBe(false);
    await dbWrite
      .update(clients)
      .set({ metadataExpiresAt: new Date(0) })
      .where(eq(clients.id, clientId));
    await service.resolveClient(clientId);
    expect(state.calls).toBe(2);
  });
  test('no-store/no-cache metadata is fetched again, and disabled policy cannot reuse a cached URL client', async () => {
    const { service, state, clientId } = fixture();
    await service.resolveClient(clientId);
    await service.resolveClient(clientId);
    expect(state.calls).toBe(2);
    state.cache = 'no-cache, max-age=3600';
    await service.resolveClient(clientId);
    await service.resolveClient(clientId);
    expect(state.calls).toBe(4);
    await expect(
      new FeedOAuthService(origin).resolveClient(clientId)
    ).rejects.toThrow();
    expect(state.calls).toBe(4);
  });
  test('changed metadata cannot broaden pending code scopes/refresh or rewrite its callback/PKCE', async () => {
    const { service, state, clientId, authorize } = fixture();
    const originalCallback = state.callback;
    const requestId = await authorize('read');
    state.callback = 'https://client.example/changed-callback';
    state.grantTypes = ['authorization_code', 'refresh_token'];
    await service.resolveClient(clientId);
    const info = await service.approvalInfo(requestId, browser, actor);
    expect(info.client.metadataOrigin).toBe(metadataOrigin);
    expect(info.client.origin).toBe(new URL(originalCallback).origin);
    const approval = await service.approve(
      requestId,
      browser,
      actor,
      'approve',
      ['read']
    );
    const code = new URL(approval.redirectUrl).searchParams.get('code');
    if (!code) throw new Error('Missing fixture code');
    const calls = state.calls;
    await expect(
      service.exchange({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: state.callback,
        code_verifier: verifier,
        scope: 'read',
      })
    ).rejects.toThrow();
    await expect(
      service.exchange({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: originalCallback,
        code_verifier: verifier,
        scope: 'read social:write',
      })
    ).rejects.toThrow();
    const token = await service.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: originalCallback,
      code_verifier: verifier,
      scope: 'read',
    });
    expect('refresh_token' in token).toBe(false);
    expect(token.scope).toBe('read');
    expect((await service.authenticate(token.access_token))?.accountId).toBe(
      actor
    );
    expect(state.calls).toBe(calls);
  });
  test('metadata removal and restoration never bypasses consumed refresh reuse detection', async () => {
    const { service, state, clientId, authorize } = fixture([
      'authorization_code',
      'refresh_token',
    ]);
    const requestId = await authorize('read social:write');
    const approved = await service.approve(
      requestId,
      browser,
      actor,
      'approve',
      ['read', 'social:write']
    );
    const code = new URL(approved.redirectUrl).searchParams.get('code');
    if (!code) throw new Error('Missing fixture code');
    const initial = await service.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: state.callback,
      code_verifier: verifier,
    });
    if (!initial.refresh_token)
      throw new Error('Missing fixture refresh token');
    const next = await service.exchange({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: initial.refresh_token,
      scope: 'read',
    });
    state.grantTypes = ['authorization_code'];
    await service.resolveClient(clientId);
    await expect(
      service.exchange({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: initial.refresh_token,
      })
    ).rejects.toThrow();
    expect(await service.authenticate(next.access_token)).toBeNull();
  });
  test('Next routes default off, expose metadata host, complete cached CIMD PKCE and revoke long URL IDs', async () => {
    const keys = [
      'NEXT_PUBLIC_APP_URL',
      'FEED_OAUTH_CIMD_ALLOWED_ORIGINS',
      'STEWARD_TENANT_ID',
      'STEWARD_JWT_SECRET',
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );
    try {
      process.env.NEXT_PUBLIC_APP_URL = origin;
      delete process.env.FEED_OAUTH_CIMD_ALLOWED_ORIGINS;
      process.env.STEWARD_TENANT_ID = 'cimd-test';
      process.env.STEWARD_JWT_SECRET = 'cimd-local-route-fixture-secret';
      expect(
        (await metadataGet().json()).client_id_metadata_document_supported
      ).toBe(false);
      const { service, clientId, state } = fixture(
        ['authorization_code'],
        'max-age=120'
      );
      await service.resolveClient(clientId);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: state.callback,
        code_challenge: hash(verifier),
        code_challenge_method: 'S256',
        resource: `${origin}/mcp`,
        scope: 'read',
      });
      expect(
        (
          await authorizeGet(
            new NextRequest(`${origin}/oauth/authorize?${params}`)
          )
        ).status
      ).toBe(400);
      process.env.FEED_OAUTH_CIMD_ALLOWED_ORIGINS = metadataOrigin;
      expect(
        (await metadataGet().json()).client_id_metadata_document_supported
      ).toBe(true);
      const authorization = await authorizeGet(
        new NextRequest(`${origin}/oauth/authorize?${params}`)
      );
      expect(authorization.status).toBe(307);
      const requestId = new URL(
        authorization.headers.get('location') ?? ''
      ).searchParams.get('request');
      const binding = authorization.headers.get('set-cookie')?.split(';')[0];
      if (!requestId || !binding)
        throw new Error('Missing browser approval binding');
      const identity = await new SignJWT({
        userId: actor,
        tenantId: 'cimd-test',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('steward')
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode('cimd-local-route-fixture-secret'));
      const cookie = `${binding}; steward-token=${identity}`;
      const info = await approvalGet(
        new NextRequest(`${origin}/api/oauth/approve?request=${requestId}`, {
          headers: { cookie },
        })
      );
      expect(info.status).toBe(200);
      expect((await info.json()).client.metadataOrigin).toBe(metadataOrigin);
      const approved = await approvalPost(
        new NextRequest(`${origin}/api/oauth/approve`, {
          method: 'POST',
          headers: {
            cookie,
            Origin: origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requestId,
            action: 'approve',
            scopes: ['read'],
          }),
        })
      );
      expect(approved.status).toBe(200);
      const code = new URL(
        (await approved.json()).redirectUrl
      ).searchParams.get('code');
      if (!code) throw new Error('Missing approved authorization code');
      const redeemed = await tokenPost(
        new NextRequest(`${origin}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: state.callback,
            code_verifier: verifier,
          }).toString(),
        })
      );
      expect(redeemed.status).toBe(200);
      const credentials = await redeemed.json();
      const whoami = () =>
        mcpPost(
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
      const authenticated = await whoami();
      expect(authenticated.status).toBe(200);
      expect(JSON.stringify(await authenticated.json())).toContain(actor);
      const revoked = await revokePost(
        new NextRequest(`${origin}/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            token: credentials.access_token,
          }).toString(),
        })
      );
      expect(revoked.status).toBe(200);
      expect((await whoami()).status).toBe(401);
      expect(state.calls).toBe(1);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
  test('CIMD device request snapshots refresh authority before metadata changes', async () => {
    const { service, state, clientId } = fixture([DEVICE_GRANT_TYPE]);
    const device = new FeedDeviceService(service);
    const started = await device.start({
      client_id: clientId,
      resource: `${origin}/mcp`,
      scope: 'read',
    });
    state.grantTypes = [DEVICE_GRANT_TYPE, 'refresh_token'];
    await service.resolveClient(clientId);
    await device.info(started.user_code, browser, actor);
    await device.approve(started.user_code, browser, actor, 'approve', [
      'read',
    ]);
    const calls = state.calls;
    const token = await device.poll({
      grant_type: DEVICE_GRANT_TYPE,
      client_id: clientId,
      device_code: started.device_code,
    });
    if ('error' in token) throw new Error('Device token not issued');
    expect('refresh_token' in token).toBe(false);
    expect((await service.authenticate(token.access_token))?.accountId).toBe(
      actor
    );
    expect(state.calls).toBe(calls);
  });
});
