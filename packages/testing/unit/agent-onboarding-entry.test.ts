import { describe, expect, test } from 'bun:test';
import { parseConnectReturn } from '../../../apps/web/src/lib/auth/connect-return';
import {
  agentEntryView,
  agentSetupPrompt,
} from '../../../apps/web/src/lib/onboarding/agent-entry';
import {
  analyticsUrl,
  isPrivateAnalyticsPath,
  redactAnalyticsUrls,
} from '../../../apps/web/src/lib/posthog/privacy';

describe('agent onboarding entry', () => {
  test('production cannot be switched to sign-in-first by a preview query', () => {
    expect(agentEntryView('signin', false)).toBe('agent');
    expect(agentEntryView('signin', true)).toBe('signin');
    expect(agentEntryView('unexpected', true)).toBe('agent');
  });
  test('prompt connects to configured preview origin, never a supplied request Host', () => {
    expect(agentSetupPrompt('https://preview.feed.fun')).toContain(
      'https://preview.feed.fun/SKILL.md'
    );
    expect(agentSetupPrompt('http://localhost:3100')).toContain(
      'http://localhost:3100/SKILL.md'
    );
    expect(agentSetupPrompt()).toContain('https://feed.fun/SKILL.md');
    expect(agentSetupPrompt('http://[::1]:3100')).toContain(
      'http://[::1]:3100/SKILL.md'
    );
    for (const invalid of [
      'https://feed.fun/path',
      'https://feed.fun?code=secret',
      'https://feed.fun#fragment',
      '',
    ])
      expect(() => agentSetupPrompt(invalid)).toThrow();
    expect(() => agentSetupPrompt('http://remote.example')).toThrow();
    expect(() => agentSetupPrompt('/relative')).toThrow();
    expect(() => agentSetupPrompt('javascript:alert(1)')).toThrow();
    expect(() => agentSetupPrompt('https://secret@feed.fun')).toThrow();
  });
  test('cross-tab login returns only to a fresh opaque Feed approval', () => {
    const path = '/connect?request=opaque-request-id-123';
    expect(
      parseConnectReturn(JSON.stringify({ path, expiresAt: 101 }), 100)
    ).toBe(path);
    for (const invalid of [
      null,
      '{}',
      'null',
      '[]',
      '{',
      JSON.stringify({ path, expiresAt: 100 }),
      JSON.stringify({ path: '//evil.test', expiresAt: 101 }),
      JSON.stringify({
        path: '/connect?request=abc&code=secret',
        expiresAt: 101,
      }),
    ]) {
      expect(parseConnectReturn(invalid, 100)).toBeNull();
    }
  });
});

describe('onboarding analytics privacy', () => {
  test('all auth and approval routes are private, ordinary feeds are public', () => {
    for (const path of [
      '/auth/callback/google',
      '/oauth/authorize',
      '/connect',
      '/link',
      '/onboarding',
    ])
      expect(isPrivateAnalyticsPath(path)).toBe(true);
    expect(isPrivateAnalyticsPath('/feed')).toBe(false);
    expect(isPrivateAnalyticsPath('/profiles/authors')).toBe(false);
  });
  test('credentials in URLs and referrers never reach analytics', () => {
    expect(
      analyticsUrl('https://feed.fun/feed?code=secret&state=opaque#token=jwt')
    ).toBe('https://feed.fun/feed');
    expect(analyticsUrl('/feed?access_token=secret')).toBe('/feed');
    const nested = {
      $set: { $initial_current_url: 'https://feed.fun/feed?code=secret' },
      $search_params: 'token=secret',
    };
    redactAnalyticsUrls(nested);
    expect(nested.$set.$initial_current_url).toBe('https://feed.fun/feed');
    expect(Object.hasOwn(nested, '$search_params')).toBe(false);
  });
});
