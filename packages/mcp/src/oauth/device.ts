import { randomInt } from 'node:crypto';
import {
  and,
  mcpOAuthAudit as audit,
  mcpOAuthClients as clients,
  dbWrite,
  mcpOAuthDevices as devices,
  eq,
  mcpOAuthGrants as grants,
  gt,
  isNull,
  or,
  sql,
  mcpOAuthTokens as tokens,
  users,
} from '@feed/db';
import { z } from 'zod';
import {
  clientIdSchema,
  DEVICE_GRANT_TYPE,
  type FeedScope,
  hash,
  OAuthError,
  opaque,
  parseScopes,
  resourceMatches,
} from './contracts';
import { FeedOAuthService } from './service';

const EXPIRY_MS = 600_000;
const GRANT_MS = 90 * 24 * 60 * 60_000;
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const deviceRequestSchema = z
  .object({
    client_id: clientIdSchema,
    resource: z.string().max(2048),
    scope: z.string().max(200).default('read social:write messages trade'),
  })
  .strict();
export const deviceApprovalSchema = z
  .object({
    userCode: z.string().max(32),
    action: z.enum(['approve', 'deny']),
    scopes: z
      .array(z.enum(['read', 'social:write', 'messages', 'trade']))
      .max(4),
  })
  .strict();
export const deviceTokenSchema = z
  .object({
    grant_type: z.literal(DEVICE_GRANT_TYPE),
    client_id: clientIdSchema,
    device_code: z.string().regex(/^fmcpd_[A-Za-z0-9_-]{43}$/),
    resource: z.string().max(2048).optional(),
  })
  .strict();

export function normalizeUserCode(value: string) {
  if (value.length > 32) throw new OAuthError('invalid_user_code');
  const code = value.toUpperCase().replace(/[-\s]/g, '');
  if (
    code.length !== 8 ||
    [...code].some((character) => !ALPHABET.includes(character))
  )
    throw new OAuthError('invalid_user_code');
  return code;
}
function userCode() {
  const value = Array.from(
    { length: 8 },
    () => ALPHABET[randomInt(ALPHABET.length)]
  ).join('');
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export class FeedDeviceService {
  readonly oauth: FeedOAuthService;
  constructor(origin: string | FeedOAuthService) {
    this.oauth =
      typeof origin === 'string' ? new FeedOAuthService(origin) : origin;
  }

  async start(input: Record<string, string>) {
    const parsed = deviceRequestSchema.safeParse(input);
    if (!parsed.success) throw new OAuthError('invalid_request');
    const data = parsed.data;
    if (!resourceMatches(data.resource, this.oauth.resource))
      throw new OAuthError('invalid_target');
    const client = await this.oauth.resolveClient(data.client_id);
    if (!client || !client.grantTypes.includes(DEVICE_GRANT_TYPE))
      throw new OAuthError('unauthorized_client');
    const scopes = parseScopes(data.scope);
    await dbWrite.execute(
      sql`DELETE FROM "McpOAuthDevice" WHERE "hash" IN (SELECT "hash" FROM "McpOAuthDevice" WHERE "expiresAt" < now() ORDER BY "expiresAt" LIMIT 64)`
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const privateCode = opaque('fmcpd');
      const publicCode = userCode();
      const [created] = await dbWrite
        .insert(devices)
        .values({
          hash: hash(privateCode),
          userCodeHash: hash(normalizeUserCode(publicCode)),
          clientId: client.id,
          scopes,
          refreshAllowed: client.grantTypes.includes('refresh_token'),
          resource: this.oauth.resource,
          expiresAt: new Date(Date.now() + EXPIRY_MS),
        })
        .onConflictDoNothing({ target: devices.userCodeHash })
        .returning();
      if (!created) continue;
      return {
        device_code: privateCode,
        user_code: publicCode,
        verification_uri: `${this.oauth.origin}/link`,
        verification_uri_complete: `${this.oauth.origin}/link?user_code=${publicCode}`,
        expires_in: EXPIRY_MS / 1000,
        interval: 5,
      };
    }
    throw new OAuthError('temporarily_unavailable', 503);
  }

  async pending(
    publicCode: string,
    browser: string,
    userId: string,
    requireProfile: boolean
  ) {
    const [device] = await dbWrite
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.userCodeHash, hash(normalizeUserCode(publicCode))),
          eq(devices.resource, this.oauth.resource),
          eq(devices.status, 'pending'),
          gt(devices.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!device) throw new OAuthError('invalid_user_code');
    const [[client], [user]] = await Promise.all([
      dbWrite
        .select()
        .from(clients)
        .where(eq(clients.id, device.clientId))
        .limit(1),
      dbWrite
        .select({
          username: users.username,
          profileComplete: users.profileComplete,
          tosAcceptedAt: users.tosAcceptedAt,
          isBanned: users.isBanned,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    ]);
    if (!client || !user || user.isBanned)
      throw new OAuthError('access_denied', 403);
    await this.oauth.limit(`device-verify-client:${client.id}`, 1000);
    if (requireProfile && !user.profileComplete)
      throw new OAuthError('profile_required', 409);
    if (requireProfile && (!user.username || !user.tosAcceptedAt))
      throw new OAuthError('profile_incomplete', 403);
    const [bound] = await dbWrite
      .update(devices)
      .set({ userId, browserHash: hash(browser) })
      .where(
        and(
          eq(devices.hash, device.hash),
          eq(devices.status, 'pending'),
          or(isNull(devices.userId), eq(devices.userId, userId)),
          or(
            isNull(devices.browserHash),
            eq(devices.browserHash, hash(browser))
          )
        )
      )
      .returning();
    if (!bound) throw new OAuthError('account_changed', 403);
    return { device: bound, client, user };
  }

  async info(publicCode: string, browser: string, userId: string) {
    const { device, client, user } = await this.pending(
      publicCode,
      browser,
      userId,
      false
    );
    if (!user.profileComplete) throw new OAuthError('profile_required', 409);
    if (!user.username || !user.tosAcceptedAt)
      throw new OAuthError('profile_incomplete', 403);
    return {
      userCode: normalizeUserCode(publicCode),
      client: {
        name: client.name,
        ...(client.id.startsWith('https://')
          ? { metadataOrigin: new URL(client.id).origin }
          : {}),
      },
      account: { handle: user.username },
      scopes: device.scopes,
      expiresAt: device.expiresAt.toISOString(),
    };
  }

  async approve(
    publicCode: string,
    browser: string,
    userId: string,
    action: 'approve' | 'deny',
    scopes: FeedScope[]
  ) {
    const { device } = await this.pending(
      publicCode,
      browser,
      userId,
      action === 'approve'
    );
    if (
      action === 'approve' &&
      (!scopes.length || scopes.some((scope) => !device.scopes.includes(scope)))
    )
      throw new OAuthError('invalid_scope');
    const grantId = opaque('fmcpg');
    await dbWrite.transaction(async (tx) => {
      const [updated] = await tx
        .update(devices)
        .set({
          status: action === 'approve' ? 'approved' : 'denied',
          scopes: action === 'approve' ? scopes : device.scopes,
        })
        .where(
          and(
            eq(devices.hash, device.hash),
            eq(devices.status, 'pending'),
            eq(devices.userId, userId),
            eq(devices.browserHash, hash(browser)),
            gt(devices.expiresAt, new Date())
          )
        )
        .returning();
      if (!updated) throw new OAuthError('invalid_user_code');
      if (action === 'deny') return;
      await tx.insert(grants).values({
        id: grantId,
        userId,
        clientId: device.clientId,
        scopes,
        refreshAllowed: device.refreshAllowed,
        resource: this.oauth.resource,
        expiresAt: new Date(Date.now() + GRANT_MS),
      });
      await tx
        .update(devices)
        .set({ grantId })
        .where(eq(devices.hash, device.hash));
      await tx.insert(audit).values({
        id: opaque('event'),
        userId,
        clientId: device.clientId,
        grantId,
        event: 'device_approved',
      });
    });
    return { status: action === 'approve' ? 'approved' : 'denied' };
  }

  async poll(input: Record<string, string>) {
    const parsed = deviceTokenSchema.safeParse(input);
    if (!parsed.success) throw new OAuthError('invalid_request');
    const data = parsed.data;
    if (data.resource && !resourceMatches(data.resource, this.oauth.resource))
      throw new OAuthError('invalid_target');
    return dbWrite.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(devices)
        .where(eq(devices.hash, hash(data.device_code)))
        .for('update');
      if (
        !device ||
        device.clientId !== data.client_id ||
        device.resource !== this.oauth.resource
      )
        throw new OAuthError('invalid_grant');
      const [client] = await tx
        .select()
        .from(clients)
        .where(eq(clients.id, data.client_id))
        .limit(1);
      if (!client || !client.grantTypes.includes(DEVICE_GRANT_TYPE))
        throw new OAuthError('unauthorized_client');
      const now = new Date();
      if (device.expiresAt <= now || device.pollCount >= 120)
        return { error: 'expired_token' };
      if (device.status === 'denied') return { error: 'access_denied' };
      if (device.status === 'consumed') return { error: 'invalid_grant' };
      if (
        device.lastPolledAt &&
        now.getTime() < device.lastPolledAt.getTime() + device.interval * 1000
      ) {
        const interval = Math.min(device.interval + 5, 600);
        await tx
          .update(devices)
          .set({ interval, lastPolledAt: now, pollCount: device.pollCount + 1 })
          .where(eq(devices.hash, device.hash));
        return { error: 'slow_down', interval };
      }
      await tx
        .update(devices)
        .set({ lastPolledAt: now, pollCount: device.pollCount + 1 })
        .where(eq(devices.hash, device.hash));
      if (device.status === 'pending')
        return { error: 'authorization_pending', interval: device.interval };
      if (!device.grantId || !device.userId)
        throw new OAuthError('invalid_grant');
      const [grant] = await tx
        .select()
        .from(grants)
        .where(eq(grants.id, device.grantId))
        .for('update');
      const [user] = await tx
        .select({ isBanned: users.isBanned })
        .from(users)
        .where(eq(users.id, device.userId))
        .limit(1);
      if (
        !grant ||
        grant.userId !== device.userId ||
        grant.clientId !== client.id ||
        grant.resource !== this.oauth.resource ||
        grant.revokedAt ||
        grant.expiresAt <= now ||
        !user ||
        user.isBanned
      )
        throw new OAuthError('invalid_grant');
      const access = opaque('fmcpa');
      const refresh = opaque('fmcpr');
      const accessExpiry = new Date(
        Math.min(now.getTime() + 15 * 60_000, grant.expiresAt.getTime())
      );
      await tx.insert(tokens).values({
        hash: hash(access),
        kind: 'access',
        scopes: grant.scopes,
        grantId: grant.id,
        expiresAt: accessExpiry,
      });
      if (grant.refreshAllowed && client.grantTypes.includes('refresh_token'))
        await tx.insert(tokens).values({
          hash: hash(refresh),
          kind: 'refresh',
          scopes: grant.scopes,
          grantId: grant.id,
          expiresAt: grant.expiresAt,
        });
      await tx
        .update(devices)
        .set({ status: 'consumed' })
        .where(eq(devices.hash, device.hash));
      return {
        token_type: 'Bearer',
        access_token: access,
        ...(grant.refreshAllowed && client.grantTypes.includes('refresh_token')
          ? { refresh_token: refresh }
          : {}),
        expires_in: Math.floor((accessExpiry.getTime() - now.getTime()) / 1000),
        scope: grant.scopes.join(' '),
        resource: this.oauth.resource,
      };
    });
  }
}
