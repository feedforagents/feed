import { type PortfolioBreakdownSnapshot, toNumber } from '@feed/engine/client';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { apiFetch } from '@/utils/api-fetch';

interface PortfolioBreakdownState {
  data: PortfolioBreakdownSnapshot | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  userId: string | null;
  fetchPromise: Promise<void> | null;
  /** Identity of the latest fetch; only it may commit results. */
  fetchSeq: number;
  pollingInterval: ReturnType<typeof setInterval> | null;
  /** User the active polling interval belongs to. */
  pollingUserId: string | null;
  /** Bumped whenever polling is (re)started; stale unsubscribes are ignored. */
  pollingGeneration: number;
  subscriberCount: number;
  fetchPortfolioBreakdown: (userId: string, force?: boolean) => Promise<void>;
  invalidate: () => void;
  reset: () => void;
  setUserId: (userId: string | null) => void;
  subscribe: (userId: string, intervalMs: number) => () => void;
}

const CACHE_TTL = 5000;

export async function fetchPortfolioBreakdownSnapshot(
  userId: string
): Promise<PortfolioBreakdownSnapshot> {
  let breakdownRes: Response;
  try {
    breakdownRes = await apiFetch(
      `/api/users/${encodeURIComponent(userId)}/portfolio-breakdown`
    );
  } catch {
    throw new Error('Failed to fetch portfolio breakdown');
  }

  if (!breakdownRes.ok) {
    throw new Error('Failed to fetch portfolio breakdown');
  }

  let breakdownJson: Record<string, unknown>;
  try {
    breakdownJson = (await breakdownRes.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Failed to parse portfolio breakdown');
  }

  return {
    wallet: toNumber(breakdownJson.wallet),
    positions: toNumber(breakdownJson.positions),
    available: toNumber(breakdownJson.available),
    netPeerTransfers: toNumber(breakdownJson.netPeerTransfers),
    originalAmount: toNumber(breakdownJson.originalAmount),
    totalAssets: toNumber(breakdownJson.totalAssets),
    totalPnL: toNumber(breakdownJson.totalPnL),
  };
}

export const usePortfolioBreakdownStore = create<PortfolioBreakdownState>(
  (set, get) => ({
    data: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    userId: null,
    fetchPromise: null,
    fetchSeq: 0,
    pollingInterval: null,
    pollingUserId: null,
    pollingGeneration: 0,
    subscriberCount: 0,

    fetchPortfolioBreakdown: async (userId: string, force = false) => {
      const state = get();

      if (state.fetchPromise && state.userId === userId) {
        return state.fetchPromise;
      }

      const currentState = get();

      if (
        !force &&
        currentState.userId === userId &&
        currentState.lastFetchedAt &&
        Date.now() - currentState.lastFetchedAt < CACHE_TTL &&
        currentState.data
      ) {
        return;
      }

      const requestedUserId = userId;
      const seq = currentState.fetchSeq + 1;
      const isCurrent = () =>
        get().fetchSeq === seq && get().userId === requestedUserId;

      const fetchPromise = (async () => {
        const isInitialLoad =
          currentState.lastFetchedAt === null ||
          currentState.userId !== requestedUserId;
        if (isInitialLoad) {
          set({ loading: true });
        }
        set({ error: null, userId: requestedUserId });

        try {
          const nextData =
            await fetchPortfolioBreakdownSnapshot(requestedUserId);
          if (!isCurrent()) return;
          set({
            data: nextData,
            lastFetchedAt: Date.now(),
            error: null,
          });
        } catch (error) {
          if (isCurrent()) {
            set({
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch portfolio breakdown',
            });
          }
        } finally {
          if (get().fetchSeq === seq) set({ fetchPromise: null });
          if (isCurrent()) set({ loading: false });
        }
      })();

      set({ fetchPromise, fetchSeq: seq });
      return fetchPromise;
    },

    setUserId: (userId: string | null) => {
      const state = get();
      if (state.userId !== userId) {
        // Keep polling ownership intact: subscribe() restarts polling for
        // the new user; here we only drop the previous user's data and any
        // in-flight request.
        set({
          data: null,
          error: null,
          loading: false,
          lastFetchedAt: null,
          userId,
          fetchPromise: null,
          fetchSeq: state.fetchSeq + 1,
        });
      }
    },

    invalidate: () => {
      set({ lastFetchedAt: null });
    },

    reset: () => {
      const state = get();
      if (state.pollingInterval) {
        clearInterval(state.pollingInterval);
      }
      set({
        data: null,
        loading: false,
        error: null,
        lastFetchedAt: null,
        userId: null,
        fetchPromise: null,
        fetchSeq: state.fetchSeq + 1,
        pollingInterval: null,
        pollingUserId: null,
        pollingGeneration: state.pollingGeneration + 1,
        subscriberCount: 0,
      });
    },

    // Polling belongs to exactly one user; subscribing for a different user
    // restarts it, and unsubscribes from an earlier generation are no-ops.
    subscribe: (userId: string, intervalMs: number) => {
      const state = get();

      let generation = state.pollingGeneration;
      if (state.pollingInterval === null || state.pollingUserId !== userId) {
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        generation = state.pollingGeneration + 1;
        const interval = setInterval(() => {
          const current = get();
          if (current.userId === userId) {
            void current.fetchPortfolioBreakdown(userId, true);
          }
        }, intervalMs);
        set({
          pollingInterval: interval,
          pollingUserId: userId,
          pollingGeneration: generation,
          subscriberCount: 1,
          userId,
        });
        void get().fetchPortfolioBreakdown(userId);
      } else {
        set({ subscriberCount: state.subscriberCount + 1 });
      }

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = get();
        if (current.pollingGeneration !== generation) return;
        const remaining = current.subscriberCount - 1;
        if (remaining > 0) {
          set({ subscriberCount: remaining });
          return;
        }
        if (current.pollingInterval) clearInterval(current.pollingInterval);
        set({
          subscriberCount: 0,
          pollingInterval: null,
          pollingUserId: null,
        });
      };
    },
  })
);

const portfolioBreakdownSelector = (state: PortfolioBreakdownState) => ({
  data: state.data,
  loading: state.loading,
  error: state.error,
  lastUpdated: state.lastFetchedAt,
});

export function usePortfolioBreakdown(userId?: string | null) {
  const data = usePortfolioBreakdownStore(
    useShallow(portfolioBreakdownSelector)
  );
  const fetchPortfolioBreakdown = usePortfolioBreakdownStore(
    (state) => state.fetchPortfolioBreakdown
  );
  const setUserId = usePortfolioBreakdownStore((state) => state.setUserId);

  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchPortfolioBreakdown(userId);
    }
  }, [userId, fetchPortfolioBreakdown, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchPortfolioBreakdown(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchPortfolioBreakdown]);

  return { ...data, refresh };
}

export function usePortfolioBreakdownPolling(
  userId?: string | null,
  intervalMs = 15000
) {
  const subscribe = usePortfolioBreakdownStore((state) => state.subscribe);
  const intervalRef = useRef(intervalMs);

  useEffect(() => {
    if (!userId) return;

    const unsubscribe = subscribe(userId, intervalRef.current);
    return unsubscribe;
  }, [userId, subscribe]);
}

export function invalidatePortfolioBreakdown() {
  usePortfolioBreakdownStore.getState().invalidate();
}

export async function refreshPortfolioBreakdown(userId: string) {
  return usePortfolioBreakdownStore
    .getState()
    .fetchPortfolioBreakdown(userId, true);
}
