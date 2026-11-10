import { floorPoints } from '@feed/shared';

/**
 * Prediction Market AMM Pricing — Constant Product Market Maker (CPMM)
 *
 * Framework-free math utilities for Feed's YES/NO offchain markets.
 *
 * Pricing model: k = yesShares x noShares (constant product invariant)
 */

export interface ShareCalculation {
  sharesBought: number;
  avgPrice: number;
  newYesPrice: number;
  newNoPrice: number;
  priceImpact: number;
  totalCost: number;
  newYesShares: number;
  newNoShares: number;
}

export interface ShareCalculationWithFees extends ShareCalculation {
  fee: number;
  netAmount: number;
  totalWithFee?: number;
  netProceeds?: number;
  roundingRemainder?: number;
}

export class PredictionPricing {
  static getCurrentPrice(
    yesShares: number,
    noShares: number,
    side: 'yes' | 'no'
  ): number {
    const total = yesShares + noShares;
    if (total <= 0) return 0.5;
    return side === 'yes' ? noShares / total : yesShares / total;
  }

  /**
   * Calculate a winner's resolution payout.
   *
   * Each winning share redeems for 1 pt (PRD §9.2, D-14).
   * Legacy cost/pool arguments remain accepted for existing callers but
   * do not affect redemption.
   *
   * @param shares - Winner's shares held
   * @returns Settled payout to this winner under PRD §9.1
   */
  static calculateExpectedPayout(
    shares: number,
    _avgPrice: number,
    _totalWinnerShares: number = 0,
    _totalLoserDeposits: number = 0
  ): number {
    return floorPoints(shares);
  }

  /**
   * Initialize a market with configurable starting probability and liquidity.
   */
  static initializeMarket(initialLiquidity = 10_000, yesProbability = 0.5) {
    const clampedYesProbability = Math.max(
      0.05,
      Math.min(0.95, yesProbability)
    );
    const noShares = Math.max(1, initialLiquidity * clampedYesProbability);
    const yesShares = Math.max(1, initialLiquidity - noShares);
    return { yesShares, noShares };
  }

  static calculateBuy(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    usdAmount: number
  ): ShareCalculation {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0)
      throw new Error('Trade amount must be positive');
    const k = currentYesShares * currentNoShares;
    if (k <= 0) throw new Error('Market has insufficient liquidity');

    let newYesShares: number;
    let newNoShares: number;
    let sharesBought: number;

    // Cash-in CPMM (complete-set mint), per PRD §9.2 [D-14] ("CPMM price =
    // cost per share"): the amount paid mints that many complete sets
    // (1 YES + 1 NO per pt). The buyer keeps the bought side's shares from
    // the minted sets, and the opposite side's minted shares join the pool
    // and are swapped along the invariant for more of the bought side.
    // The pool state (and therefore the price path) is unchanged from the
    // plain swap calculation; the minted bought-side shares are what make
    // the marginal cost per share equal the quoted price instead of the
    // odds ratio.
    if (side === 'yes') {
      newNoShares = currentNoShares + usdAmount;
      newYesShares = k / newNoShares;
      sharesBought = currentYesShares - newYesShares + usdAmount;
    } else {
      newYesShares = currentYesShares + usdAmount;
      newNoShares = k / newYesShares;
      sharesBought = currentNoShares - newNoShares + usdAmount;
    }

    if (sharesBought <= 0)
      throw new Error('Calculated shares must be positive');

    const newTotal = newYesShares + newNoShares;
    const newYesPrice = newNoShares / newTotal;
    const newNoPrice = newYesShares / newTotal;
    const currentTotal = currentYesShares + currentNoShares;
    const currentYesPrice = currentNoShares / currentTotal;
    const currentNoPrice = currentYesShares / currentTotal;

    const priceImpact =
      side === 'yes'
        ? ((newYesPrice - currentYesPrice) / currentYesPrice) * 100
        : ((newNoPrice - currentNoPrice) / currentNoPrice) * 100;

    return {
      sharesBought,
      avgPrice: usdAmount / sharesBought,
      newYesPrice,
      newNoPrice,
      priceImpact,
      totalCost: usdAmount,
      newYesShares,
      newNoShares,
    };
  }

  static calculateSell(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    sharesToSell: number
  ): ShareCalculation {
    if (!Number.isFinite(sharesToSell) || sharesToSell <= 0)
      throw new Error('Shares to sell must be positive');
    const k = currentYesShares * currentNoShares;
    if (k <= 0) throw new Error('Market has insufficient liquidity');

    let newYesShares: number;
    let newNoShares: number;
    let proceeds: number;

    // Inverse of the cash-in buy (complete-set redemption): the pool
    // absorbs the sold shares and redeems `proceeds` complete sets for
    // cash, keeping the invariant. For a YES sell that is
    //   (yesShares + sharesToSell - proceeds) * (noShares - proceeds) = k,
    // solved below in the rationalized (numerically stable) root form.
    // The marginal proceeds per share equal the quoted price, so a buy
    // followed by a sell of the same shares returns the amount paid.
    if (side === 'yes') {
      const total = currentYesShares + sharesToSell + currentNoShares;
      const discriminant = total * total - 4 * sharesToSell * currentNoShares;
      proceeds =
        (2 * sharesToSell * currentNoShares) /
        (total + Math.sqrt(discriminant));
      newYesShares = currentYesShares + sharesToSell - proceeds;
      newNoShares = currentNoShares - proceeds;
    } else {
      const total = currentNoShares + sharesToSell + currentYesShares;
      const discriminant = total * total - 4 * sharesToSell * currentYesShares;
      proceeds =
        (2 * sharesToSell * currentYesShares) /
        (total + Math.sqrt(discriminant));
      newNoShares = currentNoShares + sharesToSell - proceeds;
      newYesShares = currentYesShares - proceeds;
    }

    if (!Number.isFinite(proceeds) || proceeds <= 0) {
      throw new Error('Calculated proceeds must be positive');
    }

    const newTotal = newYesShares + newNoShares;
    const newYesPrice = newNoShares / newTotal;
    const newNoPrice = newYesShares / newTotal;
    const currentTotal = currentYesShares + currentNoShares;
    const currentYesPrice = currentNoShares / currentTotal;
    const currentNoPrice = currentYesShares / currentTotal;

    const priceImpact =
      side === 'yes'
        ? ((newYesPrice - currentYesPrice) / currentYesPrice) * 100
        : ((newNoPrice - currentNoPrice) / currentNoPrice) * 100;

    return {
      sharesBought: sharesToSell,
      avgPrice: proceeds / sharesToSell,
      newYesPrice,
      newNoPrice,
      priceImpact,
      totalCost: proceeds,
      newYesShares,
      newNoShares,
    };
  }

  static calculateBuyWithFees(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    totalAmount: number,
    feeRate: number
  ): ShareCalculationWithFees {
    // Charge the canonical cent-rounded fee, exactly as FeeService
    // records and splits it (integer cents, one rounded fee): the raw
    // `totalAmount * feeRate` disagrees with the ledger on every trade
    // whose fee is not already a whole cent (e.g. $0.001 charged on a $1
    // buy is recorded as $0, $0.005 on a $5 buy as $0.01), so
    // users.totalFeesPaid, tradingFees and the stability-fund diversion
    // under/over-record the fee actually taken from the trader. This
    // mirrors PerpMarketService.calculateFee, which charges the same
    // canonical rounded fee for the same reason.
    const fee = Math.round(totalAmount * feeRate * 100) / 100;
    const netAmount = totalAmount - fee;
    const base = this.calculateBuy(
      currentYesShares,
      currentNoShares,
      side,
      netAmount
    );
    return {
      ...base,
      fee,
      netAmount,
      totalWithFee: totalAmount,
      totalCost: netAmount,
    };
  }

  static calculateSellWithFees(
    currentYesShares: number,
    currentNoShares: number,
    side: 'yes' | 'no',
    sharesToSell: number,
    feeRate: number
  ): ShareCalculationWithFees {
    const base = this.calculateSell(
      currentYesShares,
      currentNoShares,
      side,
      sharesToSell
    );
    const gross = base.totalCost;
    // Canonical cent-rounded fee, matching FeeService.calculateFee and
    // calculateBuyWithFees above: the ledger records the rounded fee, so
    // the sell must charge it too.
    const fee = Math.round(gross * feeRate * 100) / 100;
    const rawProceeds = gross - fee;
    const netProceeds = floorPoints(rawProceeds);
    const roundingRemainder = rawProceeds - netProceeds;
    return {
      ...base,
      fee,
      netAmount: netProceeds,
      netProceeds,
      roundingRemainder,
      totalCost: gross,
    };
  }
}

/**
 * Maximum safe single-trade gross amount (inclusive of fees) that keeps the
 * odds shift within `capPpt` probability points on EITHER side (YES or NO).
 *
 * Uses the closed-form CPMM solution:
 *   For a YES buy of net amount `a`:
 *     new_yes_price = (N+a)² / (k + (N+a)²)
 *   Solving for `a` given target yes_price:
 *     a = sqrt(target * k / (1 - target)) - N
 *
 * The binding constraint is the cheaper side (less room to move before
 * hitting the cap), so we return min(maxYesBuy, maxNoBuy) / (1 - feeRate).
 *
 * @param yesShares - current YES shares in pool
 * @param noShares  - current NO shares in pool
 * @param feeRate   - trading fee rate (default 0.01 = 1%)
 * @param capPpt    - max allowed odds shift in probability units (default 0.19 = 19ppt,
 *                    leaving a 1ppt safety margin below the 20ppt per-trade hard cap)
 * @returns max gross amount (floor) the caller should place in one trade
 */
export function maxSafeBuy(
  yesShares: number,
  noShares: number,
  feeRate = 0.01,
  capPpt = 0.19
): number {
  const k = yesShares * noShares;
  if (k <= 0 || !Number.isFinite(k)) return 0;

  const HARD_CEILING = 0.97;

  // Max YES buy net amount before shift > capPpt (or hard ceiling)
  const currentYes = noShares / (yesShares + noShares);
  const targetYes = Math.min(currentYes + capPpt, HARD_CEILING);
  const maxYesNet =
    targetYes < 1
      ? Math.max(0, Math.sqrt((targetYes * k) / (1 - targetYes)) - noShares)
      : Number.POSITIVE_INFINITY;

  // Max NO buy net amount before shift > capPpt (or hard ceiling)
  const currentNo = yesShares / (yesShares + noShares);
  const targetNo = Math.min(currentNo + capPpt, HARD_CEILING);
  const maxNoNet =
    targetNo < 1
      ? Math.max(0, Math.sqrt((targetNo * k) / (1 - targetNo)) - yesShares)
      : Number.POSITIVE_INFINITY;

  const maxNet = Math.min(maxYesNet, maxNoNet);
  if (!Number.isFinite(maxNet) || maxNet <= 0) return 0;

  // Convert net → gross and floor to nearest dollar
  const divisor = 1 - feeRate;
  return Math.floor(maxNet / (divisor > 0 ? divisor : 1));
}

export function calculateExpectedPayout(
  shares: number,
  avgPrice: number,
  totalWinnerShares: number = 0,
  totalLoserDeposits: number = 0
): number {
  return PredictionPricing.calculateExpectedPayout(
    shares,
    avgPrice,
    totalWinnerShares,
    totalLoserDeposits
  );
}
