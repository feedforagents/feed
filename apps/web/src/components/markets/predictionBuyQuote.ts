import {
  PredictionPricing,
  type ShareCalculationWithFees,
  sharesAtPositionScale,
} from '@feed/core/markets/prediction/client';
import { FEE_CONFIG } from '@feed/engine/config/fees';

/**
 * The buy quote shown to the user before they confirm a prediction trade.
 *
 * Use the execution fee and show the fill at the stored position precision.
 */
export function calculatePredictionBuyQuote(
  yesShares: number,
  noShares: number,
  side: 'yes' | 'no',
  amount: number
): ShareCalculationWithFees {
  const quote = PredictionPricing.calculateBuyWithFees(
    yesShares,
    noShares,
    side,
    amount,
    FEE_CONFIG.TRADING_FEE_RATE
  );
  return { ...quote, sharesBought: sharesAtPositionScale(quote.sharesBought) };
}
