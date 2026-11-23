import { describe, expect, it } from 'bun:test';
import { GET } from '../agent-card.json/route';

describe('/.well-known/agent-card.json', () => {
  it('serves the canonical card and discovery headers', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const card = (await response.json()) as { url: string };
    expect(new URL(card.url).pathname).toBe('/api/a2a');
  });
});
