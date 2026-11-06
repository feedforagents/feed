/**
 * User Positions Store - Centralized state management for user trading positions
 *
 * This store prevents duplicate API calls and improves performance by:
 * 1. Caching positions data globally with TTL
 * 2. Only showing loading on initial fetch (not background refreshes)
 * 3. Deduplicating concurrent requests
 * 4. Single polling mechanism shared across components
 * 5. Supporting real-time updates via SSE
 *
 * Usage:
 * ```tsx
 * import { useUserPositions, useUserPositionsPolling, invalidateUserPositions } from '@/stores/userPositionsStore';
 *
 * function MyComponent() {
 *   const { perpPositions, predictionPositions, loading } = useUserPositions(userId);
 *   useUserPositionsPolling(userId); // Enable polling
 *   return <div>Positions: {perpPositions.length}</div>;
 * }
 * ```
 */

import type { PerpPosition, UserPredictionPosition } from '@feed/shared';
import { toNumber } from '@feed/shared';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

// Re-export types for convenience
export type { PerpPosition, UserPredictionPosition } from '@feed/shared';

import { apiFetch } from '@/utils/api-fetch';

interface PerpStats {
  totalPositions: number;
  totalPnL: number;
  totalFunding: number;
}

interface UserPositionsState {
  // Data
  perpPositions: PerpPosition[];
  predictionPositions: UserPredictionPosition[];
  perpStats: PerpStats;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  userId: string | null;

  // Internal state
  fetchPromise: Promise<void> | null;
  /** Identity of the latest fetch; only it may commit results. */
  fetchSeq: number;
  pollingInterval: ReturnType<typeof setInterval> | null;
  /** User the active polling interval belongs to. */
  pollingUserId: string | null;
  /** Bumped whenever polling is (re)started for a user; stale unsubscribes are ignored. */
  pollingGeneration: number;
  subscriberCount: number;

  // Actions
  fetchPositions: (userId: string, force?: boolean) => Promise<void>;
  setUserId: (userId: string | null) => void;
  invalidate: () => void;
  reset: () => void;
  subscribe: (userId: string, intervalMs: number) => () => void;
  updatePerpPosition: (
    positionId: string,
    updates: Partial<PerpPosition>
  ) => void;
  removePerpPosition: (positionId: string) => void;
}

// Cache TTL: 10 seconds (positions can change during trading)
const CACHE_TTL = 10000;

const DEFAULT_STATS: PerpStats = {
  totalPositions: 0,
  totalPnL: 0,
  totalFunding: 0,
};

type NumericLike = number | string | null | undefined;

interface ApiPerpPositionPayload {
  id: string;
  userId?: string;
  ticker: string;
  organizationId?: string;
  side: PerpPosition['side'];
  entryPrice: NumericLike;
  currentPrice: NumericLike;
  size: NumericLike;
  leverage: NumericLike;
  liquidationPrice?: NumericLike;
  unrealizedPnL?: NumericLike;
  unrealizedPnLPercent?: NumericLike;
  fundingPaid?: NumericLike;
  openedAt: string;
  lastUpdated?: string;
  closedAt?: string | null;
}

interface ApiPredictionPositionPayload {
  id: string;
  marketId: string;
  question: string;
  side: UserPredictionPosition['side'];
  shares: NumericLike;
  avgPrice: NumericLike;
  currentPrice: NumericLike;
  currentValue?: NumericLike;
  costBasis?: NumericLike;
  unrealizedPnL?: NumericLike;
  currentProbability?: NumericLike;
  resolved?: boolean;
  resolution?: boolean | null;
  status?: string;
  createdAt?: string;
}

/**
 * Normalize API perp position to PerpPosition type
 */
function normalizePerpPosition(raw: ApiPerpPositionPayload): PerpPosition {
  return {
    id: raw.id,
    userId: raw.userId ?? '',
    ticker: raw.ticker,
    organizationId: raw.organizationId ?? raw.ticker,
    side: raw.side,
    entryPrice: toNumber(raw.entryPrice),
    currentPrice: toNumber(raw.currentPrice),
    size: toNumber(raw.size),
    leverage: toNumber(raw.leverage, 1),
    liquidationPrice: toNumber(raw.liquidationPrice),
    unrealizedPnL: toNumber(raw.unrealizedPnL),
    unrealizedPnLPercent: toNumber(raw.unrealizedPnLPercent),
    fundingPaid: toNumber(raw.fundingPaid),
    openedAt: raw.openedAt,
    lastUpdated: raw.lastUpdated ?? raw.openedAt,
    closedAt: raw.closedAt ?? null,
  };
}

/**
 * Normalize API prediction position to UserPredictionPosition type
 */
function normalizePredictionPosition(
  raw: ApiPredictionPositionPayload
): UserPredictionPosition {
  const shares = toNumber(raw.shares);
  const avgPrice = toNumber(raw.avgPrice);
  const currentPrice = toNumber(raw.currentPrice);
  const costBasis = toNumber(raw.costBasis, shares * avgPrice);
  const currentValue = toNumber(raw.currentValue, shares * currentPrice);

  return {
    id: raw.id,
    marketId: raw.marketId,
    question: raw.question,
    side: raw.side,
    shares,
    avgPrice,
    currentPrice,
    currentValue,
    costBasis,
    unrealizedPnL: toNumber(raw.unrealizedPnL, currentValue - costBasis),
    currentProbability: toNumber(raw.currentProbability, currentPrice),
    resolved: raw.resolved ?? false,
    resolution: raw.resolution ?? null,
    status: raw.status,
    createdAt: raw.createdAt ?? undefined,
  };
}

export const useUserPositionsStore = create<UserPositionsState>((set, get) => ({
  perpPositions: [],
  predictionPositions: [],
  perpStats: { ...DEFAULT_STATS },
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

  fetchPositions: async (userId: string, force = false) => {
    const state = get();

    // Return existing promise only if fetching for the SAME user (deduplication)
    if (state.fetchPromise && state.userId === userId) {
      return state.fetchPromise;
    }

    // If fetching for a different user, wait for current fetch to complete first
    if (state.fetchPromise && state.userId !== userId) {
      await state.fetchPromise;
    }

    // Re-fetch fresh state after await to avoid stale cache checks
    const currentState = get();

    // Return cached data if fresh and not forced (an empty list is a valid,
    // cacheable result).
    if (
      !force &&
      currentState.userId === userId &&
      currentState.lastFetchedAt &&
      Date.now() - currentState.lastFetchedAt < CACHE_TTL
    ) {
      return;
    }

    const requestedUserId = userId;
    const seq = currentState.fetchSeq + 1;
    // Only the latest request for the current user may commit anything.
    const isCurrent = () =>
      get().fetchSeq === seq && get().userId === requestedUserId;

    const fetchPromise = (async () => {
      // Only show loading on initial fetch (no cached data yet)
      const isInitialLoad =
        currentState.lastFetchedAt === null ||
        currentState.userId !== requestedUserId;
      if (isInitialLoad) {
        set({ loading: true });
      }
      set({ error: null, userId: requestedUserId });

      try {
        const response = await apiFetch(
          `/api/markets/positions/${encodeURIComponent(requestedUserId)}`
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch positions: ${response.status}`);
        }

        const data = await response.json();

        if (!isCurrent()) return;

        const perpetuals = data?.perpetuals ?? {};
        const predictions = data?.predictions ?? {};

        const normalizedPerps = (perpetuals.positions ?? []).map(
          (p: ApiPerpPositionPayload) => normalizePerpPosition(p)
        );

        const normalizedPredictions = (predictions.positions ?? []).map(
          (p: ApiPredictionPositionPayload) => normalizePredictionPosition(p)
        );

        // Calculate stats
        const perpStats: PerpStats = {
          totalPositions: normalizedPerps.length,
          totalPnL: normalizedPerps.reduce(
            (sum: number, p: PerpPosition) => sum + (p.unrealizedPnL ?? 0),
            0
          ),
          totalFunding: normalizedPerps.reduce(
            (sum: number, p: PerpPosition) => sum + (p.fundingPaid ?? 0),
            0
          ),
        };

        set({
          perpPositions: normalizedPerps,
          predictionPositions: normalizedPredictions,
          perpStats,
          lastFetchedAt: Date.now(),
          error: null,
        });
      } catch (err) {
        if (isCurrent()) {
          const errorMessage =
            err instanceof Error ? err.message : 'Failed to fetch positions';
          set({ error: errorMessage });
        }
      } finally {
        // Never clear a newer request's loading flag or promise.
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
      // Clear cache and any in-flight fetch when user changes
      // This prevents cross-user data leakage from stale fetch responses
      set({
        userId,
        lastFetchedAt: null,
        perpPositions: [],
        predictionPositions: [],
        perpStats: { ...DEFAULT_STATS },
        fetchPromise: null,
        // Invalidate any in-flight request for the previous user.
        fetchSeq: state.fetchSeq + 1,
        loading: false,
        error: null,
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
      perpPositions: [],
      predictionPositions: [],
      perpStats: { ...DEFAULT_STATS },
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

  // Combined subscribe/unsubscribe that handles polling lifecycle.
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
          void current.fetchPositions(userId, true);
        }
      }, intervalMs);
      set({
        pollingInterval: interval,
        pollingUserId: userId,
        pollingGeneration: generation,
        subscriberCount: 1,
        userId,
      });
      void get().fetchPositions(userId);
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
      set({ subscriberCount: 0, pollingInterval: null, pollingUserId: null });
    };
  },

  // Optimistic update for a perp position (for real-time SSE updates)
  updatePerpPosition: (positionId: string, updates: Partial<PerpPosition>) => {
    const state = get();
    const updatedPositions = state.perpPositions.map((p) =>
      p.id === positionId ? { ...p, ...updates } : p
    );
    // Recalculate stats to keep them consistent with updated positions
    set({
      perpPositions: updatedPositions,
      perpStats: {
        totalPositions: updatedPositions.length,
        totalPnL: updatedPositions.reduce(
          (sum, p) => sum + (p.unrealizedPnL ?? 0),
          0
        ),
        totalFunding: updatedPositions.reduce(
          (sum, p) => sum + (p.fundingPaid ?? 0),
          0
        ),
      },
    });
  },

  // Remove a perp position (when closed)
  removePerpPosition: (positionId: string) => {
    const state = get();
    const updatedPositions = state.perpPositions.filter(
      (p) => p.id !== positionId
    );
    set({
      perpPositions: updatedPositions,
      perpStats: {
        ...state.perpStats,
        totalPositions: updatedPositions.length,
        totalPnL: updatedPositions.reduce(
          (sum, p) => sum + (p.unrealizedPnL ?? 0),
          0
        ),
        totalFunding: updatedPositions.reduce(
          (sum, p) => sum + (p.fundingPaid ?? 0),
          0
        ),
      },
    });
  },
}));

// Selectors
const positionsSelector = (state: UserPositionsState) => ({
  perpPositions: state.perpPositions,
  predictionPositions: state.predictionPositions,
  perpStats: state.perpStats,
  loading: state.loading,
  error: state.error,
});

const perpPositionsSelector = (state: UserPositionsState) => ({
  positions: state.perpPositions,
  stats: state.perpStats,
  loading: state.loading,
  error: state.error,
});

const predictionPositionsSelector = (state: UserPositionsState) => ({
  positions: state.predictionPositions,
  loading: state.loading,
  error: state.error,
});

/**
 * Hook for consuming all user positions.
 * Fetches on mount if userId provided.
 */
export function useUserPositions(userId?: string | null) {
  const data = useUserPositionsStore(useShallow(positionsSelector));
  const fetchPositions = useUserPositionsStore((state) => state.fetchPositions);
  const setUserId = useUserPositionsStore((state) => state.setUserId);

  // Fetch on mount if userId provided
  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchPositions(userId);
    }
  }, [userId, fetchPositions, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchPositions(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchPositions]);

  return { ...data, refresh };
}

/**
 * Hook for consuming only perp positions.
 * Lighter weight if you don't need prediction positions.
 */
export function usePerpPositions(userId?: string | null) {
  const data = useUserPositionsStore(useShallow(perpPositionsSelector));
  const fetchPositions = useUserPositionsStore((state) => state.fetchPositions);
  const setUserId = useUserPositionsStore((state) => state.setUserId);

  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchPositions(userId);
    }
  }, [userId, fetchPositions, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchPositions(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchPositions]);

  return { ...data, refresh };
}

/**
 * Hook for consuming only prediction positions.
 */
export function usePredictionPositions(userId?: string | null) {
  const data = useUserPositionsStore(useShallow(predictionPositionsSelector));
  const fetchPositions = useUserPositionsStore((state) => state.fetchPositions);
  const setUserId = useUserPositionsStore((state) => state.setUserId);

  useEffect(() => {
    if (userId) {
      setUserId(userId);
      fetchPositions(userId);
    }
  }, [userId, fetchPositions, setUserId]);

  const refresh = useCallback(() => {
    if (userId) {
      return fetchPositions(userId, true);
    }
    return Promise.resolve();
  }, [userId, fetchPositions]);

  return { ...data, refresh };
}

/**
 * Hook for enabling positions polling.
 * Uses reference counting so multiple components can request polling.
 *
 * @param userId - The user ID to poll positions for
 * @param intervalMs - Polling interval in milliseconds (default: 30000)
 */
export function useUserPositionsPolling(
  userId?: string | null,
  intervalMs = 30000
) {
  const subscribe = useUserPositionsStore((state) => state.subscribe);
  const intervalRef = useRef(intervalMs);

  useEffect(() => {
    if (!userId) return;

    const unsubscribe = subscribe(userId, intervalRef.current);
    return unsubscribe;
  }, [userId, subscribe]);
}

/**
 * Invalidate the positions cache.
 * Call after actions that affect positions (trading, etc.)
 */
export function invalidateUserPositions() {
  useUserPositionsStore.getState().invalidate();
}

/**
 * Force refresh positions.
 */
export async function refreshUserPositions(userId: string) {
  return useUserPositionsStore.getState().fetchPositions(userId, true);
}

/**
 * Get a specific perp position by ID from the store.
 * Returns undefined if not found.
 */
export function getPerpPositionById(
  positionId: string
): PerpPosition | undefined {
  return useUserPositionsStore
    .getState()
    .perpPositions.find((p) => p.id === positionId);
}
