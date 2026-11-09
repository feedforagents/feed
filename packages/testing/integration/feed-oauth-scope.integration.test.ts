import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  mcpOAuthClients as clients,
  dbWrite,
  eq,
  mcpOAuthGrants as grants,
  inArray,
  mcpOAuthRequests as requests,
  mcpOAuthTokens as tokens,
  users,
} from '@feed/db';
import { FeedOAuthService, hash, opaque } from '@feed/mcp';
import { NextRequest } from 'next/server';
import { POST as tokenPost } from '../../../apps/web/src/app/oauth/token/route';

const databaseUrl = process.env.DATABASE_URL;
const canRun =
  !!databaseUrl &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname) &&
  process.env.NODE_ENV !== 'production';
const origin = 'https://feed-scope.example';
const service = new FeedOAuthService(origin);
const actor = `scope-test-${randomUUID()}`;
const clientIds: string[] = [];
const browser = opaque('fmcpcb');
const verifier = 'a'.repeat(64);
const callback = 'http://127.0.0.1:48291/callback';

describe.skipIf(!canRun)(
  'OAuth credential scope snapshots with real Postgres',
  () => {
    beforeAll(async () => {
      await dbWrite.insert(users).values({
        id: actor,
        stewardId: actor,
        username: actor,
        updatedAt: new Date(),
        profileComplete: true,
        tosAcceptedAt: new Date(),
      });
    });
    afterAll(async () => {
      if (clientIds.length)
        await dbWrite
          .delete(requests)
          .where(inArray(requests.clientId, clientIds));
      await dbWrite.delete(users).where(eq(users.id, actor));
      if (clientIds.length)
        await dbWrite.delete(clients).where(inArray(clients.id, clientIds));
    });
    async function approved(refresh = true) {
      const client = await service.register({
        client_name: 'Scope snapshot client',
        redirect_uris: [callback],
        grant_types: refresh
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
      });
      clientIds.push(client.client_id);
      const destination = await service.authorize(
        {
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: callback,
          code_challenge: hash(verifier),
          code_challenge_method: 'S256',
          scope: 'read social:write',
          resource: `${origin}/mcp`,
        },
        browser
      );
      const requestId = new URL(destination).searchParams.get('request');
      if (!requestId) throw new Error('Missing request');
      await service.approvalInfo(requestId, browser, actor);
      const approval = await service.approve(
        requestId,
        browser,
        actor,
        'approve',
        ['read', 'social:write']
      );
      const code = new URL(approval.redirectUrl).searchParams.get('code');
      if (!code) throw new Error('Missing code');
      return {
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: callback,
        resource: `${origin}/mcp`,
      };
    }
    async function redeemed() {
      const input = await approved();
      const result = await service.exchange(input);
      if (!result.refresh_token) throw new Error('Missing refresh token');
      return {
        input,
        result: { ...result, refresh_token: result.refresh_token },
      };
    }
    const refreshInput = (clientId: string, token: string) => ({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: token,
      resource: `${origin}/mcp`,
    });
    async function stored(token: string) {
      const [row] = await dbWrite
        .select()
        .from(tokens)
        .where(eq(tokens.hash, hash(token)));
      if (!row) throw new Error('Missing token row');
      return row;
    }

    test('native Codex refresh form narrows issued credentials while retaining old access scope and immutable grant', async () => {
      const { input, result } = await redeemed();
      const previousOrigin = process.env.NEXT_PUBLIC_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = origin;
      try {
        const response = await tokenPost(
          new NextRequest(`${origin}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              ...refreshInput(input.client_id, result.refresh_token),
              scope: 'read',
            }),
          })
        );
        expect(response.status).toBe(200);
        const narrowed = (await response.json()) as {
          access_token: string;
          refresh_token: string;
          scope: string;
        };
        expect(narrowed.scope).toBe('read');
        expect(
          (await service.authenticate(narrowed.access_token))?.scopes
        ).toEqual(['read']);
        expect(
          (await service.authenticate(result.access_token))?.scopes
        ).toEqual(['read', 'social:write']);
        expect((await stored(narrowed.access_token)).scopes).toEqual(['read']);
        expect((await stored(narrowed.refresh_token)).scopes).toEqual(['read']);
        const context = await service.authenticate(result.access_token);
        const [grant] = await dbWrite
          .select()
          .from(grants)
          .where(eq(grants.id, context?.grantId ?? ''));
        expect(grant?.scopes).toEqual(['read', 'social:write']);
        const next = await service.exchange(
          refreshInput(input.client_id, narrowed.refresh_token)
        );
        expect(next.scope).toBe('read');
      } finally {
        if (previousOrigin === undefined)
          delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = previousOrigin;
      }
    });

    test('scope expansion rolls back without consuming the narrowed refresh token', async () => {
      const { input, result } = await redeemed();
      const narrowed = await service.exchange({
        ...refreshInput(input.client_id, result.refresh_token),
        scope: 'read',
      });
      if (!narrowed.refresh_token) throw new Error('Missing refresh');
      await expect(
        service.exchange({
          ...refreshInput(input.client_id, narrowed.refresh_token),
          scope: 'read social:write',
        })
      ).rejects.toThrow('invalid_scope');
      expect((await stored(narrowed.refresh_token)).consumedAt).toBeNull();
      expect(
        (
          await service.exchange(
            refreshInput(input.client_id, narrowed.refresh_token)
          )
        ).scope
      ).toBe('read');
    });

    test('invalid scope leaves full refresh credential and access token usable', async () => {
      const { input, result } = await redeemed();
      await expect(
        service.exchange({
          ...refreshInput(input.client_id, result.refresh_token),
          scope: 'admin',
        })
      ).rejects.toThrow('invalid_scope');
      expect((await stored(result.refresh_token)).consumedAt).toBeNull();
      expect((await service.authenticate(result.access_token))?.scopes).toEqual(
        ['read', 'social:write']
      );
      expect(
        (
          await service.exchange(
            refreshInput(input.client_id, result.refresh_token)
          )
        ).scope
      ).toBe('read social:write');
    });

    test('legacy NULL snapshots inherit grant scopes without narrowing previously issued access', async () => {
      const { input, result } = await redeemed();
      await dbWrite
        .update(tokens)
        .set({ scopes: null })
        .where(
          inArray(tokens.hash, [
            hash(result.access_token),
            hash(result.refresh_token),
          ])
        );
      const narrowed = await service.exchange({
        ...refreshInput(input.client_id, result.refresh_token),
        scope: 'read',
      });
      expect((await service.authenticate(result.access_token))?.scopes).toEqual(
        ['read', 'social:write']
      );
      expect(
        (await service.authenticate(narrowed.access_token))?.scopes
      ).toEqual(['read']);
      expect((await stored(result.access_token)).scopes).toBeNull();
    });

    test('reusing a narrowed refresh commits family revocation for all access snapshots', async () => {
      const { input, result } = await redeemed();
      const narrowed = await service.exchange({
        ...refreshInput(input.client_id, result.refresh_token),
        scope: 'read',
      });
      await expect(
        service.exchange(refreshInput(input.client_id, result.refresh_token))
      ).rejects.toThrow('invalid_grant');
      expect(await service.authenticate(result.access_token)).toBeNull();
      expect(await service.authenticate(narrowed.access_token)).toBeNull();
      const [grant] = await dbWrite
        .select()
        .from(grants)
        .where(eq(grants.id, (await stored(result.access_token)).grantId));
      expect(grant?.revokedAt).not.toBeNull();
    });

    test('authorization code may narrow but cannot expand and code-only clients store no refresh', async () => {
      const input = await approved(false);
      await expect(
        service.exchange({ ...input, scope: 'read trade' })
      ).rejects.toThrow('invalid_scope');
      expect((await stored(input.code)).consumedAt).toBeNull();
      const result = await service.exchange({ ...input, scope: 'read' });
      expect(result.refresh_token).toBeUndefined();
      expect(result.scope).toBe('read');
      expect((await stored(result.access_token)).scopes).toEqual(['read']);
      const rows = await dbWrite
        .select()
        .from(tokens)
        .where(eq(tokens.grantId, (await stored(result.access_token)).grantId));
      expect(rows.filter((row) => row.kind === 'refresh')).toHaveLength(0);
    });
  }
);
