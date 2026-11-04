/**
 * Buy-preview figures for a prediction trade: what the position pays if
 * the bought side wins, and the resulting profit.
 *
 * PRD §9.2 [D-14]: a winning share redeems for exactly 1 pt. The preview
 * must therefore value the shares received at 1 pt each. It must not use
 * `PredictionPricing.calculateExpectedPayout(shares, avgPrice)` with no
 * pool aggregates: that two-argument form returns the position's cost
 * basis (shares × avgPrice), so every preview showed the amount paid as
 * the "If <side> Wins" payout and a profit of exactly 0, whatever the
 * pool, the side, or the price.
 */
export interface PredictionWinPreview {
  expectedPayout: number;
  expectedProfit: number;
}

export function buildPredictionWinPreview(
  sharesBought: number,
  amountPaid: number
): PredictionWinPreview {
  const expectedPayout = sharesBought * 1;
  return {
    expectedPayout,
    expectedProfit: expectedPayout - amountPaid,
  };
}
