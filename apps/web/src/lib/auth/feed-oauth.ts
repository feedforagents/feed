import { authenticateWithDbUser, isAuthenticationError } from '@feed/api';
import { FeedOAuthService, OAuthError, opaque } from '@feed/mcp';
import { errors as joseErrors, jwtVerify } from 'jose';
import { NextRequest } from 'next/server';
import { getStewardJwtSecret } from './steward-server';

export const APPROVAL_COOKIE = 'feed-oauth-browser';
export function oauthService() {
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  if (!origin)
    throw new Error('NEXT_PUBLIC_APP_URL is required for Feed OAuth');
  return new FeedOAuthService(origin);
}
export function oauthResponse(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}
export async function oauthBoundary(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OAuthError)
      return oauthResponse({ error: error.code }, error.status);
    if (isAuthenticationError(error) || error instanceof joseErrors.JOSEError)
      return oauthResponse({ error: 'authentication_required' }, 401);
    throw error;
  }
}
export function requireBrowserOrigin(request: NextRequest) {
  if (request.headers.get('origin') !== oauthService().origin)
    throw new OAuthError('access_denied', 403);
}
export async function browserAccount(request: NextRequest) {
  const token = request.cookies.get('steward-token')?.value;
  if (!token) throw new OAuthError('authentication_required', 401);
  const { payload } = await jwtVerify(token, getStewardJwtSecret(), {
    issuer: 'steward',
    algorithms: ['HS256'],
  });
  const expectedTenant =
    process.env.STEWARD_TENANT_ID ?? process.env.NEXT_PUBLIC_STEWARD_TENANT_ID;
  if (!expectedTenant)
    throw new Error('Steward tenant must be configured for OAuth approval');
  if (payload.tenantId !== expectedTenant)
    throw new OAuthError('access_denied', 403);
  const cookieOnly = new NextRequest(
    `${oauthService().origin}/api/oauth/approve`,
    { headers: { cookie: `steward-token=${token}` } }
  );
  const account = await authenticateWithDbUser(cookieOnly);
  return account.dbUserId;
}
export function browserBinding(request: NextRequest) {
  const binding = request.cookies.get(APPROVAL_COOKIE)?.value;
  if (!binding || !/^fmcpcb_[A-Za-z0-9_-]{43}$/.test(binding))
    throw new OAuthError('invalid_request');
  return binding;
}
export function newBrowserBinding(request: NextRequest) {
  const value = request.cookies.get(APPROVAL_COOKIE)?.value;
  return value && /^fmcpcb_[A-Za-z0-9_-]{43}$/.test(value)
    ? value
    : opaque('fmcpcb');
}
export function singleParameters(
  params: URLSearchParams
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(values, key)) throw new OAuthError('invalid_request');
    values[key] = value;
  }
  return values;
}
export async function formParameters(request: NextRequest) {
  if (
    !request.headers
      .get('content-type')
      ?.startsWith('application/x-www-form-urlencoded')
  )
    throw new OAuthError('invalid_request');
  const text = await boundedBody(request);
  if (text.length > 16_384) throw new OAuthError('invalid_request');
  return singleParameters(new URLSearchParams(text));
}
export async function jsonObject(
  request: NextRequest
): Promise<Record<string, unknown>> {
  const text = await boundedBody(request);
  if (text.length > 16_384) throw new OAuthError('invalid_request');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OAuthError('invalid_request');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new OAuthError('invalid_request');
  return value as Record<string, unknown>;
}
export function requestRateKey(request: NextRequest) {
  // Use the existing trusted edge address when available; an untrusted caller
  // cannot evade the global bucket merely by inventing a forwarded address.
  return request.headers.get('cf-connecting-ip') ?? 'direct';
}

export async function boundedBody(request: NextRequest, timeoutMs = 5000) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Cancellation is best-effort after a bounded read has already timed out.
      void reader.cancel().catch(() => undefined);
      reject(new OAuthError('invalid_request', 408));
    }, timeoutMs);
  });
  try {
    return await Promise.race([readBounded(reader), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function readBounded(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_384) {
        await reader.cancel();
        throw new OAuthError('invalid_request');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
