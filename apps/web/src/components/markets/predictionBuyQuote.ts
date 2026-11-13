import {
  PredictionPricing,
  type ShareCalculationWithFees,
} from '@feed/core/markets/prediction/client';
import { FEE_CONFIG } from '@feed/engine/config/fees';

/**
 * The buy quote shown to the user before they confirm a prediction trade.
 *
 * Execution (`PredictionMarketService.buy`, wired by the buy route) charges
 * the configured trading fee on the gross amount and swaps only the net
 * amount through the CPMM, so the shares a buyer is actually credited are
 * the fee-aware ones. The quote must be computed the same way — the
 * fee-free `PredictionPricing.calculateBuy` overstates the shares, the
 * average price, and the win payout on every trade. The markets terminal
 * already quotes with `calculateBuyWithFees` and the same fee rate; this
 * helper is that same computation for the trading modal.
 */
export function calculatePredictionBuyQuote(
  yesShares: number,
  noShares: number,
  side: 'yes' | 'no',
  amount: number
): ShareCalculationWithFees {
  return PredictionPricing.calculateBuyWithFees(
    yesShares,
    noShares,
    side,
    amount,
    FEE_CONFIG.TRADING_FEE_RATE
  );
}
