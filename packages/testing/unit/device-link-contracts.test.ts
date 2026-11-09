import { describe, expect, test } from 'bun:test';
import { parseConnectReturn } from '../../../apps/web/src/lib/auth/connect-return';
import { normalizeUserCode } from '../../mcp/src/oauth/device';

describe('device link codes and safe sign-in continuation', () => {
  test('normalizes human-entered public codes, rejects ambiguous or unbounded input', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK');
    expect(normalizeUserCode(' BCDF GHJK ')).toBe('BCDFGHJK');
    expect(() => normalizeUserCode('ABCD-0123')).toThrow('invalid_user_code');
    expect(() => normalizeUserCode('B'.repeat(33))).toThrow(
      'invalid_user_code'
    );
  });
  test('returns only a valid unexpired same-site link path', () => {
    const saved = (path: string) => JSON.stringify({ path, expiresAt: 2000 });
    expect(parseConnectReturn(saved('/link?user_code=BCDF-GHJK'), 1000)).toBe(
      '/link?user_code=BCDF-GHJK'
    );
    expect(
      parseConnectReturn(
        saved('/link?user_code=BCDF-GHJK&next=https://other.example'),
        1000
      )
    ).toBeNull();
    expect(
      parseConnectReturn(
        saved('https://other.example/link?user_code=BCDF-GHJK'),
        1000
      )
    ).toBeNull();
    expect(
      parseConnectReturn(saved('/link?user_code=BCDF-GHJK'), 2001)
    ).toBeNull();
  });
});

describe('OAuth slow request bodies', () => {
  test('cancels a body that never finishes before the deadline', async () => {
    const { boundedBody } = await import(
      '../../../apps/web/src/lib/auth/feed-oauth'
    );
    const { NextRequest } = await import('next/server');
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const request = new NextRequest('https://feed.example/oauth/token', {
      method: 'POST',
      body,
      duplex: 'half',
    });
    await expect(boundedBody(request, 20)).rejects.toMatchObject({
      status: 408,
      code: 'invalid_request',
    });
    expect(canceled).toBe(true);
  });
});
