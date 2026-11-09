import { describe, expect, test } from 'bun:test';
import {
  appOrigin,
  redirectMatches,
  validRedirect,
} from '../../mcp/src/oauth/contracts';

describe('MCP OAuth origin and callback trust', () => {
  test('configured localhost origin is allowed, HTTP localhost callback is refused', () => {
    expect(appOrigin('http://localhost:3188')).toBe('http://localhost:3188');
    expect(validRedirect('http://localhost:8999/callback')).toBe(false);
    expect(validRedirect('http://127.0.0.1:8999/callback')).toBe(true);
    expect(validRedirect('http://[::1]:8999/callback')).toBe(true);
  });
  test('callback validation rejects non-loopback HTTP, credentials and fragments', () => {
    expect(validRedirect('http://example.com/callback')).toBe(false);
    expect(validRedirect('https://user:pass@example.com/callback')).toBe(false);
    expect(validRedirect('https://example.com/callback#fragment')).toBe(false);
    expect(validRedirect('https://example.com/callback')).toBe(true);
  });
  test('dynamic loopback ports never loosen host, path, query or scheme matching', () => {
    expect(
      redirectMatches(
        'http://127.0.0.1:8999/callback',
        'http://127.0.0.1/callback'
      )
    ).toBe(true);
    expect(
      redirectMatches(
        'http://localhost:8999/callback',
        'http://127.0.0.1/callback'
      )
    ).toBe(false);
    expect(
      redirectMatches(
        'http://127.0.0.1:8999/other',
        'http://127.0.0.1/callback'
      )
    ).toBe(false);
    expect(
      redirectMatches(
        'http://127.0.0.1:8999/callback?other=1',
        'http://127.0.0.1/callback'
      )
    ).toBe(false);
    expect(
      redirectMatches(
        'https://127.0.0.1:8999/callback',
        'http://127.0.0.1/callback'
      )
    ).toBe(false);
  });
});
