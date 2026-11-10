/**
 * API Authentication Middleware
 *
 * Authenticates requests using Steward-issued JWTs (HS256, issuer: "steward").
 * The JWT is read from the `steward-token` httpOnly cookie (preferred) or the
 * `Authorization: Bearer <token>` header (fallback for agents / external clients).
 *
 * User lookup chain (in order):
 *   1. Fast path:  WHERE stewardId = payload.userId
 *   2. Email bridge: unlinked user found by email → sets stewardId
 *   3. New user:   ensureUserFromSteward() creates the record
 *
 * Dev bypass: x-dev-user-id header OR dev-user:<userId> Bearer token.
 * Test DID:  steward:test:<userId> Bearer token (integration tests).
 */

import { and, db, dbWrite, eq, isNull, users } from '@feed/db';
import { type AuthenticatedUser, logger } from '@feed/shared';
import { errors as joseErrors, jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { verifyAgentSession } from './agent-auth';
import {
  DEV_USER_ID_COOKIE_NAME,
  extractDevUserIdFromBearerToken,
} from './dev-credentials';
import {
  AuthenticationError,
  isAuthenticationError,
  ServiceUnavailableError,
} from './errors';
import { ensureUserFromSteward } from './users/ensure-user';

export type { AuthenticatedUser } from '@feed/shared';
export { extractErrorMessage } from '@feed/shared';
export { AuthenticationError, isAuthenticationError };

// ─── Steward JWT verification ─────────────────────────────────────────────────

const STEWARD_INTERNAL_EMAIL_SUFFIX = '@id.steward.internal';

function getStewardJwtSecret(): Uint8Array {
  const secret = process.env.STEWARD_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableError('STEWARD_JWT_SECRET is not configured');
    }
    // Dev fallback matches Steward's own dev default
    return new TextEncoder().encode('dev-jwt-secret-change-in-prod');
  }
  return new TextEncoder().encode(secret);
}

interface StewardJwtPayload {
  userId: string;
  tenantId?: string;
  email?: string;
  address?: string;
  fid?: number;
  telegramId?: string;
  [key: string]: unknown;
}

/**
 * Verify a Steward JWT.
 *
 * Only credential problems (jose verification errors, missing claims) map to
 * AuthenticationError (401). Configuration problems such as a missing
 * production secret propagate as ServiceUnavailableError.
 */
async function verifyStewardToken(token: string): Promise<StewardJwtPayload> {
  const secret = getStewardJwtSecret();
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, secret, {
      issuer: 'steward',
      algorithms: ['HS256'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AuthenticationError(
        'Authentication token has expired. Please sign in again.'
      );
    }
    if (err instanceof joseErrors.JOSEError) {
      throw new AuthenticationError(
        'Invalid authentication token. Please sign in again.'
      );
    }
    throw err;
  }
  if (!payload['userId'] || typeof payload['userId'] !== 'string') {
    throw new AuthenticationError('Steward JWT missing userId claim');
  }
  return payload as unknown as StewardJwtPayload;
}

/** JWTs have three base64url segments; agent session tokens are opaque hex. */
function looksLikeJwt(token: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token);
}

/**
 * Look up an agent session for an opaque (non-JWT) token.
 *
 * A missing session returns null so verification can continue. A failing
 * session store is surfaced as ServiceUnavailableError instead of being
 * reported to the caller as an invalid token. JWT-shaped tokens skip the
 * store entirely, so a store outage never affects Steward users.
 */
async function lookupAgentSession(
  token: string
): Promise<{ agentId: string } | null> {
  if (looksLikeJwt(token)) {
    return null;
  }
  try {
    return await verifyAgentSession(token);
  } catch (error) {
    logger.error(
      'Agent session store lookup failed',
      { error: error instanceof Error ? error.message : String(error) },
      'Auth'
    );
    throw new ServiceUnavailableError('Agent session store is unavailable');
  }
}

// ─── User lookup chain ────────────────────────────────────────────────────────

const USER_SELECT = {
  id: users.id,
  stewardId: users.stewardId,
  privyId: users.privyId,
  email: users.email,
  isAdmin: users.isAdmin,
  isAgent: users.isAgent,
} as const;

async function resolveUserFromStewardPayload(
  payload: StewardJwtPayload,
  primary = false
): Promise<AuthenticatedUser> {
  const { userId: stewardUserId, email } = payload;
  const accountDb = primary ? dbWrite : db;

  // 1. Fast path: already linked
  const [byId] = await accountDb
    .select(USER_SELECT)
    .from(users)
    .where(eq(users.stewardId, stewardUserId))
    .limit(1);

  if (byId) {
    return toAuthUser(byId);
  }

  // 2. Email bridge: Feed user exists but hasn't logged in via Steward yet.
  //    Only match on real emails — skip synthetic @id.steward.internal addresses.
  const isRealEmail =
    email &&
    typeof email === 'string' &&
    !email.endsWith(STEWARD_INTERNAL_EMAIL_SUFFIX);

  if (isRealEmail) {
    const [byEmail] = await accountDb
      .select(USER_SELECT)
      .from(users)
      .where(and(eq(users.email, email), isNull(users.stewardId)))
      .limit(1);

    if (byEmail) {
      // Link only if still unlinked. Two Steward identities presenting the
      // same email can race here; only the one whose conditional UPDATE wins
      // is linked. The loser must not be authenticated as this user.
      const [linked] = await accountDb
        .update(users)
        .set({ stewardId: stewardUserId })
        .where(and(eq(users.id, byEmail.id), isNull(users.stewardId)))
        .returning(USER_SELECT);
      if (linked) {
        return toAuthUser(linked);
      }

      // Lost the race. If the winner was this same Steward identity (e.g. a
      // concurrent request from the same login), use the linked row.
      const [byIdAfterRace] = await accountDb
        .select(USER_SELECT)
        .from(users)
        .where(eq(users.stewardId, stewardUserId))
        .limit(1);
      if (byIdAfterRace) {
        return toAuthUser(byIdAfterRace);
      }
      // Another Steward identity claimed the row: treat this login exactly as
      // a later request would (no unlinked row matches), i.e. step 3.
    }
  }

  // 3. New user: first-ever login via Steward for this user
  const newUser = primary
    ? await ensureUserFromSteward(
        stewardUserId,
        isRealEmail ? email : undefined,
        true
      )
    : await ensureUserFromSteward(
        stewardUserId,
        isRealEmail ? email : undefined
      );
  return toAuthUser(newUser);
}

interface DbUserRow {
  id: string;
  stewardId: string | null;
  privyId: string | null;
  email: string | null;
  isAdmin: boolean;
  isAgent: boolean;
}

function toAuthUser(dbUser: DbUserRow): AuthenticatedUser {
  return {
    userId: dbUser.id,
    dbUserId: dbUser.id,
    privyId: dbUser.privyId ?? dbUser.stewardId ?? dbUser.id,
    email: dbUser.email ?? undefined,
    isAdmin: dbUser.isAdmin,
    isAgent: dbUser.isAgent,
  };
}

// ─── authenticate ─────────────────────────────────────────────────────────────

export async function authenticate(
  request: NextRequest,
  options?: { consistency: 'primary' }
): Promise<AuthenticatedUser> {
  // ── Dev bypass: x-dev-user-id header / cookie ──────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const devUserId =
      request.headers.get('x-dev-user-id') ??
      request.cookies.get(DEV_USER_ID_COOKIE_NAME)?.value;
    if (devUserId) {
      const [dbUser] = await db
        .select(USER_SELECT)
        .from(users)
        .where(eq(users.id, devUserId))
        .limit(1);
      if (!dbUser) throw new AuthenticationError('Development user not found');
      return toAuthUser(dbUser);
    }
  }

  // ── Extract token ──────────────────────────────────────────────────────────
  // steward-token httpOnly cookie is preferred (set by POST /api/auth/session).
  // Authorization: Bearer falls back for agents and external API clients.
  const cookieToken = request.cookies.get('steward-token')?.value;
  const authHeader = request.headers.get('authorization');
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const token = cookieToken ?? headerToken;

  if (!token) {
    throw new AuthenticationError('Missing authentication token');
  }

  // ── Dev Bearer: dev-user:<userId> ──────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const devBearerUserId = extractDevUserIdFromBearerToken(token);
    if (devBearerUserId) {
      const [dbUser] = await db
        .select(USER_SELECT)
        .from(users)
        .where(eq(users.id, devBearerUserId))
        .limit(1);
      if (!dbUser) throw new AuthenticationError('Development user not found');
      return toAuthUser(dbUser);
    }
  }

  // ── Integration test DID: steward:test:<userId> ────────────────────────────
  const allowTestAuth =
    process.env.ALLOW_TEST_PRIVY_DID_AUTH !== undefined
      ? ['true', '1', 'yes', 'on'].includes(
          process.env.ALLOW_TEST_PRIVY_DID_AUTH.toLowerCase()
        )
      : process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'test';

  if (allowTestAuth && token.startsWith('steward:test:')) {
    const embeddedUserId = token.slice('steward:test:'.length);
    if (/^\d{15,20}$/.test(embeddedUserId)) {
      // Fast path — snowflake ID embedded directly
      return {
        userId: embeddedUserId,
        dbUserId: embeddedUserId,
        privyId: embeddedUserId,
        isAgent: false,
      };
    }
    const [dbUser] = await db
      .select(USER_SELECT)
      .from(users)
      .where(eq(users.id, embeddedUserId))
      .limit(1);
    if (!dbUser) throw new AuthenticationError('Test user not found');
    return toAuthUser(dbUser);
  }

  // ── Agent session token ────────────────────────────────────────────────────
  const agentSession = await lookupAgentSession(token);
  if (agentSession) {
    return {
      userId: agentSession.agentId,
      privyId: agentSession.agentId,
      isAgent: true,
    };
  }

  // ── Steward JWT verification ───────────────────────────────────────────────
  const payload = await verifyStewardToken(token);
  return resolveUserFromStewardPayload(
    payload,
    options?.consistency === 'primary'
  );
}

// ─── authenticateWithDbUser ───────────────────────────────────────────────────

export async function authenticateWithDbUser(
  request: NextRequest,
  options?: { consistency: 'primary' }
): Promise<AuthenticatedUser & { dbUserId: string }> {
  const authUser = await authenticate(request, options);
  if (!authUser.dbUserId) {
    throw new AuthenticationError(
      'User profile not found. Please complete onboarding first.'
    );
  }
  return authUser as AuthenticatedUser & { dbUserId: string };
}

// ─── optionalAuth ─────────────────────────────────────────────────────────────

export async function optionalAuth(
  request: NextRequest
): Promise<AuthenticatedUser | null> {
  const cookieToken = request.cookies.get('steward-token')?.value;
  const authHeader = request.headers.get('authorization');
  const headerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const token = cookieToken ?? headerToken;

  if (!token) return null;

  const agentSession = await lookupAgentSession(token);
  if (agentSession) {
    return {
      userId: agentSession.agentId,
      privyId: agentSession.agentId,
      isAgent: true,
    };
  }

  // Invalid/expired credentials mean "anonymous"; infrastructure and
  // configuration failures propagate.
  try {
    const payload = await verifyStewardToken(token);
    return await resolveUserFromStewardPayload(payload);
  } catch (error) {
    if (isAuthenticationError(error)) return null;
    throw error;
  }
}

// ─── optionalAuthFromHeaders ──────────────────────────────────────────────────

export async function optionalAuthFromHeaders(
  headers: Headers
): Promise<AuthenticatedUser | null> {
  const authHeader = headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const agentSession = await lookupAgentSession(token);
  if (agentSession) {
    return { userId: agentSession.agentId, isAgent: true };
  }

  try {
    const payload = await verifyStewardToken(token);
    return await resolveUserFromStewardPayload(payload);
  } catch (error) {
    if (isAuthenticationError(error)) return null;
    throw error;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export function authErrorResponse(message = 'Unauthorized') {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function authenticateUser(req: NextRequest) {
  const authUser = await authenticate(req);
  return { id: authUser.userId, ...authUser };
}
