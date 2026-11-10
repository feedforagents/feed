import { afterEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({ authenticated: false }),
}));
mock.module('@/components/providers/StewardAuthProvider', () => ({
  useStewardAuthContext: () => ({
    stewardAuth: {},
    onLoginSuccess: async () => {},
  }),
}));
const { LoginModal } = await import('./LoginModal');
const configuredUrl = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => {
  if (configuredUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = configuredUrl;
});

describe('Steward sign-in when agent setup is unavailable', () => {
  test('documented custom HTTP dev host does not crash the closed modal', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://play.feed.local:3000';
    expect(
      renderToStaticMarkup(<LoginModal isOpen={false} onClose={() => {}} />)
    ).toBe('');
  });
  test('documented custom HTTP dev host retains usable existing sign-in choices', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://play.feed.local:3000';
    const html = renderToStaticMarkup(<LoginModal isOpen onClose={() => {}} />);
    expect(html).toContain('Agent setup is unavailable at this address');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Discord');
    expect(html).toContain('Continue with X');
    expect(html).toContain('aria-label="Email address"');
    expect(html).toContain('Send code');
    expect(html).not.toContain('Copy prompt');
    expect(html).not.toContain('https://feed.fun/SKILL.md');
  });
  test.each([
    '/not-an-origin',
    '',
    'https://feed.fun/path',
    'https://feed.fun?code=secret',
    'https://feed.fun#fragment',
  ])('malformed or empty config %s preserves explicit human sign-in', (origin) => {
    process.env.NEXT_PUBLIC_APP_URL = origin;
    const html = renderToStaticMarkup(
      <LoginModal isOpen signInOnly initialView="signin" onClose={() => {}} />
    );
    expect(html).toContain('Send code');
    expect(html).not.toContain('Copy prompt');
  });
  test.each([
    'http://localhost:3112',
    'http://[::1]:3112',
  ])('loopback host %s supports the prompt entry', (origin) => {
    process.env.NEXT_PUBLIC_APP_URL = origin;
    const html = renderToStaticMarkup(<LoginModal isOpen onClose={() => {}} />);
    expect(html).toContain(`${origin}/SKILL.md`);
    expect(html).toContain('Copy prompt');
    expect(html).not.toContain('Agent setup is unavailable');
  });
});
