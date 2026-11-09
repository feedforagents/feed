import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';

const webRoot = resolve(import.meta.dir, '../../../apps/web/src');
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const stubs: Record<string, string> = {
  '@/hooks/useAuth': `import {useSyncExternalStore} from 'react'; const subscribe=fn=>{window.addEventListener('test-auth-change',fn);return()=>window.removeEventListener('test-auth-change',fn)}; const snapshot=()=>window.testAuthState; const getAccessToken=async()=>window.testAuthState.authenticated?'local-component-test':null; export const useAuth=()=>({...useSyncExternalStore(subscribe,snapshot,snapshot),getAccessToken,login(){}});`,
  '@/components/providers/StewardAuthProvider': `import {useAuth} from '@/hooks/useAuth'; export const useStewardAuthContext=()=>{const state=useAuth(); return {session:state.authenticated?{userId:state.testSessionId}:null};};`,
  'next/navigation': `const router={push(path){window.testRoutes.push(path)},refresh(){}}; export const useRouter=()=>router; export const usePathname=()=>window.location.pathname;`,
  '@/hooks/usePostHog': `export const useSocialTracking=()=>({trackFollow(){},trackPostLike(){}});`,
  '@/lib/auth': `export const getAuthToken=()=>'local-component-test';`,
  '@/utils/api-fetch': `export const apiFetch=(url,init)=>fetch(url,init);`,
};
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, 'fixtures/pending-intent-components.tsx'),
    ],
    target: 'browser',
    define: { 'process.env.NODE_ENV': '"test"', 'process.env': '{}' },
    plugins: [
      {
        name: 'component-boundaries',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({
            path: Bun.resolveSync('react', webRoot),
          }));
          build.onResolve(
            { filter: /^(?:@\/|next\/navigation$)/ },
            ({ path }) =>
              stubs[path]
                ? { path, namespace: 'test-boundary' }
                : {
                    path:
                      ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
                        .map(
                          (suffix) => resolve(webRoot, path.slice(2)) + suffix
                        )
                        .find(existsSync) ?? resolve(webRoot, path.slice(2)),
                  }
          );
          build.onLoad(
            { filter: /.*/, namespace: 'test-boundary' },
            ({ path }) => ({ contents: stubs[path] ?? '', loader: 'js' })
          );
        },
      },
    ],
  });
  if (!result.success || !result.outputs[0])
    throw new Error(result.logs.map(String).join('\n'));
  const script = await result.outputs[0].text();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/bundle.js')
        return new Response(script, {
          headers: { 'Content-Type': 'text/javascript' },
        });
      return new Response(
        '<div id="root"></div><script type="module" src="/bundle.js"></script>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    },
  });
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe('mounted social continuation controls', () => {
  test('server like count is applied once and the next explicit click undoes it with DELETE', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const methods: string[] = [];
    await page.route('**/api/posts/post-1/like', async (route) => {
      methods.push(route.request().method());
      await route.fulfill({ json: { data: { isLiked: false, likeCount: 6 } } });
    });
    await page.route('**/api/users/target/follow', (route) =>
      route.fulfill({ json: { isFollowing: false } })
    );
    await page.goto(server.url.href);
    await page.locator('#like button').waitFor();
    await page.evaluate(() => window.completeSocialIntent('like'));
    await page.waitForFunction(() =>
      document.querySelector('#like button')?.className.includes('text-red-500')
    );
    expect(await page.locator('#like').innerText()).toBe('7');
    await page.locator('#like button').click();
    await page.waitForFunction(
      () => document.querySelector('#like')?.textContent === '6'
    );
    expect(methods).toEqual(['DELETE']);
    expect(errors).toEqual([]);
    await page.close();
  }, 30000);
  test('completion invalidates a late follow-status GET and manual unfollow stays undone', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const methods: string[] = [];
    let releaseStatus: () => void = () => {};
    const statusGate = new Promise<void>((resolveGate) => {
      releaseStatus = resolveGate;
    });
    await page.route('**/api/users/target/follow', async (route) => {
      const method = route.request().method();
      methods.push(method);
      if (method === 'GET') {
        await statusGate;
        await route.fulfill({ json: { isFollowing: false } });
      } else await route.fulfill({ json: { success: true } });
    });
    await page.goto(server.url.href);
    await page.waitForFunction(
      () => document.querySelector('#follow') !== null
    );
    await page.evaluate(() => window.completeSocialIntent('follow'));
    await page.getByRole('button', { name: 'Unfollow', exact: true }).waitFor();
    releaseStatus();
    await page.waitForTimeout(100);
    expect(
      await page.locator('#follow button').getAttribute('aria-label')
    ).toBe('Unfollow');
    await page.locator('#follow button').click();
    await page.getByRole('button', { name: 'Follow', exact: true }).waitFor();
    await page.waitForTimeout(100);
    expect(
      await page.locator('#follow button').getAttribute('aria-label')
    ).toBe('Follow');
    expect(methods).toEqual(['GET', 'DELETE']);
    expect(errors).toEqual([]);
    await page.close();
  }, 30000);
});

const profile = (
  owner = 'owner',
  tosAcceptedAt: string | null = '2026-11-09T00:00:00.000Z'
) => ({
  authenticated: true,
  needsOnboarding: false,
  user: { id: owner, username: owner, profileComplete: true, tosAcceptedAt },
});
const likeAction = {
  kind: 'like',
  targetId: 'post-1',
  targetType: 'post',
  desired: true,
} as const;
describe('mounted sign-in continuation lifecycle', () => {
  test('two mounted consumers and duplicate callbacks submit once, after the claim and fresh profile', async () => {
    const page = await browser.newPage();
    let profiles = 0;
    let writes = 0;
    await page.route('**/api/users/me', async (route) => {
      profiles++;
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem('feed.pending-intent.v1')
        )
      ).toBeNull();
      await route.fulfill({ json: profile() });
    });
    await page.route('**/api/posts/post-1/like', async (route) => {
      writes++;
      expect(route.request().method()).toBe('POST');
      await route.fulfill({ json: { data: { isLiked: true, likeCount: 7 } } });
    });
    await page.goto(`${server.url.href}?consumer=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.setTestAuth('owner', 'steward-owner');
      window.finishTestLogin();
      window.finishTestLogin();
    }, likeAction);
    await page.waitForFunction(() => window.pendingTestPhase() === 'idle');
    await page.waitForTimeout(100);
    expect(profiles).toBe(1);
    expect(writes).toBe(1);
    await page.reload();
    await page.waitForTimeout(100);
    expect(writes).toBe(1);
    await page.close();
  }, 30000);
  test('cancel and browser back discard the action rather than submit after a late sign-in', async () => {
    const page = await browser.newPage();
    let writes = 0;
    await page.route('**/api/**', async (route) => {
      writes++;
      await route.fulfill({ json: profile() });
    });
    await page.goto(`${server.url.href}?consumer=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.cancelTestLogin();
      window.setTestAuth('owner', 'steward-owner');
      window.finishTestLogin();
    }, likeAction);
    await page.waitForTimeout(100);
    expect(writes).toBe(0);
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.finishTestLogin();
    }, likeAction);
    await page.waitForTimeout(100);
    expect(writes).toBe(0);
    await page.close();
  }, 30000);
  test('account switch while fresh profile is pending cannot execute as either account', async () => {
    const page = await browser.newPage();
    let writes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await page.route('**/api/users/me', async (route) => {
      await gate;
      await route.fulfill({ json: profile('ownerA') });
    });
    await page.route('**/api/posts/post-1/like', async (route) => {
      writes++;
      await route.fulfill({ json: {} });
    });
    await page.goto(`${server.url.href}?consumer=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.setTestAuth('ownerA', 'stewardA');
      window.finishTestLogin();
    }, likeAction);
    await page.waitForFunction(() => window.pendingTestPhase() === 'running');
    await page.evaluate(() => window.setTestAuth('ownerB', 'stewardB'));
    release();
    await page.waitForFunction(() => window.pendingTestPhase() === 'idle');
    await page.waitForTimeout(100);
    expect(writes).toBe(0);
    await page.close();
  }, 30000);
  test('missing persisted Terms waits for required profile completion and freshly rechecks before a single write', async () => {
    const page = await browser.newPage();
    let accepted = false;
    let writes = 0;
    await page.route('**/api/users/me', (route) =>
      route.fulfill({
        json: profile('owner', accepted ? '2026-11-09T00:00:00.000Z' : null),
      })
    );
    await page.route('**/api/posts/post-1/like', async (route) => {
      writes++;
      await route.fulfill({ json: { data: { isLiked: true, likeCount: 7 } } });
    });
    await page.goto(`${server.url.href}?consumer=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.setTestAuth('owner', 'steward-owner', null);
      window.finishTestLogin();
    }, likeAction);
    await page.waitForFunction(() => window.pendingTestPhase() === 'profile');
    expect(writes).toBe(0);
    expect(await page.evaluate(() => window.testRoutes)).toContain('/profile');
    accepted = true;
    await page.evaluate(() => window.setTestAuth('owner', 'steward-owner'));
    await page.waitForFunction(() => window.pendingTestPhase() === 'idle');
    await page.waitForTimeout(100);
    expect(writes).toBe(1);
    await page.close();
  }, 30000);
});

describe('restored inputs and expiry', () => {
  test('a feed input cannot consume a reply before destination mount; destination restores draft without submitting and clears it on account switch', async () => {
    const page = await browser.newPage();
    let writes = 0;
    await page.route('**/api/users/me', (route) =>
      route.fulfill({ json: profile() })
    );
    await page.route('**/api/posts/post-1/comments', async (route) => {
      writes++;
      await route.fulfill({ json: {} });
    });
    await page.goto(`${server.url.href}?consumer=1&draft=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate(() => {
      window.startPendingAction({
        kind: 'reply',
        postId: 'post-1',
        content: 'My retained draft',
      });
      window.setTestAuth('owner', 'steward-owner');
      window.finishTestLogin();
    });
    await page.waitForFunction(() => window.pendingTestPhase() === 'review');
    expect(await page.locator('textarea').inputValue()).toBe('');
    expect(await page.evaluate(() => window.testRoutes)).toContain(
      '/post/post-1'
    );
    await page.evaluate(() => {
      history.replaceState(null, '', '/post/post-1');
      window.setTestAuth('owner', 'steward-owner');
    });
    await page.waitForFunction(
      () => document.querySelector('textarea')?.value === 'My retained draft'
    );
    expect(writes).toBe(0);
    await page.evaluate(() => window.setTestAuth('ownerB', 'stewardB'));
    await page.waitForFunction(
      () => document.querySelector('textarea')?.value === ''
    );
    expect(writes).toBe(0);
    await page.close();
  }, 30000);
  test('expiry while profile response is delayed frees the shared claim and prevents the old write', async () => {
    const page = await browser.newPage();
    let writes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await page.clock.install();
    await page.route('**/api/users/me', async (route) => {
      await gate;
      await route.fulfill({ json: profile() });
    });
    await page.route('**/api/posts/post-1/like', async (route) => {
      writes++;
      await route.fulfill({ json: {} });
    });
    await page.goto(`${server.url.href}?consumer=1`);
    await page.waitForFunction(
      () => typeof window.startPendingAction === 'function'
    );
    await page.evaluate((action) => {
      window.startPendingAction(action);
      window.setTestAuth('owner', 'steward-owner');
      window.finishTestLogin();
    }, likeAction);
    await page.waitForFunction(() => window.pendingTestPhase() === 'running');
    await page.clock.fastForward(600001);
    await page.waitForFunction(() => window.pendingTestPhase() === 'idle');
    release();
    await page.waitForTimeout(100);
    expect(writes).toBe(0);
    await page.close();
  }, 30000);
  test('a late old-owner/old-input perp preview cannot replace the new quote even with unchanged inputs after sign-in', async () => {
    const page = await browser.newPage();
    let release: () => void = () => {};
    let requests = 0;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await page.route('**/api/markets/perps/preview', async (route) => {
      requests++;
      const requestNumber = requests;
      if (requestNumber === 1) await gate;
      await route.fulfill({
        json: {
          preview: { executionPrice: requestNumber === 1 ? 111 : 222 },
        },
      });
    });
    await page.goto(`${server.url.href}?preview=1`);
    await page.waitForFunction(
      () => typeof window.setPreviewSize === 'function'
    );
    await page.waitForTimeout(160);
    await page.evaluate(() => window.setTestAuth('ownerB', 'stewardB'));
    await page.waitForFunction(() =>
      document.querySelector('#preview')?.textContent?.includes('222')
    );
    release();
    await page.waitForTimeout(100);
    expect(await page.locator('#preview').innerText()).not.toContain('111');
    expect(requests).toBe(2);
    await page.evaluate(() => window.setPreviewSize(200));
    expect(await page.locator('#preview').innerText()).not.toContain('222');
    await page.close();
  }, 30000);
});
