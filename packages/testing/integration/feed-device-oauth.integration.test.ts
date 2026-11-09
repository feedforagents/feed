import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  mcpOAuthClients as clients,
  dbWrite,
  mcpOAuthDevices as devices,
  eq,
  inArray,
  mcpOAuthRateLimits as rates,
  mcpOAuthRequests as requests,
  mcpOAuthTokens as tokens,
  users,
} from '@feed/db';
import {
  DEVICE_GRANT_TYPE,
  FeedDeviceService,
  FeedOAuthService,
  hash,
  opaque,
} from '@feed/mcp';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import {
  POST as deviceApprove,
  GET as deviceInfo,
} from '../../../apps/web/src/app/api/oauth/device/approve/route';
import { POST as deviceStart } from '../../../apps/web/src/app/oauth/device/authorization/route';
import { POST as tokenPost } from '../../../apps/web/src/app/oauth/token/route';

const databaseUrl = process.env.DATABASE_URL;
const canRun =
  !!databaseUrl &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname) &&
  process.env.NODE_ENV !== 'production';
const origin = 'https://feed-device.example';
const oauth = new FeedOAuthService(origin);
const device = new FeedDeviceService(origin);
const actor = `device-test-${randomUUID()}`;
const other = `device-test-${randomUUID()}`;
const stewardActor = `steward-${actor}`;
const stewardOther = `steward-${other}`;
const clientIds: string[] = [];
const browser = opaque('fmcpcb');

describe.skipIf(!canRun)(
  'RFC 8628 device authorization with real Postgres',
  () => {
    beforeAll(async () => {
      await dbWrite.insert(users).values([
        {
          id: actor,
          stewardId: stewardActor,
          username: actor,
          updatedAt: new Date(),
          profileComplete: true,
          tosAcceptedAt: new Date(),
        },
        {
          id: other,
          stewardId: stewardOther,
          username: other,
          updatedAt: new Date(),
          profileComplete: true,
          tosAcceptedAt: new Date(),
        },
      ]);
    });
    afterAll(async () => {
      if (clientIds.length) {
        await dbWrite
          .delete(devices)
          .where(inArray(devices.clientId, clientIds));
        await dbWrite
          .delete(requests)
          .where(inArray(requests.clientId, clientIds));
      }
      await dbWrite.delete(users).where(inArray(users.id, [actor, other]));
      if (clientIds.length)
        await dbWrite.delete(clients).where(inArray(clients.id, clientIds));
    });
    async function start(refresh = true, scope = 'read trade') {
      const client = await oauth.register({
        client_name: 'Headless test runtime',
        grant_types: refresh
          ? [DEVICE_GRANT_TYPE, 'refresh_token']
          : [DEVICE_GRANT_TYPE],
        response_types: [],
        token_endpoint_auth_method: 'none',
      });
      clientIds.push(client.client_id);
      return {
        client,
        result: await device.start({
          client_id: client.client_id,
          resource: `${origin}/mcp`,
          scope,
        }),
      };
    }
    const poll = (clientId: string, privateCode: string) =>
      device.poll({
        grant_type: DEVICE_GRANT_TYPE,
        client_id: clientId,
        device_code: privateCode,
        resource: `${origin}/mcp`,
      });

    test('device-only clients register without a callback, while auth-code clients still require one', async () => {
      const { client } = await start();
      expect(client.redirect_uris).toEqual([]);
      await expect(
        oauth.register({ client_name: 'No callback' })
      ).rejects.toThrow('invalid_client_metadata');
      await expect(
        oauth.authorize(
          {
            client_id: client.client_id,
            response_type: 'code',
            redirect_uri: 'http://127.0.0.1/callback',
            code_challenge: hash('a'.repeat(64)),
            code_challenge_method: 'S256',
            resource: `${origin}/mcp`,
          },
          browser
        )
      ).rejects.toThrow('unauthorized_client');
    });

    test('auth-code-only clients receive no unusable refresh token', async () => {
      const callback = 'http://127.0.0.1:8999/callback';
      const verifier = 'a'.repeat(64);
      const client = await oauth.register({
        client_name: 'Code-only test client',
        grant_types: ['authorization_code'],
        redirect_uris: [callback],
      });
      clientIds.push(client.client_id);
      const location = await oauth.authorize(
        {
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: callback,
          code_challenge: hash(verifier),
          code_challenge_method: 'S256',
          resource: `${origin}/mcp`,
          scope: 'read',
        },
        browser
      );
      const requestId = new URL(location).searchParams.get('request');
      if (!requestId) throw new Error('Missing code-only authorization');
      const approved = await oauth.approve(
        requestId,
        browser,
        actor,
        'approve',
        ['read']
      );
      const code = new URL(approved.redirectUrl).searchParams.get('code');
      if (!code) throw new Error('Missing code-only approval');
      const credentials = await oauth.exchange({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: callback,
        code_verifier: verifier,
        code,
        resource: `${origin}/mcp`,
      });
      expect('access_token' in credentials).toBe(true);
      expect('refresh_token' in credentials).toBe(false);
      expect(
        (await oauth.authenticate(credentials.access_token))?.accountId
      ).toBe(actor);
    });

    test('auth-code clients cannot request device authorization', async () => {
      const client = await oauth.register({
        client_name: 'Browser client',
        redirect_uris: ['http://127.0.0.1/callback'],
      });
      clientIds.push(client.client_id);
      await expect(
        device.start({ client_id: client.client_id, resource: `${origin}/mcp` })
      ).rejects.toThrow('unauthorized_client');
    });

    test('both credentials are hashed at rest and browser info never exposes the private credential', async () => {
      const { result } = await start();
      const [row] = await dbWrite
        .select()
        .from(devices)
        .where(eq(devices.hash, hash(result.device_code)));
      expect(row?.hash).not.toBe(result.device_code);
      expect(row?.userCodeHash).toBe(hash(result.user_code.replace('-', '')));
      const info = await device.info(
        result.user_code.toLowerCase(),
        browser,
        actor
      );
      expect(info.account.handle).toBe(actor);
      expect('device_code' in info).toBe(false);
      expect('access_token' in info).toBe(false);
      expect(info.userCode).toBe(result.user_code.replace('-', ''));
    });

    test('pending and slow_down are persisted, including the longer polling interval', async () => {
      const { client, result } = await start();
      expect((await poll(client.client_id, result.device_code)).error).toBe(
        'authorization_pending'
      );
      const early = await poll(client.client_id, result.device_code);
      expect(early.error).toBe('slow_down');
      expect('interval' in early && early.interval).toBe(10);
      const [row] = await dbWrite
        .select()
        .from(devices)
        .where(eq(devices.hash, hash(result.device_code)));
      expect(row?.interval).toBe(10);
      expect(row?.pollCount).toBe(2);
    });

    test('approved device tokens use the same account and reduced scopes; refresh rotation and revocation work', async () => {
      const { client, result } = await start();
      await device.info(result.user_code, browser, actor);
      await device.approve(result.user_code, browser, actor, 'approve', [
        'read',
      ]);
      const credentials = await poll(client.client_id, result.device_code);
      if ('error' in credentials || !credentials.refresh_token)
        throw new Error('Expected approved device tokens');
      const context = await oauth.authenticate(credentials.access_token);
      expect(context?.accountId).toBe(actor);
      expect(context?.scopes).toEqual(['read']);
      const issuedTokens = await dbWrite
        .select()
        .from(tokens)
        .where(
          inArray(tokens.hash, [
            hash(credentials.access_token),
            hash(credentials.refresh_token),
          ])
        );
      expect(issuedTokens).toHaveLength(2);
      expect(
        issuedTokens.every((token) => token.scopes?.join(' ') === 'read')
      ).toBe(true);
      const rotated = await oauth.exchange({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: credentials.refresh_token,
        resource: `${origin}/mcp`,
      });
      expect(await oauth.authenticate(rotated.access_token)).not.toBeNull();
      await expect(
        oauth.exchange({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: credentials.refresh_token,
          resource: `${origin}/mcp`,
        })
      ).rejects.toThrow('invalid_grant');
      expect(await oauth.authenticate(rotated.access_token)).toBeNull();
    });

    test('private device credential is consumed exactly once under concurrent polling', async () => {
      const { client, result } = await start();
      await device.approve(result.user_code, browser, actor, 'approve', [
        'read',
      ]);
      const results = await Promise.all([
        poll(client.client_id, result.device_code),
        poll(client.client_id, result.device_code),
      ]);
      expect(results.filter((value) => 'access_token' in value)).toHaveLength(
        1
      );
      expect(
        results.filter(
          (value) => 'error' in value && value.error === 'invalid_grant'
        )
      ).toHaveLength(1);
    });

    test('wrong client/resource, another browser/account, and scope escalation are rejected', async () => {
      const first = await start();
      const second = await start();
      await expect(
        poll(second.client.client_id, first.result.device_code)
      ).rejects.toThrow('invalid_grant');
      await expect(
        device.poll({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: first.client.client_id,
          device_code: first.result.device_code,
          resource: 'https://other.example/mcp',
        })
      ).rejects.toThrow('invalid_target');
      await device.info(first.result.user_code, browser, actor);
      await expect(
        device.info(first.result.user_code, 'other-browser', actor)
      ).rejects.toThrow('account_changed');
      await expect(
        device.approve(first.result.user_code, browser, other, 'approve', [
          'read',
        ])
      ).rejects.toThrow('account_changed');
      await expect(
        device.approve(first.result.user_code, browser, actor, 'approve', [
          'messages',
        ])
      ).rejects.toThrow('invalid_scope');
    });

    test('denial works with no selected scopes and an incomplete profile', async () => {
      const { client, result } = await start();
      await dbWrite
        .update(users)
        .set({ profileComplete: false })
        .where(eq(users.id, actor));
      try {
        await expect(
          device.info(result.user_code, browser, actor)
        ).rejects.toThrow('profile_required');
        expect(
          (await device.approve(result.user_code, browser, actor, 'deny', []))
            .status
        ).toBe('denied');
        expect((await poll(client.client_id, result.device_code)).error).toBe(
          'access_denied'
        );
      } finally {
        await dbWrite
          .update(users)
          .set({ profileComplete: true })
          .where(eq(users.id, actor));
      }
    });

    test('expiry and the bounded poll-attempt ceiling never issue tokens', async () => {
      const expired = await start();
      const attempts = await start();
      await dbWrite
        .update(devices)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(devices.hash, hash(expired.result.device_code)));
      expect(
        (await poll(expired.client.client_id, expired.result.device_code)).error
      ).toBe('expired_token');
      await dbWrite
        .update(devices)
        .set({ pollCount: 120 })
        .where(eq(devices.hash, hash(attempts.result.device_code)));
      expect(
        (await poll(attempts.client.client_id, attempts.result.device_code))
          .error
      ).toBe('expired_token');
    });

    test('device clients without refresh capability get only an access token', async () => {
      const { client, result } = await start(false);
      await device.approve(result.user_code, browser, actor, 'approve', [
        'read',
      ]);
      const credentials = await poll(client.client_id, result.device_code);
      expect('access_token' in credentials).toBe(true);
      expect('refresh_token' in credentials).toBe(false);
    });

    test('revoked or banned approved accounts cannot redeem device credentials', async () => {
      const revoked = await start();
      await device.approve(
        revoked.result.user_code,
        browser,
        actor,
        'approve',
        ['read']
      );
      const [row] = await dbWrite
        .select()
        .from(devices)
        .where(eq(devices.hash, hash(revoked.result.device_code)));
      if (!row?.grantId) throw new Error('Missing device grant');
      await oauth.revokeGrant(actor, row.grantId);
      await expect(
        poll(revoked.client.client_id, revoked.result.device_code)
      ).rejects.toThrow('invalid_grant');
      const banned = await start();
      await device.approve(banned.result.user_code, browser, actor, 'approve', [
        'read',
      ]);
      await dbWrite
        .update(users)
        .set({ isBanned: true })
        .where(eq(users.id, actor));
      try {
        await expect(
          poll(banned.client.client_id, banned.result.device_code)
        ).rejects.toThrow('invalid_grant');
      } finally {
        await dbWrite
          .update(users)
          .set({ isBanned: false })
          .where(eq(users.id, actor));
      }
    });

    test('unknown or malformed public codes cannot disclose a connection', async () => {
      await expect(device.info('not-a-code', browser, actor)).rejects.toThrow(
        'invalid_user_code'
      );
      await expect(
        device.info('B'.repeat(100), browser, actor)
      ).rejects.toThrow('invalid_user_code');
      await expect(device.info('BBBB-BBBB', browser, actor)).rejects.toThrow(
        'invalid_user_code'
      );
    });

    test('persistent limiter rejects attempts beyond its bucket ceiling', async () => {
      const key = `device-regression:${randomUUID()}`;
      await oauth.limit(key, 2);
      await oauth.limit(key, 2);
      await expect(oauth.limit(key, 2)).rejects.toThrow(
        'temporarily_unavailable'
      );
    });

    test('real Next routes enforce Origin and browser sign-in and return access tokens only at token endpoint', async () => {
      const edgeHeaders = {
        'cf-connecting-ip': `2001:db8:${randomUUID().slice(0, 4)}::1`,
      };
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
        process.env.STEWARD_TENANT_ID = 'device-test';
        process.env.STEWARD_JWT_SECRET = 'device-integration-secret';
        const jwt = await new SignJWT({
          userId: stewardActor,
          tenantId: 'device-test',
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('steward')
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode('device-integration-secret'));
        const client = await oauth.register({
          client_name: 'Route headless runtime',
          grant_types: [DEVICE_GRANT_TYPE, 'refresh_token'],
          response_types: [],
        });
        clientIds.push(client.client_id);
        const startResponse = await deviceStart(
          new NextRequest(`${origin}/oauth/device/authorization`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: client.client_id,
              resource: `${origin}/mcp`,
              scope: 'read',
            }).toString(),
          })
        );
        expect(startResponse.status).toBe(200);
        const authorization = (await startResponse.json()) as {
          device_code: string;
          user_code: string;
        };
        const infoUrl = `${origin}/api/oauth/device/approve?user_code=${authorization.user_code}`;
        expect(
          (
            await deviceInfo(
              new NextRequest(infoUrl, {
                headers: { Authorization: `Bearer ${jwt}` },
              })
            )
          ).status
        ).toBe(401);
        const preview = await deviceInfo(
          new NextRequest(infoUrl, {
            headers: { cookie: `steward-token=${jwt}` },
          })
        );
        expect(preview.status).toBe(200);
        const binding = preview.headers.get('set-cookie')?.split(';')[0];
        if (!binding) throw new Error('Missing device browser binding');
        expect(JSON.stringify(await preview.json())).not.toContain(
          'device_code'
        );
        const cookie = `${binding}; steward-token=${jwt}`;
        const body = JSON.stringify({
          userCode: authorization.user_code,
          action: 'approve',
          scopes: ['read'],
        });
        expect(
          (
            await deviceApprove(
              new NextRequest(`${origin}/api/oauth/device/approve`, {
                method: 'POST',
                headers: {
                  ...edgeHeaders,
                  cookie,
                  Origin: 'https://other.example',
                  'Content-Type': 'application/json',
                },
                body,
              })
            )
          ).status
        ).toBe(403);
        const approved = await deviceApprove(
          new NextRequest(`${origin}/api/oauth/device/approve`, {
            method: 'POST',
            headers: {
              ...edgeHeaders,
              cookie,
              Origin: origin,
              'Content-Type': 'application/json',
            },
            body,
          })
        );
        expect(approved.status).toBe(200);
        expect(JSON.stringify(await approved.json())).not.toContain(
          'access_token'
        );
        const tokenResponse = await tokenPost(
          new NextRequest(`${origin}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: DEVICE_GRANT_TYPE,
              client_id: client.client_id,
              device_code: authorization.device_code,
              resource: `${origin}/mcp`,
            }).toString(),
          })
        );
        expect(tokenResponse.status).toBe(200);
        const credentials = (await tokenResponse.json()) as {
          access_token: string;
        };
        expect(
          (await oauth.authenticate(credentials.access_token))?.accountId
        ).toBe(actor);
        expect(tokenResponse.headers.get('cache-control')).toBe('no-store');
        const incomplete = await device.start({
          client_id: client.client_id,
          resource: `${origin}/mcp`,
          scope: 'read',
        });
        await dbWrite
          .update(users)
          .set({ profileComplete: false })
          .where(eq(users.id, actor));
        try {
          const profileResponse = await deviceInfo(
            new NextRequest(
              `${origin}/api/oauth/device/approve?user_code=${incomplete.user_code}`,
              { headers: { ...edgeHeaders, cookie: `steward-token=${jwt}` } }
            )
          );
          expect(profileResponse.status).toBe(409);
          const profileBinding = profileResponse.headers
            .get('set-cookie')
            ?.split(';')[0];
          if (!profileBinding)
            throw new Error('Missing binding on profile-required response');
          const denyResponse = await deviceApprove(
            new NextRequest(`${origin}/api/oauth/device/approve`, {
              method: 'POST',
              headers: {
                ...edgeHeaders,
                cookie: `${profileBinding}; steward-token=${jwt}`,
                Origin: origin,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                userCode: incomplete.user_code,
                action: 'deny',
                scopes: [],
              }),
            })
          );
          expect(denyResponse.status).toBe(200);
          expect(
            (await poll(client.client_id, incomplete.device_code)).error
          ).toBe('access_denied');
        } finally {
          await dbWrite
            .update(users)
            .set({ profileComplete: true })
            .where(eq(users.id, actor));
        }

        const quotaIp = `2001:db8:${randomUUID().slice(0, 4)}::c`;
        const bucketKey = hash(
          `token-ingress-ip:${quotaIp}:${Math.floor(Date.now() / 3_600_000)}`
        );
        await dbWrite.insert(rates).values({
          key: bucketKey,
          count: 1500,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        let bodyRead = false;
        const slowBody = new ReadableStream<Uint8Array>(
          {
            pull() {
              bodyRead = true;
            },
          },
          { highWaterMark: 0 }
        );
        const quotaRequest = new NextRequest(`${origin}/oauth/token`, {
          method: 'POST',
          headers: {
            'cf-connecting-ip': quotaIp,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: slowBody,
          duplex: 'half',
        });
        try {
          expect((await tokenPost(quotaRequest)).status).toBe(429);
          expect(bodyRead).toBe(false);
        } finally {
          await quotaRequest.body?.cancel();
          await dbWrite.delete(rates).where(eq(rates.key, bucketKey));
        }
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
    });
  }
);
