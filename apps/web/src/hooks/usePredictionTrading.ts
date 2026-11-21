'use client';

import { useCallback, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

type PredictionTradeSide = 'YES' | 'NO';

type BuyPredictionInput = {
  marketId: string;
  side: PredictionTradeSide;
  amount: number;
};

type SellPredictionInput = {
  marketId: string;
  side: PredictionTradeSide;
  shares: number;
  positionId: string;
};

type BuyPredictionResult = {
  shares: number;
  avgPrice: number;
};

type SellPredictionResult = {
  pnl: number;
  remainingShares: number;
};

/**
 * Fresh idempotency key for one prediction trade submission.
 *
 * One key per submission: a resend of the same submission (timeout retry)
 * must reuse the key, while a new order must use a new one. The server
 * replays the first execution for a repeated key instead of trading twice.
 */
export function newPredictionTradeIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Headers for a prediction trade request. The Idempotency-Key is what lets
 * the server dedup a resend; without it the route executes the trade again,
 * so every web buy/sell must carry one.
 */
export function buildPredictionTradeHeaders(
  accessToken: string,
  idempotencyKey: string
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Idempotency-Key': idempotencyKey,
  };
}

function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'object' &&
    payload.error !== null &&
    'message' in payload.error &&
    typeof payload.error.message === 'string'
  ) {
    return payload.error.message;
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  return fallback;
}

async function parseJsonPayload<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export function usePredictionTrading() {
  const { getAccessToken } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One trade at a time per hook instance: a second call while one is
  // pending (double-click, impatient retry) must not start a second
  // trade with a fresh key. The modal already disables its buttons
  // while loading; this is the backstop for other callers.
  const inFlightRef = useRef(false);

  const requireAccessToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Authentication required. Please log in.');
    }

    return token;
  }, [getAccessToken]);

  const buyPrediction = useCallback(
    async (input: BuyPredictionInput): Promise<BuyPredictionResult> => {
      if (inFlightRef.current) {
        throw new Error('A prediction trade is already in progress.');
      }
      inFlightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const accessToken = await requireAccessToken();
        const idempotencyKey = newPredictionTradeIdempotencyKey();

        const response = await fetch(
          `/api/markets/predictions/${input.marketId}/buy`,
          {
            method: 'POST',
            headers: buildPredictionTradeHeaders(accessToken, idempotencyKey),
            body: JSON.stringify({
              side: input.side.toLowerCase(),
              amount: input.amount,
            }),
          }
        );
        const payload = await parseJsonPayload<{
          position: { shares: number; avgPrice: number };
        }>(response);

        if (!response.ok) {
          throw new Error(readApiErrorMessage(payload, 'Failed to buy shares'));
        }

        return {
          shares: payload.position.shares,
          avgPrice: payload.position.avgPrice,
        };
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : 'Prediction buy failed';
        setError(message);
        throw caughtError;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [requireAccessToken]
  );

  const sellPrediction = useCallback(
    async (input: SellPredictionInput): Promise<SellPredictionResult> => {
      if (inFlightRef.current) {
        throw new Error('A prediction trade is already in progress.');
      }
      inFlightRef.current = true;
      setLoading(true);
      setError(null);

      try {
        const accessToken = await requireAccessToken();
        const idempotencyKey = newPredictionTradeIdempotencyKey();

        const response = await fetch(
          `/api/markets/predictions/${input.marketId}/sell`,
          {
            method: 'POST',
            headers: buildPredictionTradeHeaders(accessToken, idempotencyKey),
            body: JSON.stringify({
              shares: input.shares,
              positionId: input.positionId,
            }),
          }
        );
        const payload = await parseJsonPayload<{
          pnl: number;
          remainingShares: number;
        }>(response);

        if (!response.ok) {
          throw new Error(
            readApiErrorMessage(payload, 'Failed to sell shares')
          );
        }

        return {
          pnl: payload.pnl,
          remainingShares: payload.remainingShares,
        };
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : 'Prediction sell failed';
        setError(message);
        throw caughtError;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [requireAccessToken]
  );

  return {
    buyPrediction,
    sellPrediction,
    loading,
    error,
  };
}
