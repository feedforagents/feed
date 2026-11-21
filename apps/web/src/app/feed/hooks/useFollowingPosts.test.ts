import { describe, expect, it, mock } from 'bun:test';

/**
 * Following-tab pagination, hook level.
 *
 * The Following tab is the only feed tab without cursor pagination: the
 * shipped hook fetches page 1 (`limit=20`) once and never asks for page 2,
 * and FeedClient hardcodes `hasMore={false}` for it, so posts 21+ from
 * followed users are unreachable. PRD §8.2 promises `get_home_feed` —
 * For You / Following / Latest, cursor-paginated — and the API already
 * returns `nextCursor` for `GET /api/posts?following=true` (proven by the
 * integration probe next to this test), so the gap is purely the client
 * never following the cursor.
 *
 * This test executes the real hook with a synchronous React shim (no DOM
 * in the repo's test setup) and a stubbed fetch that serves two pages.
 * On the base hook it fails: the hook returns no `loadMore` / `hasMore` /
 * `cursor`, so page 2 can never be requested.
 */

// ---- Synchronous React shim: executes the hook's real code paths. ----
type Setter<T> = (v: T | ((p: T) => T)) => void;

interface Cell<T> {
  value: T;
}

function shallowEqual(a: unknown[], b: unknown[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

class HookHarness {
  private states: Cell<unknown>[] = [];
  private refs: { current: unknown }[] = [];
  private memos: { deps: unknown[] | undefined; value: unknown }[] = [];
  private effects: { deps: unknown[] | undefined }[] = [];
  private index = 0;

  useState<T>(initial: T): [T, Setter<T>] {
    const i = this.index++;
    let cell = this.states[i] as Cell<T> | undefined;
    if (!cell) {
      cell = { value: initial };
      this.states[i] = cell;
    }
    const set: Setter<T> = (v) => {
      cell!.value =
        typeof v === 'function' ? (v as (p: T) => T)(cell!.value) : v;
    };
    return [cell.value, set];
  }

  useRef<T>(initial: T): { current: T } {
    const i = this.index++;
    let ref = this.refs[i] as { current: T } | undefined;
    if (!ref) {
      ref = { current: initial };
      this.refs[i] = ref;
    }
    return ref;
  }

  useCallback<T extends (...args: never[]) => unknown>(
    fn: T,
    deps: unknown[]
  ): T {
    const i = this.index++;
    const memo = this.memos[i];
    if (memo && shallowEqual(deps, memo.deps)) return memo.value as T;
    this.memos[i] = { deps, value: fn };
    return fn;
  }

  useEffect(fn: () => void | (() => void), deps: unknown[]): void {
    const i = this.index++;
    const prev = this.effects[i];
    if (!prev || !shallowEqual(deps, prev.deps)) {
      this.effects[i] = { deps };
      void fn();
    }
  }

  render<T extends object>(hookFn: () => T): T {
    this.index = 0;
    return hookFn();
  }
}

const harness = new HookHarness();

mock.module('react', () => ({
  useState: (initial: unknown) => harness.useState(initial),
  useEffect: (fn: () => void | (() => void), deps: unknown[]) =>
    harness.useEffect(fn, deps),
  useCallback: (fn: (...args: never[]) => unknown, deps: unknown[]) =>
    harness.useCallback(fn, deps),
  useRef: (initial: unknown) => harness.useRef(initial),
}));

mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({
    authenticated: true,
    getAccessToken: async () => 'test-token',
  }),
}));

mock.module('@/stores/authStore', () => ({
  useAuthStore: () => ({ user: { id: 'viewer-1' } }),
}));

mock.module('@/utils/api-url', () => ({
  apiUrl: (p: string) => p,
}));

// Two pages of followed-author posts, newest first.
const page1 = Array.from({ length: 20 }, (_, i) => ({
  id: `post-p1-${i}`,
  content: `page 1 post ${i}`,
  authorId: 'author-1',
  timestamp: new Date(Date.now() - i * 1000).toISOString(),
}));
const page2 = Array.from({ length: 5 }, (_, i) => ({
  id: `post-p2-${i}`,
  content: `page 2 post ${i}`,
  authorId: 'author-1',
  timestamp: new Date(Date.now() - (20 + i) * 1000).toISOString(),
}));

const fetchUrls: string[] = [];
const fetchStub = mock(async (url: string) => {
  fetchUrls.push(url);
  const hasCursor = url.includes('cursor=');
  const posts = hasCursor ? page2 : page1;
  return {
    ok: true,
    json: async () => ({
      success: true,
      posts,
      limit: 20,
      source: 'following',
      nextCursor: hasCursor ? null : 'cursor-page-2',
    }),
  };
});
globalThis.fetch = fetchStub as unknown as typeof fetch;

const flush = async () => {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
};

const { useFollowingPosts } = await import('./useFollowingPosts');

describe('useFollowingPosts cursor pagination', () => {
  it('fetches page 1, exposes a cursor, and loads page 2 on loadMore', async () => {
    fetchUrls.length = 0;
    let result = harness.render(() => useFollowingPosts({ enabled: true }));
    await flush();
    result = harness.render(() => useFollowingPosts({ enabled: true }));

    expect(result.posts).toHaveLength(20);
    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0]).toContain('following=true');
    expect(fetchUrls[0]).not.toContain('cursor=');
    // The base hook has no pagination state at all.
    expect((result as unknown as { hasMore?: unknown }).hasMore).toBe(true);
    expect((result as unknown as { cursor?: unknown }).cursor).toBe(
      'cursor-page-2'
    );
    expect(typeof result.loadMore).toBe('function');

    await result.loadMore();
    await flush();
    result = harness.render(() => useFollowingPosts({ enabled: true }));

    expect(fetchUrls).toHaveLength(2);
    expect(fetchUrls[1]).toContain('cursor=cursor-page-2');
    expect(result.posts).toHaveLength(25);
    expect(new Set(result.posts.map((p) => p.id)).size).toBe(25);
    expect((result as unknown as { hasMore?: unknown }).hasMore).toBe(false);
    expect((result as unknown as { cursor?: unknown }).cursor).toBeNull();
  });

  it('does not fetch again once the last page is reached', async () => {
    const callsBefore = fetchUrls.length;
    const result = harness.render(() => useFollowingPosts({ enabled: true }));
    await result.loadMore();
    await flush();
    expect(fetchUrls.length).toBe(callsBefore);
  });
});
