/**
 * Whether a closed prediction position won.
 *
 * Settlement records the result on the position row itself (`outcome`):
 * a resolved position won iff its side matched the resolution (PRD §9.2
 * [D-14] — a winning share redeems for exactly 1 pt). The row's stored pnl
 * cannot stand in for that result: partial sells accumulate their realized
 * pnl into the same row before settlement, so a position that won its
 * market can finish with negative total pnl, and a position that lost can
 * finish positive. Classifying by the pnl sign shows both backwards.
 *
 * Positions closed by a full sell were never resolved, so their outcome
 * is null; for those rows the pnl is the realized result itself and its
 * sign decides, exactly as before.
 *
 * A voided (cancelled) position is a third ended state, not a win or a
 * loss: admin cancel refunds it at cost basis (PnL 0) and records no
 * resolution, so no side matched anything and no share redeemed for 1 pt.
 * The old boolean rule (`outcome ?? pnl >= 0`) called every such row won
 * — a refunded row showed "Won +0.00" and counted under the Won filter.
 * `closedPredictionOutcome` returns 'void' for status 'cancelled' so the
 * tab can badge it Void instead; `closedPredictionWon` stays as the
 * boolean view (void is not won) for existing callers.
 */
export type ClosedPredictionOutcome = 'won' | 'lost' | 'void';

export function closedPredictionOutcome(position: {
  outcome: boolean | null;
  pnl: number;
  status?: string | null;
}): ClosedPredictionOutcome {
  if (position.status === 'cancelled') return 'void';
  return (position.outcome ?? position.pnl >= 0) ? 'won' : 'lost';
}

export function closedPredictionWon(position: {
  outcome: boolean | null;
  pnl: number;
  status?: string | null;
}): boolean {
  return closedPredictionOutcome(position) === 'won';
}
