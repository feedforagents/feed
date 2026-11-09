import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/mcp/route';

describe('explicit legacy MCP discovery compatibility', () => {
  test('known legacy Bearer format retains the public legacy manifest', async () => {
    const response = await GET(
      new NextRequest('https://feed.example/mcp', {
        headers: { Authorization: `Bearer bab_live_${'a'.repeat(64)}` },
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: object[] };
    expect(body.tools.length).toBeGreaterThan(3);
  });
  test('the documented key header retains legacy discovery', async () => {
    const response = await GET(
      new NextRequest('https://feed.example/mcp', {
        headers: { 'X-Feed-Api-Key': 'public-manifest-probe' },
      })
    );
    expect(response.status).toBe(200);
  });
  test('anonymous, unknown, and OAuth Bearer requests never get the legacy manifest', async () => {
    for (const token of [
      undefined,
      'unknown-token',
      `fmcpa_${'a'.repeat(43)}`,
    ]) {
      const response = await GET(
        new NextRequest('https://feed.example/mcp', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });
});
