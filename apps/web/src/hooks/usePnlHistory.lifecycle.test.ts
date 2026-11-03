import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { PnlHistorySnapshot } from '@/lib/wallet/pnl-history-types';

type State = PnlHistorySnapshot & {
  requestKey: string | null;
  loading: boolean;
  error: Error | null;
};
let state: State;
let effect: () => void | (() => void);
let cleanup: (() => void) | undefined;
let invalidateWallet: () => void;
let poll: () => void;
let pollInterval: number | undefined;
const controller = { current: null as AbortController | null };
const unsubscribe = mock();

// Exercise the hook's async effects deterministically without mounting a browser.
mock.module('react', () => ({
  useCallback: (callback: () => Promise<void>) => callback,
  useEffect: (callback: typeof effect) => {
    effect = callback;
  },
  useRef: () => controller,
  useState: (initial: State) => [
    state ?? initial,
    (update: State | ((previous: State) => State)) => {
      state = typeof update === 'function' ? update(state) : update;
    },
  ],
}));
mock.module('@/stores/walletBalanceStore', () => ({
  useWalletBalanceStore: {
    subscribe: (
      callback: (
        next: { userId: string; lastFetchedAt: number | null },
        previous: { userId: string; lastFetchedAt: number | null }
      ) => void
    ) => {
      invalidateWallet = () =>
        callback(
          { userId: 'owner-1', lastFetchedAt: null },
          { userId: 'owner-1', lastFetchedAt: 1 }
        );
      return unsubscribe;
    },
  },
}));
const { usePnlHistory } = await import('./usePnlHistory');
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const fetchMock =
  mock<(...args: Parameters<typeof fetch>) => Promise<Response>>();

const snapshot = (
  lifetimePnL: number,
  unrealizedPnL: number
): PnlHistorySnapshot => ({
  points: [{ time: 1, value: lifetimePnL + unrealizedPnL }],
  metrics: {
    userId: 'owner-1',
    lifetimePnL,
    unrealizedPnL,
    currentPnL: lifetimePnL + unrealizedPnL,
  },
});
const respond = (value: PnlHistorySnapshot) =>
  new Response(JSON.stringify({ data: value }));
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state = {
    requestKey: null,
    points: [],
    metrics: null,
    loading: true,
    error: null,
  };
  controller.current = null;
  unsubscribe.mockClear();
  fetchMock.mockReset();
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  Object.defineProperty(globalThis, 'setInterval', {
    configurable: true,
    writable: true,
    value: (callback: () => void, delay: number) => {
      pollInterval = delay;
      poll = callback;
      return originalSetInterval(() => {}, 100_000);
    },
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  globalThis.setInterval = originalSetInterval;
  globalThis.fetch = originalFetch;
});

describe('P&L snapshot refresh lifecycle', () => {
  it('refreshes all metrics and chart points on the 15s poll and trade invalidation', async () => {
    fetchMock.mockResolvedValueOnce(respond(snapshot(20, 100)));
    usePnlHistory('owner-1', '1D');
    cleanup = effect() || undefined;
    await flush();
    expect(state.metrics).toEqual(snapshot(20, 100).metrics);
    expect(pollInterval).toBe(15_000);

    fetchMock.mockResolvedValueOnce(respond(snapshot(120, 0)));
    invalidateWallet();
    await flush();
    expect(state.metrics).toEqual(snapshot(120, 0).metrics);
    expect(state.points.at(-1)?.value).toBe(120);

    fetchMock.mockResolvedValueOnce(respond(snapshot(120, -10)));
    poll();
    await flush();
    expect(state.metrics).toEqual(snapshot(120, -10).metrics);
    expect(state.points.at(-1)?.value).toBe(110);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ignores a stale response superseded by a trade refresh and aborts on unmount', async () => {
    let resolveOld: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        })
    );
    usePnlHistory('owner-1', '1D');
    cleanup = effect() || undefined;
    const oldSignal = controller.current?.signal;

    fetchMock.mockResolvedValueOnce(respond(snapshot(120, 0)));
    invalidateWallet();
    await flush();
    resolveOld(respond(snapshot(20, 100)));
    await flush();
    expect(oldSignal?.aborted).toBe(true);
    expect(state.metrics?.lifetimePnL).toBe(120);

    cleanup?.();
    cleanup = undefined;
    expect(controller.current?.signal.aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not expose another account snapshot before its effect runs', async () => {
    fetchMock.mockResolvedValueOnce(respond(snapshot(20, 100)));
    usePnlHistory('owner-1', '1D');
    cleanup = effect() || undefined;
    await flush();

    const switched = usePnlHistory('owner-2', '1D');
    expect(switched.metrics).toBeNull();
    expect(switched.points).toEqual([]);
    expect(switched.loading).toBe(true);
  });
});
