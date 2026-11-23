import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/** Profile posts follow the server cursor past the first 100, like Following. */
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

let actorId: string | null;

function post(id: string, seconds: number) {
  return {
    id,
    author: 'fixture-author',
    authorId: 'fixture-author',
    content: `post ${id}`,
    timestamp: new Date(seconds * 1000).toISOString(),
  };
}
const firstPage = [post('newest', 3), post('boundary', 2)];
const nextPage = [post('boundary', 2), post('oldest', 1)];
const page = (
  posts: ReturnType<typeof post>[],
  cursor: string | null,
  hasMore: boolean
) => Response.json({ posts, cursor, hasMore });
const fetchStub = mock(async (_url: string, _options?: RequestInit) =>
  page(firstPage, 'next', true)
);
const origFetch = globalThis.fetch;
globalThis.fetch = fetchStub as unknown as typeof fetch;

beforeEach(() => {
  actorId = 'actor-1';
  harness = new HookHarness();
  fetchStub.mockReset();
  fetchStub.mockImplementation(async (path) =>
    path.includes('cursor=')
      ? page(nextPage, null, false)
      : page(firstPage, 'next', true)
  );
});
afterAll(() => {
  globalThis.fetch = origFetch;
});

const flush = async () => {
  await Bun.sleep(0);
};
const { useActorPosts } = await import('./useActorPosts');
const render = () => harness.render(() => useActorPosts(actorId));
const loadInitial = async () => {
  render();
  await flush();
  return render();
};
const postIds = (result: ReturnType<typeof useActorPosts>) =>
  result.posts.map(({ id }) => id);

describe('useActorPosts cursor pagination', () => {
  it('follows the API cursor past the first page and stops at the end', async () => {
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

  it('resets when the actor changes', async () => {
    const initial = await loadInitial();
    expect(postIds(initial)).toEqual(['newest', 'boundary']);
    actorId = 'actor-2';
    fetchStub.mockImplementationOnce(async () =>
      page([post('other-actor', 1)], null, false)
    );
    render();
    await flush();
    const afterSwitch = render();
    expect(postIds(afterSwitch)).toEqual(['other-actor']);
    expect(afterSwitch.hasMore).toBe(false);
  });

  it('keeps the first page and its cursor when the continuation fails', async () => {
    fetchStub.mockImplementationOnce(async () => page(firstPage, 'next', true));
    fetchStub.mockImplementationOnce(
      async () => new Response(null, { status: 503 })
    );
    const initial = await loadInitial();
    await initial.loadMore();
    const failed = render();
    expect(postIds(failed)).toEqual(['newest', 'boundary']);
    expect(failed.cursor).toBe('next');
    expect(failed.hasMore).toBe(true);
  });
});
