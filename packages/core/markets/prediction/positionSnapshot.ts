import { PredictionPricing } from './pricing';

export interface PredictionPositionSnapshot {
  costBasis: number;
  currentProbability: number;
  currentUnitPrice: number;
  currentValue: number;
  unrealizedPnL: number;
}

export function calculatePredictionPositionSnapshot(params: {
  shares: number;
  avgPrice: number;
  cashCostBasis?: number | null;
  side: 'yes' | 'no';
  yesShares: number;
  noShares: number;
  feeRate: number;
  resolved?: boolean;
  resolution?: boolean | null;
  onSellPreviewError?: 'fallback' | 'throw';
}): PredictionPositionSnapshot {
  const {
    shares,
    avgPrice,
    cashCostBasis,
    side,
    yesShares,
    noShares,
    feeRate,
    resolved = false,
    resolution = null,
    onSellPreviewError = 'fallback',
  } = params;

  const costBasisNet = shares * avgPrice;
  // Prefer the persisted remaining gross cash cost (PRD §9.1: canonical
  // cent-rounded fees and historical fee rates cannot be reconstructed from
  // net avgPrice / (1 - feeRate)). Resolved/cancelled settlement zeroes
  // cashCostBasis while keeping shares on the row, so fall back to the
  // gross-up estimate whenever cashCostBasis is absent or zero with shares > 0.
  const hasPersistedCashCostBasis =
    cashCostBasis != null &&
    Number.isFinite(cashCostBasis) &&
    (cashCostBasis > 0 || shares <= 0);
  const costBasis = hasPersistedCashCostBasis
    ? cashCostBasis
    : feeRate > 0 && feeRate < 1
      ? costBasisNet / (1 - feeRate)
      : costBasisNet;

  const currentProbability =
    yesShares + noShares > 0
      ? PredictionPricing.getCurrentPrice(yesShares, noShares, side)
      : 0.5;

  if (resolved && resolution !== null) {
    const isWinningSide =
      (side === 'yes' && resolution) || (side === 'no' && !resolution);
    // Value a winner at the settled credit, not raw shares (PRD §9.1, §9.2).
    const currentValue = isWinningSide
      ? PredictionPricing.calculateExpectedPayout(shares, avgPrice)
      : 0;

    return {
      costBasis,
      currentProbability: isWinningSide ? 1 : 0,
      currentUnitPrice: isWinningSide && shares > 0 ? 1 : 0,
      currentValue,
      unrealizedPnL: currentValue - costBasis,
    };
  }

  if (shares <= 0 || yesShares <= 0 || noShares <= 0) {
    return {
      costBasis,
      currentProbability,
      currentUnitPrice: shares > 0 ? costBasis / shares : 0,
      currentValue: costBasis,
      unrealizedPnL: 0,
    };
  }

  let currentValue = costBasis;

  try {
    const sellPreview = PredictionPricing.calculateSellWithFees(
      yesShares,
      noShares,
      side,
      shares,
      feeRate
    );
    currentValue = sellPreview.netProceeds ?? sellPreview.totalCost;
  } catch (error) {
    if (onSellPreviewError === 'throw') {
      throw error;
    }
  }

  return {
    costBasis,
    currentProbability,
    currentUnitPrice: shares > 0 ? currentValue / shares : 0,
    currentValue,
    unrealizedPnL: currentValue - costBasis,
  };
}
