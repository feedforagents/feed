import { describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function run(path: string, init?: { method?: string; origin?: string }) {
  const headers = new Headers({ host: 'feed.fun' });
  if (init?.origin) headers.set('origin', init.origin);
  return middleware(
    new NextRequest(`https://feed.fun${path}`, {
      method: init?.method ?? 'GET',
      headers,
    })
  );
}

describe('middleware', () => {
  it('treats /api-docs as a page (minimal layout), not an API route', () => {
    const response = run('/api-docs', { origin: 'https://feed.fun' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-minimal-layout')).toBe(
      '1'
    );
  });

  it('adds credentialed CORS to API routes for allowed origins', () => {
    const response = run('/api/posts', { origin: 'https://feed.fun' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://feed.fun'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true'
    );
  });

  it('uses ordinary API CORS for retired hosted-agent paths', () => {
    const response = run('/api/agents/auth', {
      origin: 'https://feed.fun',
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://feed.fun'
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(
      'true'
    );
  });

  it('does not treat /api-docs or /apix as API routes', () => {
    const response = run('/apix', { origin: 'https://feed.fun' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
