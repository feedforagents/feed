import type {
  PredictionResolutionSSE,
  PredictionTradeSSE,
} from '@/hooks/usePredictionMarketStream';
import type { PredictionMarket } from '@/types/markets';

export interface PredictionMarketTerminalState extends PredictionMarket {
  liquidity?: number;
  resolved?: boolean;
  resolution?: boolean | null;
  yesProbability?: number;
  noProbability?: number;
}

/**
 * The "Scenario N" label for a prediction market, or null when the market
 * has no recorded scenario — callers render nothing rather than a label
 * with an empty or undefined value.
 */
export function predictionScenarioLabel(
  market: Pick<PredictionMarket, 'scenario'> | null | undefined
): string | null {
  if (!market || market.scenario == null) return null;
  return `Scenario ${market.scenario}`;
}

export interface PredictionMarketLiveState {
  marketId: string;
  yesShares: number;
  noShares: number;
  liquidity?: number;
  yesProbability: number;
  noProbability: number;
  resolved?: boolean;
  resolution?: boolean | null;
}

export function buildPredictionTerminalState(
  base: PredictionMarket | null,
  live: PredictionMarketLiveState | null
): PredictionMarketTerminalState | null {
  if (!base) {
    return null;
  }

  const baseState: PredictionMarketTerminalState = base;

  if (!live || live.marketId !== base.id.toString()) {
    return baseState;
  }

  // A settled snapshot (resolved/cancelled) is terminal: a non-resolution
  // live update (e.g. a late trade event) must not reopen it.
  if (base.status !== 'active' && !live.resolved) {
    return baseState;
  }

  const merged: PredictionMarketTerminalState = {
    ...baseState,
    yesShares: live.yesShares,
    noShares: live.noShares,
    liquidity: live.liquidity ?? baseState.liquidity,
    yesProbability: live.yesProbability,
    noProbability: live.noProbability,
  };

  if (live.resolved) {
    merged.status = 'resolved';
    merged.resolved = true;
    merged.resolution = live.resolution ?? null;
    if (typeof live.resolution === 'boolean') {
      merged.resolvedOutcome = live.resolution;
    }
  }

  return merged;
}

export function buildPredictionLiveStateFromTrade(
  event: PredictionTradeSSE,
  previous?: PredictionMarketLiveState | null
): PredictionMarketLiveState {
  const sameMarket = previous?.marketId === event.marketId;
  // Resolution is terminal: a delayed trade event for an already-resolved
  // market must not drop the resolution.
  if (sameMarket && previous?.resolved) {
    return previous;
  }
  return {
    marketId: event.marketId,
    yesShares: event.yesShares,
    noShares: event.noShares,
    liquidity:
      event.liquidity ?? (sameMarket ? previous?.liquidity : undefined),
    yesProbability: event.yesPrice,
    noProbability: event.noPrice,
  };
}

export function buildPredictionLiveStateFromResolution(
  event: PredictionResolutionSSE,
  previous?: PredictionMarketLiveState | null
): PredictionMarketLiveState {
  return {
    marketId: event.marketId,
    yesShares: event.yesShares,
    noShares: event.noShares,
    liquidity:
      event.liquidity ??
      (previous?.marketId === event.marketId ? previous.liquidity : undefined),
    yesProbability: event.yesPrice,
    noProbability: event.noPrice,
    resolved: true,
    resolution: event.winningSide === 'yes',
  };
}

export function isSamePredictionLiveState(
  left: PredictionMarketLiveState | null,
  right: PredictionMarketLiveState | null
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.marketId === right.marketId &&
    left.yesShares === right.yesShares &&
    left.noShares === right.noShares &&
    left.liquidity === right.liquidity &&
    left.yesProbability === right.yesProbability &&
    left.noProbability === right.noProbability &&
    left.resolved === right.resolved &&
    left.resolution === right.resolution
  );
}
