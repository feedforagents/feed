import { PredictionPricing } from '@feed/core/markets/prediction/client';

/**
 * Displayed YES/NO percentages for a market's pool share counts.
 *
 * The story's yesShares/noShares are the AMM pool balances from the markets
 * table, not outcome totals: the CPMM price of YES is noShares / total
 * (PredictionPricing.getCurrentPrice — the same definition the market pages
 * and trading modal use). Using yesShares / total would show the complement
 * of the real price. An empty pool prices at 50/50.
 *
 * Kept in a component-free module on purpose: both feed cards share this one
 * definition, and unit tests import it without pulling the apps/web component
 * tree — whose providers need apps/web's global Window augmentation — into
 * the packages/testing typecheck program.
 */
export function computePercentages(
  yesShares: number,
  noShares: number
): { yesPercent: number; noPercent: number } {
  const yesPercent = Math.round(
    PredictionPricing.getCurrentPrice(yesShares, noShares, 'yes') * 100
  );
  return { yesPercent, noPercent: 100 - yesPercent };
}
