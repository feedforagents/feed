import { describe, expect, test } from 'bun:test';
import {
  type CimdNetwork,
  cimdUrl,
  fetchCimdMetadata,
  isPublicAddress,
  metadataCacheExpiry,
  parseCimdOrigins,
} from '../../mcp/src/oauth/cimd';
import { clientIdSchema } from '../../mcp/src/oauth/contracts';

const clientId = 'https://metadata.example.com/client.json';
const allowedOrigins = ['https://metadata.example.com'];
const document = {
  client_id: clientId,
  client_name: 'Fixture client',
  redirect_uris: ['http://127.0.0.1:9000/callback'],
};
function response(
  body: object = document,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function network(
  fetchMetadata: CimdNetwork['fetchMetadata'] = async () => response(),
  addresses = ['1.1.1.1']
): CimdNetwork {
  return { resolveAddresses: async () => addresses, fetchMetadata };
}
describe('CIMD trust and HTTP boundaries', () => {
  test('default disabled and exact origins only', () => {
    expect(parseCimdOrigins()).toEqual([]);
    expect(parseCimdOrigins(allowedOrigins[0])).toEqual(allowedOrigins);
    for (const origin of [
      'http://metadata.example.com',
      'https://*.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://m.internal',
      'https://metadata.example.com:8443',
      'https://user:pass@metadata.example.com',
      'https://metadata.example.com/path',
    ])
      expect(() => parseCimdOrigins(origin)).toThrow();
    expect(() => cimdUrl(clientId, [])).toThrow();
    expect(() =>
      cimdUrl('https://other.example.com/client.json', allowedOrigins)
    ).toThrow();
  });
  test('does not normalize distinct URLs or oversized UTF-8 IDs', () => {
    expect(cimdUrl(clientId, allowedOrigins).href).toBe(clientId);
    for (const uri of [
      'https://metadata.example.com/',
      'https://metadata.example.com:443/client.json',
      'https://metadata.example.com/a/../client.json',
      'https://metadata.example.com/a/%2e%2e/client.json',
      `${clientId}?v=1`,
      `${clientId}#fragment`,
      'https://metadata.example.com/é',
    ])
      expect(() => cimdUrl(uri, allowedOrigins)).toThrow();
    expect(clientIdSchema.safeParse('é'.repeat(1025)).success).toBe(false);
  });
  test('classifies private, mapped, and public DNS answers', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      'not-ip',
      '192.0.2.1',
      '2001:db8::1',
      '3fff::1',
    ])
      expect(isPublicAddress(address)).toBe(false);
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect(isPublicAddress(address)).toBe(true);
  });
  test('blocks private/empty/mixed DNS before any HTTP request', async () => {
    let calls = 0;
    for (const addresses of [[], ['127.0.0.1'], ['1.1.1.1', 'fc00::1']])
      await expect(
        fetchCimdMetadata(clientId, {
          allowedOrigins,
          network: network(async () => {
            calls++;
            return response();
          }, addresses),
        })
      ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test('deadline covers DNS and prevents a late HTTP request', async () => {
    let calls = 0;
    let resolveDns: (addresses: string[]) => void = () => undefined;
    const pending = fetchCimdMetadata(clientId, {
      allowedOrigins,
      timeoutMs: 10,
      network: {
        resolveAddresses: () =>
          new Promise((resolve) => {
            resolveDns = resolve;
          }),
        fetchMetadata: async () => {
          calls++;
          return response();
        },
      },
    });
    await expect(pending).rejects.toMatchObject({
      code: 'temporarily_unavailable',
      status: 503,
    });
    resolveDns(['1.1.1.1']);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(0);
  });
  test('fetch has no ambient credentials, no redirects, and defaults to code-only', async () => {
    let options: RequestInit | undefined;
    const metadata = await fetchCimdMetadata(clientId, {
      allowedOrigins,
      network: network(async (uri, init) => {
        expect(uri).toBe(clientId);
        options = init;
        return response();
      }),
    });
    expect(options?.credentials).toBe('omit');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('authorization')).toBeNull();
    expect(new Headers(options?.headers).get('cookie')).toBeNull();
    expect(metadata.grant_types).toEqual(['authorization_code']);
    expect(metadata.metadataExpiresAt).toBeNull();
  });
  test('rejects HTTP errors, redirects, wrong type/id/redirects and secret metadata', async () => {
    const replies = [
      new Response('', {
        status: 302,
        headers: { Location: 'http://127.0.0.1/' },
      }),
      new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
      response({
        ...document,
        client_id: 'https://metadata.example.com/other.json',
      }),
      response({ ...document, redirect_uris: ['javascript:alert(1)'] }),
      response({ ...document, client_secret: 'not-a-real-secret' }),
      response({
        ...document,
        jwks: { keys: [{ kty: 'RSA', d: 'private-key-material' }] },
      }),
      response({ ...document, token_endpoint_auth_method: 'private_key_jwt' }),
    ];
    for (const reply of replies)
      await expect(
        fetchCimdMetadata(clientId, {
          allowedOrigins,
          network: network(async () => reply),
        })
      ).rejects.toThrow();
  });
  test('bounds oversized, invalid JSON, and stalled bodies', async () => {
    await expect(
      fetchCimdMetadata(clientId, {
        allowedOrigins,
        network: network(
          async () =>
            new Response('x'.repeat(16_385), {
              headers: { 'Content-Type': 'application/json' },
            })
        ),
      })
    ).rejects.toThrow();
    await expect(
      fetchCimdMetadata(clientId, {
        allowedOrigins,
        network: network(
          async () =>
            new Response('{', {
              headers: { 'Content-Type': 'application/json' },
            })
        ),
      })
    ).rejects.toThrow();
    let canceled = false;
    await expect(
      fetchCimdMetadata(clientId, {
        allowedOrigins,
        timeoutMs: 20,
        network: network(
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
              { headers: { 'Content-Type': 'application/json' } }
            )
        ),
      })
    ).rejects.toThrow();
    expect(canceled).toBe(true);
  });
  test('honors restrictive freshness, Age and maximum reuse window', () => {
    const now = Date.now();
    for (const value of [
      'no-store, max-age=3600',
      'private, max-age=3600',
      'no-cache, max-age=3600',
      'max-age=0',
      'max-age=60, max-age=120',
      'max-age=999999999999999999999999999',
      '',
    ])
      expect(
        metadataCacheExpiry(new Headers({ 'Cache-Control': value }), now)
      ).toBeNull();
    expect(
      metadataCacheExpiry(
        new Headers({ 'Cache-Control': 'max-age=120', Age: '30' }),
        now
      )?.getTime()
    ).toBe(now + 90_000);
    expect(
      metadataCacheExpiry(
        new Headers({ 'Cache-Control': 'max-age=999999' }),
        now
      )?.getTime()
    ).toBe(now + 3_600_000);
    expect(
      metadataCacheExpiry(
        new Headers({ 'Cache-Control': 'max-age=120', Age: '121' }),
        now
      )
    ).toBeNull();
  });
});
