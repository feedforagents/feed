'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { getBrowserDevAuthSession } from '@/lib/auth/dev-auth';
import type { TradeSide } from '@/types/markets';
import { type OpenPerpPreviewResponse, usePerpTrade } from './usePerpTrade';

interface UsePerpOpenPreviewParams {
  ticker: string | null;
  side: TradeSide;
  size: number;
  leverage: number;
  enabled?: boolean;
  getAccessToken?: () => Promise<string | null> | string | null;
}
interface PreviewState {
  preview: OpenPerpPreviewResponse['preview'] | null;
  loading: boolean;
  error: string | null;
}
export function usePerpOpenPreview({
  ticker,
  side,
  size,
  leverage,
  enabled = true,
  getAccessToken,
}: UsePerpOpenPreviewParams): PreviewState {
  const { previewOpenPosition } = usePerpTrade({ getAccessToken });
  const { session } = useStewardAuthContext();
  const owner =
    session?.userId ??
    session?.address ??
    getBrowserDevAuthSession()?.userId ??
    '';
  const normalizedTicker = useMemo(
    () => ticker?.trim().toUpperCase() ?? null,
    [ticker]
  );
  const key = JSON.stringify([
    owner,
    enabled,
    normalizedTicker,
    side,
    size,
    leverage,
  ]);
  const valid = Boolean(
    owner &&
      enabled &&
      normalizedTicker &&
      Number.isFinite(size) &&
      size > 0 &&
      Number.isFinite(leverage) &&
      leverage >= 1
  );
  const [state, setState] = useState<PreviewState & { key: string }>({
    key: '',
    preview: null,
    loading: false,
    error: null,
  });
  useEffect(() => {
    if (!valid || !normalizedTicker) {
      setState({ key, preview: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ key, preview: null, loading: true, error: null });
    const timer = window.setTimeout(() => {
      void previewOpenPosition(
        { ticker: normalizedTicker, side, size, leverage },
        controller.signal
      ).then(
        (result) => {
          if (!controller.signal.aborted)
            setState({
              key,
              preview: result.preview,
              loading: false,
              error: null,
            });
        },
        (error: Error) => {
          if (!controller.signal.aborted)
            setState({
              key,
              preview: null,
              loading: false,
              error: error.message,
            });
        }
      );
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [valid, normalizedTicker, key, side, size, leverage, previewOpenPosition]);
  // Hide an old owner/input quote during render, before the effect cleanup runs.
  return state.key === key
    ? state
    : { preview: null, loading: valid, error: null };
}
