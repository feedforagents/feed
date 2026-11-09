import { resolve4, resolve6 } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { clientIdSchema, OAuthError, registrationSchema } from './contracts';

const MAX_BYTES = 16_384;
const MAX_CACHE_MS = 3_600_000;
export interface CimdNetwork {
  resolveAddresses(hostname: string): Promise<string[]>;
  fetchMetadata(url: string, options: RequestInit): Promise<Response>;
}
export interface CimdPolicy {
  allowedOrigins: readonly string[];
  network?: CimdNetwork;
  timeoutMs?: number;
}
const defaultNetwork: CimdNetwork = {
  async resolveAddresses(hostname) {
    // resolve4/6 are supported by Workers nodejs_compat; lookup is not.
    const answers = await Promise.allSettled([
      resolve4(hostname),
      resolve6(hostname),
    ]);
    return answers.flatMap((answer) =>
      answer.status === 'fulfilled' ? answer.value : []
    );
  },
  fetchMetadata: (url, options) => fetch(url, options),
};
function permittedHost(hostname: string) {
  return (
    !ipaddr.isValid(hostname.replace(/^\[|\]$/g, '')) &&
    hostname.length <= 253 &&
    hostname.includes('.') &&
    hostname
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/\.(?:localhost|local|internal|invalid|test|onion)$/.test(hostname)
  );
}
export function parseCimdOrigins(value = ''): string[] {
  if (!value.trim()) return [];
  const origins = value.split(',').map((entry) => entry.trim());
  if (origins.length > 16)
    throw new Error('CIMD allows at most 16 configured origins');
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.origin !== origin ||
      !permittedHost(url.hostname)
    )
      throw new Error(
        'CIMD origins must be exact trusted HTTPS origins on port 443'
      );
  }
  return [...new Set(origins)];
}
export function cimdUrl(value: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('invalid_client_metadata');
  }
  // Reject rather than normalize distinct client identifiers. Queries and root
  // documents are deliberately unsupported conservative trust-policy choices.
  if (
    !clientIdSchema.safeParse(value).success ||
    !/^[\x21-\x7e]+$/.test(value) ||
    url.href !== value ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname === '/' ||
    url.search ||
    url.hash ||
    !permittedHost(url.hostname) ||
    !allowedOrigins.includes(url.origin)
  )
    throw new OAuthError('invalid_client_metadata');
  return url;
}
export function isPublicAddress(value: string): boolean {
  return ipaddr.isValid(value) && ipaddr.process(value).range() === 'unicast';
}
function privateJwk(value: unknown): boolean {
  const remaining: unknown[] = [value];
  const privateFields = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);
  while (remaining.length) {
    const item = remaining.pop();
    if (Array.isArray(item)) {
      remaining.push(...item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) {
      if (privateFields.has(key)) return true;
      remaining.push(child);
    }
  }
  return false;
}
const documentSchema = z.object({
  client_id: clientIdSchema,
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
  client_secret: z.never().optional(),
  client_secret_expires_at: z.never().optional(),
  jwks: z
    .unknown()
    .refine((value) => !privateJwk(value))
    .optional(),
});
export function metadataCacheExpiry(
  headers: Headers,
  now = Date.now()
): Date | null {
  const directives = (headers.get('cache-control') ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase());
  if (
    directives.some((part) =>
      /^(?:no-store|no-cache|private)(?:=|$)/.test(part)
    )
  )
    return null;
  const ages = directives
    .map((part) => /^max-age="?(\d+)"?$/.exec(part))
    .filter((value) => value !== null);
  if (ages.length !== 1) return null;
  const maxAge = Number(ages[0]?.[1]);
  const ageHeader = headers.get('age') ?? '0';
  if (!/^\d+$/.test(ageHeader)) return null;
  const age = Number(ageHeader);
  if (!Number.isSafeInteger(maxAge) || !Number.isSafeInteger(age)) return null;
  const date = headers.get('date');
  const apparentAge = date ? Math.max(0, now - Date.parse(date)) : 0;
  if (!Number.isFinite(apparentAge)) return null;
  const remaining = maxAge * 1000 - Math.max(age * 1000, apparentAge);
  return remaining > 0
    ? new Date(now + Math.min(remaining, MAX_CACHE_MS))
    : null;
}
export async function fetchCimdMetadata(clientId: string, policy: CimdPolicy) {
  const url = cimdUrl(clientId, policy.allowedOrigins);
  const network = policy.network ?? defaultNetwork;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OAuthError('temporarily_unavailable', 503));
    }, policy.timeoutMs ?? 5000);
  });
  const run = async () => {
    const addresses = await network
      .resolveAddresses(url.hostname)
      .catch(() => []);
    if (
      !addresses.length ||
      addresses.some((address) => !isPublicAddress(address))
    )
      throw new OAuthError('invalid_client_metadata');
    // This public-address preflight is defense in depth, NOT DNS pinning. The
    // allowlist trusts operator-selected DNS and TLS; fetch may resolve again.
    if (controller.signal.aborted)
      throw new OAuthError('temporarily_unavailable', 503);
    const response = await network
      .fetchMetadata(clientId, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      .catch(() => {
        throw new OAuthError('invalid_client_metadata');
      });
    const type = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== clientId) ||
      !type ||
      !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(type)
    ) {
      await response.body?.cancel();
      throw new OAuthError('invalid_client_metadata');
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
      await response.body?.cancel();
      throw new OAuthError('invalid_client_metadata');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OAuthError('invalid_client_metadata');
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read().catch(() => {
          throw new OAuthError('invalid_client_metadata');
        });
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new OAuthError('invalid_client_metadata');
        }
        chunks.push(value);
      }
    } finally {
      controller.signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        throw new OAuthError('invalid_client_metadata');
      throw error;
    }
    const document = documentSchema.safeParse(json);
    if (!document.success || document.data.client_id !== clientId)
      throw new OAuthError('invalid_client_metadata');
    const metadata = registrationSchema.safeParse({
      ...document.data,
      grant_types: document.data.grant_types ?? ['authorization_code'],
    });
    if (!metadata.success) throw new OAuthError('invalid_client_metadata');
    return {
      ...metadata.data,
      client_id: clientId,
      metadataExpiresAt: metadataCacheExpiry(response.headers),
    };
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
