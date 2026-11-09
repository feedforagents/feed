/**
 * Displayed PnL percent for an open prediction position.
 *
 * The canonical position snapshot values a position at the net proceeds
 * of selling it now and measures PnL against the fee-grossed cash cost
 * basis (shares * avgPrice / (1 - feeRate)) — the same cost basis the
 * sell settlement records in the ledger. Every surface that renders a
 * position's PnL percent (wallet positions tab, terminal positions
 * list, sell confirmations) derives it from the snapshot's
 * unrealizedPnL and costBasis, so preview surfaces must use the same
 * fields: recomputing a price-change percent from currentPrice and
 * avgPrice overstates every return by the buy fee and can show a
 * position that settles at a loss as a profit.
 */
export function predictionPositionPnLPercent(position: {
  unrealizedPnL: number;
  costBasis: number;
}): number {
  return position.costBasis !== 0
    ? (position.unrealizedPnL / position.costBasis) * 100
    : 0;
}
