import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const FEED_MCP_CAPABILITIES = {
  grantTypes: ['authorization_code', 'refresh_token'],
  clientRegistration: 'dynamic',
  scopes: ['read', 'social:write', 'messages', 'trade'],
  tools: [
    'about_feed',
    'how_to_play',
    'whoami',
    'repost',
    'unrepost',
    'get_post',
    'get_profile',
  ],
  deviceAuthorization: false,
  clientIdMetadataDocuments: false,
} as const;
export const scopeSchema = z.enum(FEED_MCP_CAPABILITIES.scopes);
export type FeedScope = z.infer<typeof scopeSchema>;
export interface FeedAgentContext {
  accountId: string;
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: FeedScope[];
  mode: 'game' | 'social';
}
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400
  ) {
    super(code);
  }
}
export function opaque(prefix: string) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}
export function hash(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}
export function parseScopes(value: string): FeedScope[] {
  const scopes = [...new Set(value.split(' ').filter(Boolean))];
  const parsed = z.array(scopeSchema).min(1).safeParse(scopes);
  if (!parsed.success) throw new OAuthError('invalid_scope');
  return parsed.data;
}
export function appOrigin(configured: string) {
  const url = new URL(configured);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (isLoopback(url) || url.hostname === 'localhost')
      ))
  ) {
    throw new Error(
      'Feed OAuth requires a configured HTTPS origin (HTTP loopback allowed locally)'
    );
  }
  return url.origin;
}
function isLoopback(url: URL) {
  return url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
export function validRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url)))
  );
}
export function redirectMatches(
  candidate: string,
  registered: string
): boolean {
  if (!validRedirect(candidate) || !validRedirect(registered)) return false;
  if (candidate === registered) return true;
  const actual = new URL(candidate);
  const expected = new URL(registered);
  if (
    actual.protocol !== 'http:' ||
    expected.protocol !== 'http:' ||
    !isLoopback(actual)
  )
    return false;
  actual.port = '';
  expected.port = '';
  return actual.href === expected.href;
}
export function resourceMatches(candidate: string, resource: string) {
  return candidate === resource || candidate === `${resource}/`;
}
export const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z
    .array(z.string().max(2048).refine(validRedirect))
    .min(1)
    .max(8),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).max(1).default(['code']),
});
export const authorizationSchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().max(100),
    redirect_uri: z.string().max(2048),
    state: z.string().max(4096).default(''),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal('S256'),
    resource: z.string().max(2048),
    scope: z.string().max(200).default('read social:write messages trade'),
  })
  .strict();
export const approvalSchema = z
  .object({
    requestId: z.string().max(100),
    action: z.enum(['approve', 'deny']),
    scopes: z.array(scopeSchema).max(4),
  })
  .strict();
