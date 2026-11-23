import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

/** Profile replies follow the API page past the first 100, like posts. */
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

const getAccessToken = async () => 'local-fixture-token';
mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({ getAccessToken }),
}));

let actorId: string | null;
let enabled: boolean;

function reply(id: string, seconds: number) {
  return {
    id,
    content: `reply ${id}`,
    postId: 'post-1',
    createdAt: new Date(seconds * 1000).toISOString(),
    updatedAt: new Date(seconds * 1000).toISOString(),
    likeCount: 0,
    replyCount: 0,
    isLiked: false,
    post: {
      id: 'post-1',
      content: 'post',
      authorId: 'author-1',
      timestamp: new Date(seconds * 1000).toISOString(),
    },
  };
}
const firstPage = [reply('newest', 3), reply('boundary', 2)];
const nextPage = [reply('boundary', 2), reply('oldest', 1)];
const page = (items: ReturnType<typeof reply>[], total: number | undefined) =>
  Response.json({ data: { items, total } });
const fetchStub = mock(async (_url: string, _options?: RequestInit) =>
  page(firstPage, 3)
);
const origFetch = globalThis.fetch;
globalThis.fetch = fetchStub as unknown as typeof fetch;

beforeEach(() => {
  actorId = 'actor-1';
  enabled = true;
  harness = new HookHarness();
  fetchStub.mockReset();
  fetchStub.mockImplementation(async (url) =>
    url.includes('page=2') ? page(nextPage, 3) : page(firstPage, 3)
  );
});
afterAll(() => {
  globalThis.fetch = origFetch;
});

const flush = async () => {
  await Bun.sleep(0);
};
const { useActorReplies } = await import('./useActorReplies');
const render = () => harness.render(() => useActorReplies(actorId, enabled));
const loadInitial = async () => {
  render();
  await flush();
  return render();
};
const replyIds = (result: ReturnType<typeof useActorReplies>) =>
  result.replies.map(({ id }) => id);

describe('useActorReplies page pagination', () => {
  it('follows the API page past the first page, deduplicates overlap, and stops at the end', async () => {
    const initial = await loadInitial();
    expect(replyIds(initial)).toEqual(['newest', 'boundary']);
    expect(initial.total).toBe(3);
    expect(initial.hasMore).toBe(true);
    expect(fetchStub.mock.calls[0]?.[0]).toContain('type=replies');
    expect(fetchStub.mock.calls[0]?.[0]).toContain('page=1');
    const headers = fetchStub.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe('Bearer local-fixture-token');
    await initial.loadMore();
    const last = render();
    expect(fetchStub.mock.calls[1]?.[0]).toContain('page=2');
    expect(replyIds(last)).toEqual(['newest', 'boundary', 'oldest']);
    expect(last.hasMore).toBe(false);
    await last.loadMore();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not fetch while disabled and loads on enable', async () => {
    enabled = false;
    render();
    await flush();
    expect(fetchStub).toHaveBeenCalledTimes(0);
    expect(replyIds(render())).toEqual([]);
    enabled = true;
    const loaded = await loadInitial();
    expect(replyIds(loaded)).toEqual(['newest', 'boundary']);
  });

  it('resets when the actor changes', async () => {
    const initial = await loadInitial();
    expect(replyIds(initial)).toEqual(['newest', 'boundary']);
    actorId = 'actor-2';
    fetchStub.mockImplementationOnce(async () =>
      Response.json({ items: [reply('other-actor', 1)], total: 1 })
    );
    render();
    await flush();
    const afterSwitch = render();
    expect(replyIds(afterSwitch)).toEqual(['other-actor']);
    expect(afterSwitch.hasMore).toBe(false);
    expect(afterSwitch.total).toBe(1);
  });

  it('keeps the first page and its page when the continuation fails', async () => {
    fetchStub.mockImplementationOnce(async () => page(firstPage, 3));
    fetchStub.mockImplementationOnce(
      async () => new Response(null, { status: 503 })
    );
    const initial = await loadInitial();
    await initial.loadMore();
    const failed = render();
    expect(replyIds(failed)).toEqual(['newest', 'boundary']);
    expect(failed.hasMore).toBe(true);
    expect(failed.loadFailed).toBe(true);
  });

  it('does not retry a failed continuation until the failure is cleared', async () => {
    fetchStub.mockImplementationOnce(async () => page(firstPage, 3));
    fetchStub.mockImplementationOnce(
      async () => new Response(null, { status: 503 })
    );
    const initial = await loadInitial();
    await initial.loadMore();
    const failed = render();
    expect(failed.loadFailed).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await failed.loadMore();
    expect(fetchStub).toHaveBeenCalledTimes(2);
    failed.clearLoadFailed();
    const cleared = render();
    expect(cleared.loadFailed).toBe(false);
    await cleared.loadMore();
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('falls back to a full page when the server omits total', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      reply(`r${100 - i}`, 100 - i)
    );
    fetchStub.mockImplementationOnce(async () =>
      Response.json({ data: { items: fullPage } })
    );
    fetchStub.mockImplementationOnce(async () =>
      Response.json({ data: { items: [reply('last', 0)] } })
    );
    const initial = await loadInitial();
    expect(initial.total).toBeNull();
    expect(initial.hasMore).toBe(true);
    await initial.loadMore();
    const last = render();
    expect(replyIds(last)).toHaveLength(101);
    expect(last.hasMore).toBe(false);
  });

  it('clears loadingMore when the actor changes mid-continuation', async () => {
    const initial = await loadInitial();
    let resolveContinuation!: (value: Response) => void;
    fetchStub.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveContinuation = resolve;
        })
    );
    const pending = initial.loadMore();
    // Let the continuation fetch be issued (it awaits the access token
    // first) so it consumes the deferred response, not the next actor's.
    await flush();
    expect(render().loadingMore).toBe(true);
    actorId = 'actor-2';
    fetchStub.mockImplementationOnce(async () =>
      Response.json({ items: [reply('other-actor', 1)], total: 1 })
    );
    render();
    await flush();
    const afterSwitch = render();
    expect(afterSwitch.loadingMore).toBe(false);
    expect(replyIds(afterSwitch)).toEqual(['other-actor']);
    resolveContinuation(page(nextPage, 3));
    await pending;
    const settled = render();
    expect(settled.loadingMore).toBe(false);
    expect(replyIds(settled)).toEqual(['other-actor']);
  });
});
