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
 */
export function closedPredictionWon(position: {
  outcome: boolean | null;
  pnl: number;
}): boolean {
  return position.outcome ?? position.pnl >= 0;
}
