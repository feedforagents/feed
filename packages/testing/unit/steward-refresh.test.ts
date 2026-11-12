import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test';
import { FeedStewardAuth } from '../../../apps/web/src/lib/auth/feed-steward-auth';
import { createSessionCookieSync } from '../../../apps/web/src/lib/auth/session-cookie-sync';

const originalFetch = globalThis.fetch;
afterEach(() => {
  setSystemTime();
  globalThis.fetch = originalFetch;
});
function token(userId = 'user', expiresIn = 600) {
  const payload = Buffer.from(
    JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + expiresIn })
  ).toString('base64url');
  return `header.${payload}.signature`;
}
function setup(expiresIn = 60) {
  const auth = new FeedStewardAuth({
    baseUrl: 'https://auth.example.test',
    tenantId: 'feed',
  });
  auth.acceptSession(token('user', expiresIn), 'refresh-old');
  return auth;
}
function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  const request = mock(() => promise);
  globalThis.fetch = Object.assign(request, {
    preconnect: originalFetch.preconnect,
  });
  return { request, resolve };
}
function success() {
  return Response.json({
    token: token('user', 3600),
    refreshToken: 'refresh-new',
    expiresIn: 3600,
  });
}

describe('Steward refresh lifecycle', () => {
  test('coalesces overlapping refreshes, rotates tokens and notifies once', async () => {
    const auth = setup();
    const listener = mock();
    auth.onSessionChange(listener);
    const pending = pendingResponse();
    const first = auth.refreshSession();
    expect(auth.refreshSession()).toBe(first);
    pending.resolve(success());
    expect((await first)?.userId).toBe('user');
    expect(pending.request).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(auth.getRefreshToken()).toBe('refresh-new');
  });
  test('does not resurrect a session after logout', async () => {
    const auth = setup();
    const pending = pendingResponse();
    const refresh = auth.refreshSession();
    auth.signOut();
    pending.resolve(success());
    expect(await refresh).toBeNull();
    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBeNull();
  });
  test('late unauthorized response cannot clear a newly signed-in account', async () => {
    const auth = setup();
    const pending = pendingResponse();
    const refresh = auth.refreshSession();
    auth.acceptSession(token('other'), 'other-refresh');
    pending.resolve(Response.json({ error: 'invalid' }, { status: 401 }));
    await refresh;
    expect(auth.getSession()?.userId).toBe('other');
    expect(auth.getRefreshToken()).toBe('other-refresh');
  });
  test('superseded authentication ignores a late response', async () => {
    const auth = setup();
    const pending = pendingResponse();
    const refresh = auth.refreshSession();
    auth.cancelPendingRefresh();
    pending.resolve(success());
    expect(await refresh).toBeNull();
    expect(auth.getRefreshToken()).toBe('refresh-old');
  });
  test('expired access tokens retain refresh credentials for wake recovery', async () => {
    const auth = setup(-60);
    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBe('refresh-old');
    globalThis.fetch = Object.assign(
      mock(async () => success()),
      { preconnect: originalFetch.preconnect }
    );
    expect((await auth.refreshSession())?.userId).toBe('user');
  });
  test('invalid refresh credentials sign out, transient errors permit retry', async () => {
    const auth = setup();
    globalThis.fetch = Object.assign(
      mock(async () =>
        Response.json({ error: 'unavailable' }, { status: 503 })
      ),
      { preconnect: originalFetch.preconnect }
    );
    expect(await auth.refreshSession()).toBeNull();
    expect(auth.getRefreshToken()).toBe('refresh-old');
    globalThis.fetch = Object.assign(
      mock(async () => Response.json({ error: 'invalid' }, { status: 401 })),
      { preconnect: originalFetch.preconnect }
    );
    await auth.refreshSession();
    expect(auth.getRefreshToken()).toBeNull();
    expect(auth.getSession()).toBeNull();
  });
  test('callback without refresh credentials clears the previous account token', () => {
    const auth = setup();
    auth.acceptSession(token('other'));
    expect(auth.getRefreshToken()).toBeNull();
  });
  test('blocks focus, timer and getToken refresh while account-switch cookie sync is pending', async () => {
    setSystemTime(new Date('2030-01-01T00:00:00.999Z'));
    const auth = setup(1);
    const oldToken = auth.getSession()!.token;
    const refreshRequest = mock(async () => success());
    globalThis.fetch = Object.assign(refreshRequest, {
      preconnect: originalFetch.preconnect,
    });
    let releaseCookie!: (response: Response) => void;
    const cookieResponse = new Promise<Response>((resolve) => {
      releaseCookie = resolve;
    });
    const cookieWrites: string[] = [];
    const syncCookie = createSessionCookieSync(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { token: string };
      cookieWrites.push(body.token);
      return cookieResponse;
    });
    const newToken = token('other');
    const login = auth.completeLogin(newToken, 'other-refresh', syncCookie);
    await Promise.resolve();
    expect(auth.isLoginPending).toBe(true);
    expect(auth.getSession()?.userId).toBe('user');
    // These are the same entry points used by focus/timer and SDK consumers.
    await auth.refreshSession();
    await auth.refreshSession();
    auth.getToken();
    expect(refreshRequest).not.toHaveBeenCalled();
    // A listener's obsolete update queued behind the new login must not write.
    const obsoleteCookie = syncCookie(
      oldToken,
      'refresh-old',
      () => !auth.isLoginPending && auth.getSession()?.token === oldToken
    );
    releaseCookie(Response.json({ ok: true }));
    expect((await login)?.userId).toBe('other');
    await obsoleteCookie;
    expect(cookieWrites).toEqual([newToken]);
    expect(auth.getRefreshToken()).toBe('other-refresh');
    expect(auth.isLoginPending).toBe(false);
  });

  test('logout during delayed login cookie sync prevents local login publication', async () => {
    const auth = setup();
    let release!: () => void;
    const cookie = new Promise<void>((resolve) => {
      release = resolve;
    });
    const login = auth.completeLogin(
      token('other'),
      'other-refresh',
      () => cookie
    );
    const rejected = login.catch((error: Error) => error);
    auth.signOut();
    release();
    expect(await rejected).toBeInstanceOf(Error);
    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBeNull();
  });

  test('failed login cookie sync clears local credentials', async () => {
    const auth = setup();
    const syncCookie = createSessionCookieSync(async () =>
      Response.json({}, { status: 503 })
    );
    await expect(
      auth.completeLogin(token('other'), 'other-refresh', syncCookie)
    ).rejects.toThrow('503');
    expect(auth.getSession()).toBeNull();
    expect(auth.getRefreshToken()).toBeNull();
    expect(auth.isLoginPending).toBe(false);
  });
});
