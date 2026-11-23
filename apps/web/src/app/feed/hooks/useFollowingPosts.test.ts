import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

/** Following uses the server cursor and exposes only the active viewer's rows. */
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
  private effects: { deps: unknown[] | undefined; cleanup?: () => void }[] = [];
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
      prev?.cleanup?.();
      const cleanup = fn();
      this.effects[i] = { deps, cleanup: cleanup || undefined };
    }
  }

  render<T extends object>(hookFn: () => T): T {
    this.index = 0;
    return hookFn();
  }
}

let harness: HookHarness;

mock.module('react', () => ({
  useState: (initial: unknown) => harness.useState(initial),
  useEffect: (fn: () => void | (() => void), deps: unknown[]) =>
    harness.useEffect(fn, deps),
  useCallback: (fn: (...args: never[]) => unknown, deps: unknown[]) =>
    harness.useCallback(fn, deps),
  useRef: (initial: unknown) => harness.useRef(initial),
}));

let viewer: string | undefined;
const getAccessToken = async () => 'local-fixture-token';
mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({ authenticated: viewer !== undefined, getAccessToken }),
}));
mock.module('@/stores/authStore', () => ({
  useAuthStore: () => ({ user: viewer ? { id: viewer } : null }),
}));
mock.module('@/utils/api-url', () => ({ apiUrl: (path: string) => path }));

function post(id: string, seconds: number) {
  return {
    id,
    authorId: 'fixture-author',
    timestamp: new Date(seconds * 1000).toISOString(),
  };
}
const firstPage = [post('newest', 3), post('boundary', 2)];
const nextPage = [post('boundary', 2), post('oldest', 1)];
const page = (posts: ReturnType<typeof post>[], nextCursor: string | null) =>
  Response.json({ posts, nextCursor });
const fetchStub = mock(async (_url: string, _options?: RequestInit) =>
  page(firstPage, 'next')
);
const origFetch = globalThis.fetch;
globalThis.fetch = fetchStub as unknown as typeof fetch;

beforeEach(() => {
  viewer = 'viewer-1';
  harness = new HookHarness();
  fetchStub.mockReset();
  fetchStub.mockImplementation(async (path) =>
    path.includes('cursor=') ? page(nextPage, null) : page(firstPage, 'next')
  );
});
afterAll(() => {
  globalThis.fetch = origFetch;
});

const flush = async () => {
  await Bun.sleep(0);
};
const { useFollowingPosts } = await import('./useFollowingPosts');
const render = () => harness.render(useFollowingPosts);
const loadInitial = async () => {
  render();
  await flush();
  return render();
};
const postIds = (result: ReturnType<typeof useFollowingPosts>) =>
  result.posts.map(({ id }) => id);

function deferredResponse() {
  let resolveResponse: (value: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return { promise, resolve: resolveResponse };
}

describe('useFollowingPosts cursor pagination', () => {
  it('follows a short page with a cursor, deduplicates overlap, and stops at the end', async () => {
    const initial = await loadInitial();
    expect(postIds(initial)).toEqual(['newest', 'boundary']);
    expect(initial.hasMore).toBe(true);
    expect(initial.cursor).toBe('next');
    await initial.loadMore();
    const last = render();
    expect(fetchStub.mock.calls[1]?.[0]).toContain('cursor=next');
    expect(postIds(last)).toEqual(['newest', 'boundary', 'oldest']);
    expect(last.hasMore).toBe(false);
    await last.loadMore();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed continuation retryable without immediately refetching', async () => {
    let now = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      fetchStub.mockImplementationOnce(async () => page(firstPage, 'next'));
      fetchStub.mockImplementationOnce(
        async () => new Response(null, { status: 503 })
      );
      const initial = await loadInitial();
      await initial.loadMore();
      const failed = render();
      expect(postIds(failed)).toEqual(['newest', 'boundary']);
      expect(failed.cursor).toBe('next');
      await failed.loadMore();
      expect(fetchStub).toHaveBeenCalledTimes(2);
      now += 1000;
      await failed.loadMore();
      expect(fetchStub.mock.calls[2]?.[0]).toContain('cursor=next');
      expect(postIds(render())).toEqual(['newest', 'boundary', 'oldest']);
    } finally {
      clock.mockRestore();
    }
  });

  it('clears old rows and cancels a continuation on viewer changes', async () => {
    const oldPage = deferredResponse();
    fetchStub.mockImplementationOnce(async () => page(firstPage, 'next'));
    fetchStub.mockImplementationOnce(() => oldPage.promise);
    fetchStub.mockImplementationOnce(async () =>
      page([post('other-viewer', 1)], null)
    );

    const initial = await loadInitial();
    const append = initial.loadMore();
    await flush();
    viewer = 'viewer-2';
    expect(postIds(render())).toEqual([]);
    expect(fetchStub.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await flush();
    expect(fetchStub.mock.calls[2]?.[0]).toContain('userId=viewer-2');
    oldPage.resolve(page(nextPage, 'old-cursor'));
    await append;
    expect(postIds(render())).toEqual(['other-viewer']);
    viewer = undefined;
    expect(postIds(render())).toEqual([]);
  });

  it('ignores a continuation that resolves after a refresh', async () => {
    const oldPage = deferredResponse();
    fetchStub.mockImplementationOnce(async () => page(firstPage, 'next'));
    fetchStub.mockImplementationOnce(() => oldPage.promise);
    fetchStub.mockImplementationOnce(async () =>
      page([post('refreshed', 1)], null)
    );

    const initial = await loadInitial();
    const append = initial.loadMore();
    await flush();
    await render().refresh();
    expect(fetchStub.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    oldPage.resolve(page(nextPage, 'old-cursor'));
    await append;
    expect(postIds(render())).toEqual(['refreshed']);
    expect(render().hasMore).toBe(false);
  });
});
