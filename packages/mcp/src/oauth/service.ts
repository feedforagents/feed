import {
  and,
  mcpOAuthAudit as audit,
  mcpOAuthClients as clients,
  dbWrite,
  eq,
  mcpOAuthGrants as grants,
  gt,
  isNull,
  or,
  mcpOAuthRateLimits as rates,
  mcpOAuthRequests as requests,
  sql,
  mcpOAuthTokens as tokens,
  users,
} from '@feed/db';
import { z } from 'zod';
import {
  appOrigin,
  authorizationSchema,
  type FeedAgentContext,
  type FeedScope,
  hash,
  OAuthError,
  opaque,
  parseScopes,
  redirectMatches,
  registrationSchema,
  resourceMatches,
  scopeSchema,
} from './contracts';

const ACCESS_MS = 15 * 60_000;
const GRANT_MS = 90 * 24 * 60 * 60_000;
export class FeedOAuthService {
  readonly origin: string;
  readonly resource: string;
  constructor(origin: string) {
    this.origin = appOrigin(origin);
    this.resource = `${this.origin}/mcp`;
  }

  async limit(key: string, maximum: number) {
    await dbWrite.execute(
      sql`DELETE FROM "McpOAuthRateLimit" WHERE "key" IN (SELECT "key" FROM "McpOAuthRateLimit" WHERE "expiresAt" < now() ORDER BY "expiresAt" LIMIT 64)`
    );
    const bucket = `${key}:${Math.floor(Date.now() / 3_600_000)}`;
    const [row] = await dbWrite
      .insert(rates)
      .values({
        key: hash(bucket),
        count: 1,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .onConflictDoUpdate({
        target: rates.key,
        set: { count: sql`${rates.count} + 1` },
      })
      .returning();
    if (!row || row.count > maximum)
      throw new OAuthError('temporarily_unavailable', 429);
  }

  async register(body: object) {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) throw new OAuthError('invalid_client_metadata');
    const input = parsed.data;
    const clientId = opaque('fmcpclient');
    await dbWrite.insert(clients).values({
      id: clientId,
      name: input.client_name,
      redirectUris: input.redirect_uris,
      grantTypes: input.grant_types,
    });
    return {
      ...input,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  async authorize(input: Record<string, string>, browser: string) {
    const parsed = authorizationSchema.safeParse(input);
    if (!parsed.success) throw new OAuthError('invalid_request');
    const data = parsed.data;
    const [client] = await dbWrite
      .select()
      .from(clients)
      .where(eq(clients.id, data.client_id))
      .limit(1);
    if (client && !client.grantTypes.includes('authorization_code'))
      throw new OAuthError('unauthorized_client');
    if (
      !client ||
      !client.redirectUris.some((uri) =>
        redirectMatches(data.redirect_uri, uri)
      )
    )
      throw new OAuthError('invalid_client');
    if (!resourceMatches(data.resource, this.resource))
      throw new OAuthError('invalid_target');
    const requestId = opaque('fmcpapproval');
    await dbWrite.insert(requests).values({
      id: requestId,
      clientId: client.id,
      redirectUri: data.redirect_uri,
      state: data.state,
      challenge: data.code_challenge,
      scopes: parseScopes(data.scope),
      resource: this.resource,
      browserHash: hash(browser),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return `${this.origin}/connect?request=${encodeURIComponent(requestId)}`;
  }

  async pending(
    requestId: string,
    browser: string,
    userId: string,
    requireProfile = true
  ) {
    const [request] = await dbWrite
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.id, requestId),
          eq(requests.resource, this.resource),
          eq(requests.browserHash, hash(browser)),
          isNull(requests.consumedAt),
          gt(requests.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!request) throw new OAuthError('invalid_request');
    const [[client], [user]] = await Promise.all([
      dbWrite
        .select()
        .from(clients)
        .where(eq(clients.id, request.clientId))
        .limit(1),
      dbWrite
        .select({
          id: users.id,
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
    const [bound] = await dbWrite
      .update(requests)
      .set({ userId })
      .where(
        and(
          eq(requests.id, requestId),
          or(isNull(requests.userId), eq(requests.userId, userId))
        )
      )
      .returning();
    if (!bound) throw new OAuthError('account_changed', 403);
    if (requireProfile && !user.profileComplete)
      throw new OAuthError('profile_required', 409);
    if (requireProfile && (!user.username || !user.tosAcceptedAt))
      throw new OAuthError('profile_incomplete', 403);
    return { request, client, user };
  }

  async approvalInfo(requestId: string, browser: string, userId: string) {
    const { request, client, user } = await this.pending(
      requestId,
      browser,
      userId
    );
    return {
      requestId,
      client: {
        name: client.name,
        origin: new URL(request.redirectUri).origin,
      },
      account: { handle: user.username },
      scopes: request.scopes,
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  async approve(
    requestId: string,
    browser: string,
    userId: string,
    action: 'approve' | 'deny',
    scopes: FeedScope[]
  ) {
    const { request } = await this.pending(
      requestId,
      browser,
      userId,
      action === 'approve'
    );
    if (
      action === 'approve' &&
      (!scopes.length ||
        scopes.some((scope) => !request.scopes.includes(scope)))
    )
      throw new OAuthError('invalid_scope');
    const code = opaque('fmcpc');
    const grantId = opaque('fmcpg');
    const redirect = new URL(request.redirectUri);
    if (request.state) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', this.origin);
    await dbWrite.transaction(async (tx) => {
      const [consumed] = await tx
        .update(requests)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(requests.id, requestId),
            eq(requests.userId, userId),
            isNull(requests.consumedAt),
            gt(requests.expiresAt, new Date())
          )
        )
        .returning();
      if (!consumed) throw new OAuthError('invalid_request');
      if (action === 'deny') {
        await tx.insert(audit).values({
          id: opaque('event'),
          userId,
          clientId: request.clientId,
          grantId: requestId,
          event: 'denied',
        });
        redirect.searchParams.set('error', 'access_denied');
        return;
      }
      await tx.insert(grants).values({
        id: grantId,
        userId,
        clientId: request.clientId,
        scopes,
        resource: this.resource,
        expiresAt: new Date(Date.now() + GRANT_MS),
      });
      await tx.insert(tokens).values({
        hash: hash(code),
        kind: 'code',
        scopes,
        grantId,
        redirectUri: request.redirectUri,
        challenge: request.challenge,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await tx.insert(audit).values({
        id: opaque('event'),
        userId,
        clientId: request.clientId,
        grantId,
        event: 'approved',
      });
      redirect.searchParams.set('code', code);
    });
    return { redirectUrl: redirect.href };
  }

  async exchange(input: Record<string, string>) {
    const parsed = z
      .object({
        grant_type: z.enum(['authorization_code', 'refresh_token']),
        client_id: z.string().max(100),
        resource: z.string().max(2048).optional(),
        scope: z.string().max(200).optional(),
        code: z.string().max(200).optional(),
        redirect_uri: z.string().max(2048).optional(),
        code_verifier: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{43,128}$/)
          .optional(),
        refresh_token: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw new OAuthError('invalid_request');
    const data = parsed.data;
    if (data.resource && !resourceMatches(data.resource, this.resource))
      throw new OAuthError('invalid_target');
    const isRefresh = data.grant_type === 'refresh_token';
    const credential = isRefresh ? data.refresh_token : data.code;
    if (
      !credential ||
      (!isRefresh && (!data.code_verifier || !data.redirect_uri))
    )
      throw new OAuthError('invalid_request');
    const access = opaque('fmcpa');
    const refresh = opaque('fmcpr');
    const now = new Date();
    const result = await dbWrite.transaction(async (tx) => {
      const [token] = await tx
        .select()
        .from(tokens)
        .where(eq(tokens.hash, hash(credential)))
        .for('update');
      if (!token || token.kind !== (isRefresh ? 'refresh' : 'code'))
        return null;
      const [grant] = await tx
        .select()
        .from(grants)
        .where(eq(grants.id, token.grantId))
        .for('update');
      if (
        !grant ||
        grant.clientId !== data.client_id ||
        grant.resource !== this.resource ||
        grant.revokedAt ||
        grant.expiresAt <= now
      )
        return null;
      const [client] = await tx
        .select()
        .from(clients)
        .where(eq(clients.id, grant.clientId))
        .limit(1);
      if (
        !client ||
        !client.grantTypes.includes(
          isRefresh ? 'refresh_token' : 'authorization_code'
        )
      )
        return null;
      if (token.consumedAt) {
        if (isRefresh) {
          await tx
            .update(grants)
            .set({ revokedAt: now })
            .where(eq(grants.id, grant.id));
          await tx.insert(audit).values({
            id: opaque('event'),
            userId: grant.userId,
            clientId: grant.clientId,
            grantId: grant.id,
            event: 'refresh_reuse_revoked',
          });
        }
        return null;
      }
      if (
        token.expiresAt <= now ||
        (!isRefresh &&
          (token.redirectUri !== data.redirect_uri ||
            token.challenge !== hash(data.code_verifier ?? '')))
      )
        return null;
      // Scope is a credential snapshot, not a mutable property of the grant.
      // This also permits a code exchange to request less than consent allowed.
      const priorScopes = z
        .array(scopeSchema)
        .min(1)
        .safeParse(token.scopes ?? grant.scopes);
      if (!priorScopes.success) return null;
      const issuedScopes =
        data.scope === undefined ? priorScopes.data : parseScopes(data.scope);
      if (
        issuedScopes.some(
          (scope) =>
            !priorScopes.data.includes(scope) || !grant.scopes.includes(scope)
        )
      )
        throw new OAuthError('invalid_scope');
      await tx
        .update(tokens)
        .set({ consumedAt: now })
        .where(eq(tokens.hash, token.hash));
      await tx.insert(tokens).values([
        {
          hash: hash(access),
          kind: 'access',
          scopes: issuedScopes,
          grantId: grant.id,
          expiresAt: new Date(
            Math.min(now.getTime() + ACCESS_MS, grant.expiresAt.getTime())
          ),
        },
        ...(client.grantTypes.includes('refresh_token')
          ? [
              {
                hash: hash(refresh),
                kind: 'refresh',
                scopes: issuedScopes,
                grantId: grant.id,
                expiresAt: grant.expiresAt,
              },
            ]
          : []),
      ]);
      return {
        token_type: 'Bearer',
        access_token: access,
        ...(client.grantTypes.includes('refresh_token')
          ? { refresh_token: refresh }
          : {}),
        expires_in: Math.floor(
          (Math.min(now.getTime() + ACCESS_MS, grant.expiresAt.getTime()) -
            now.getTime()) /
            1000
        ),
        scope: issuedScopes.join(' '),
        resource: this.resource,
      };
    });
    if (!result) throw new OAuthError('invalid_grant');
    return result;
  }

  async authenticate(token: string): Promise<FeedAgentContext | null> {
    const [row] = await dbWrite
      .select({
        grant: grants,
        token: tokens,
        client: clients,
        banned: users.isBanned,
        mode: users.uiMode,
      })
      .from(tokens)
      .innerJoin(grants, eq(tokens.grantId, grants.id))
      .innerJoin(clients, eq(grants.clientId, clients.id))
      .innerJoin(users, eq(grants.userId, users.id))
      .where(
        and(
          eq(tokens.hash, hash(token)),
          eq(tokens.kind, 'access'),
          gt(tokens.expiresAt, new Date()),
          gt(grants.expiresAt, new Date()),
          isNull(grants.revokedAt)
        )
      )
      .limit(1);
    if (!row || row.banned || row.grant.resource !== this.resource) return null;
    const grantScopes = z.array(scopeSchema).min(1).safeParse(row.grant.scopes);
    const scopes = z
      .array(scopeSchema)
      .min(1)
      .safeParse(row.token.scopes ?? row.grant.scopes);
    if (
      !grantScopes.success ||
      !scopes.success ||
      scopes.data.some((scope) => !grantScopes.data.includes(scope))
    )
      return null;
    await dbWrite
      .update(grants)
      .set({ lastUsedAt: new Date() })
      .where(eq(grants.id, row.grant.id));
    return {
      accountId: row.grant.userId,
      grantId: row.grant.id,
      clientId: row.client.id,
      clientName: row.client.name,
      scopes: scopes.data,
      mode: row.mode,
    };
  }

  async revokeToken(token: string, clientId: string) {
    const [row] = await dbWrite
      .select({ grantId: tokens.grantId })
      .from(tokens)
      .innerJoin(grants, eq(tokens.grantId, grants.id))
      .where(and(eq(tokens.hash, hash(token)), eq(grants.clientId, clientId)))
      .limit(1);
    if (row)
      await dbWrite
        .update(grants)
        .set({ revokedAt: new Date() })
        .where(eq(grants.id, row.grantId));
  }
  async listGrants(userId: string) {
    return dbWrite
      .select({
        id: grants.id,
        clientName: clients.name,
        scopes: grants.scopes,
        createdAt: grants.createdAt,
        lastUsedAt: grants.lastUsedAt,
        expiresAt: grants.expiresAt,
        revokedAt: grants.revokedAt,
      })
      .from(grants)
      .innerJoin(clients, eq(grants.clientId, clients.id))
      .where(eq(grants.userId, userId));
  }
  async revokeGrant(userId: string, grantId: string) {
    await dbWrite.transaction(async (tx) => {
      const [grant] = await tx
        .update(grants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(grants.id, grantId),
            eq(grants.userId, userId),
            isNull(grants.revokedAt)
          )
        )
        .returning();
      if (grant)
        await tx.insert(audit).values({
          id: opaque('event'),
          userId,
          clientId: grant.clientId,
          grantId,
          event: 'revoked',
        });
    });
  }
}
