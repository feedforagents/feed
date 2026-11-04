'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PnlHistoryScope,
  PnlHistorySnapshot,
} from '@/lib/wallet/pnl-history-types';
import { useWalletBalanceStore } from '@/stores/walletBalanceStore';

interface PnlHistoryState extends PnlHistorySnapshot {
  requestKey: string | null;
  loading: boolean;
  error: Error | null;
}

interface UsePnlHistoryOptions {
  entityId?: string | null;
  scope?: PnlHistoryScope;
}

export function buildPnlHistoryUrl(params: {
  entityId?: string | null;
  scope: PnlHistoryScope;
  timeframe: string;
  userId: string;
}): string {
  const searchParams = new URLSearchParams({
    range: params.timeframe,
    scope: params.scope,
  });
  if (params.entityId) {
    searchParams.set('entityId', params.entityId);
  }
  return `/api/users/${encodeURIComponent(params.userId)}/pnl-history?${searchParams.toString()}`;
}

export function usePnlHistory(
  userId: string | undefined | null,
  timeframe: string,
  options: UsePnlHistoryOptions = {}
): Omit<PnlHistoryState, 'requestKey'> {
  const scope = options.scope ?? 'owner';
  const entityId = options.entityId ?? null;
  const requestKey = userId
    ? buildPnlHistoryUrl({ entityId, scope, timeframe, userId })
    : null;
  const [state, setState] = useState<PnlHistoryState>({
    requestKey: null,
    points: [],
    metrics: null,
    loading: Boolean(userId),
    error: null,
  });
  const controllerRef = useRef<AbortController | null>(null);

  const fetch_ = useCallback(async () => {
    if (!requestKey) {
      setState({
        requestKey: null,
        points: [],
        metrics: null,
        loading: false,
        error: null,
      });
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((prev) => ({
      ...prev,
      requestKey,
      points: prev.requestKey === requestKey ? prev.points : [],
      metrics: prev.requestKey === requestKey ? prev.metrics : null,
      loading: prev.requestKey !== requestKey || prev.metrics === null,
      error: null,
    }));

    try {
      const response = await fetch(requestKey, { signal: controller.signal });

      if (controller.signal.aborted) return;

      if (!response.ok) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: new Error('Failed to fetch P&L history'),
        }));
        return;
      }

      const data: PnlHistorySnapshot | { data: PnlHistorySnapshot } =
        await response.json();
      if (controller.signal.aborted) return;

      const snapshot = 'data' in data ? data.data : data;
      setState({
        requestKey,
        points: snapshot.points,
        metrics: snapshot.metrics,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error:
          err instanceof Error ? err : new Error('Failed to fetch P&L history'),
      }));
    }
  }, [requestKey]);

  useEffect(() => {
    void fetch_();
    if (!userId) return;

    const interval = setInterval(() => void fetch_(), 15_000);
    const unsubscribe = useWalletBalanceStore.subscribe((next, previous) => {
      if (
        next.userId === userId &&
        next.lastFetchedAt === null &&
        previous.lastFetchedAt !== null
      ) {
        void fetch_();
      }
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
      controllerRef.current?.abort();
    };
  }, [fetch_, userId]);

  return state.requestKey === requestKey
    ? state
    : {
        points: [],
        metrics: null,
        loading: Boolean(userId),
        error: null,
      };
}
