import { BadRequestError, logger, NotFoundError } from '@feed/shared';
import { PredictionPricing } from './pricing';
import type {
  PredictionBuyInput,
  PredictionCancelInput,
  PredictionCancelResult,
  PredictionDbPort,
  PredictionMarketRecord,
  PredictionPositionRecord,
  PredictionPriceSnapshotRecord,
  PredictionResolveInput,
  PredictionSellInput,
  PredictionServiceDeps,
  PredictionSide,
  PredictionTradeResult,
} from './types';

const DEFAULT_LIQUIDITY = 10_000;
const MIN_SHARES = 0.01;
const MIN_TRADE_AMOUNT = 1;

/**
 * Maximum absolute odds shift (in probability units, 0–1) allowed in a single
 * buy trade. A value of 0.20 means one trade cannot move YES odds by more than
 * 20 percentage points (e.g. 50% → 70% is the maximum). Callers can override
 * per-trade via PredictionBuyInput.maxOddsMove for larger NPC/agent positions.
 */
const MAX_ODDS_MOVE_PER_TRADE = 0.2;

/**
 * Hard floor/ceiling for YES odds after any trade. Even with a relaxed
 * maxOddsMove, a trade that would push odds below 2% or above 98% is rejected
 * because such extreme values signal thin liquidity and make resolution payouts
 * almost meaningless for the minority side.
 */
const ODDS_HARD_FLOOR = 0.02;
const ODDS_HARD_CEILING = 0.98;

function grossUpBuyAmount(netAmount: number, feeRate: number): number {
  if (!Number.isFinite(netAmount)) return 0;
  if (!Number.isFinite(feeRate) || feeRate <= 0) return netAmount;
  const divisor = 1 - feeRate;
  if (divisor <= 0) return netAmount;
  return netAmount / divisor;
}

/**
 * Same-process queue so buy, sell, resolve, and cancel on one market cannot
 * interleave. Cross-process exclusion is PredictionDbPort.withMarketRowLock.
 * The stored promise never rejects, so one failure does not wedge the queue.
 */
const predictionMarketLocks = new Map<string, Promise<void>>();

function withInProcessMarketLock<T>(
  marketId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = predictionMarketLocks.get(marketId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate
  );
  predictionMarketLocks.set(marketId, tail);
  return previous
    .catch(() => undefined)
    .then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (predictionMarketLocks.get(marketId) === tail) {
          predictionMarketLocks.delete(marketId);
        }
      }
    });
}

interface PreparedPredictionTrade {
  result: PredictionTradeResult;
  snapshot: PredictionPriceSnapshotRecord;
  tradeEvent: Record<string, unknown>;
  creditDescription?: string;
  fee: {
    userId: string;
    amount: number;
    type: string;
    relatedId: string;
    positionId: string;
  } | null;
}

export class PredictionMarketService {
  private readonly db: PredictionDbPort;
  private readonly deps: PredictionServiceDeps;

  constructor(deps: PredictionServiceDeps) {
    this.deps = deps;
    this.db = deps.db;
  }

  async getMarket(marketId: string): Promise<PredictionMarketRecord | null> {
    return this.db.getMarketById(marketId);
  }

  /**
   * Ensure a market row exists for a given question/market id.
   *
   * This is useful for game/engine flows that create questions first and want
   * the corresponding market to exist immediately rather than lazily on first
   * trade.
   */
  async ensureMarketExists(input: {
    marketId: string;
    initialLiquidity?: number;
    initialYesProbability?: number;
    description?: string | null;
    gameId?: string | null;
    dayNumber?: number | null;
  }): Promise<PredictionMarketRecord> {
    const existing = await this.db.getMarketById(input.marketId);
    if (existing) return existing;

    const question = await this.db.getQuestion?.(input.marketId);
    if (!question) {
      throw new NotFoundError('Market', input.marketId);
    }
    return this.db.createMarketFromQuestion(
      question,
      input.initialLiquidity ?? DEFAULT_LIQUIDITY,
      {
        description: input.description,
        gameId: input.gameId,
        dayNumber: input.dayNumber,
        initialYesProbability: input.initialYesProbability,
      }
    );
  }

  /**
   * WHY optional pagination: Same reasoning as PerpMarketService — keeps
   * the service callable from any context. Omit options for the full list;
   * supply { limit, offset } for server-side pagination.
   */
  async listMarkets(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PredictionMarketRecord[]> {
    if (this.db.listMarkets) {
      return this.db.listMarkets(options);
    }
    throw new Error('listMarkets not implemented by db adapter');
  }

  /**
   * WHY fallback to listMarkets().length: Not all adapters implement
   * countUnresolvedMarkets (it's optional on PredictionDbPort). The fallback
   * loads all rows just to count — acceptable at current scale (<100 markets)
   * but should be replaced with a dedicated query before scaling.
   */
  async countUnresolvedMarkets(): Promise<number> {
    if (this.db.countUnresolvedMarkets) {
      return this.db.countUnresolvedMarkets();
    }
    return (await this.listMarkets()).length;
  }

  async listUserPositions(userId: string): Promise<PredictionPositionRecord[]> {
    if (this.db.listUserPositions) {
      return this.db.listUserPositions(userId);
    }
    throw new Error('listUserPositions not implemented by db adapter');
  }

  async buy(input: PredictionBuyInput): Promise<PredictionTradeResult> {
    const { marketId, amount } = input;
    if (!Number.isFinite(amount) || amount < MIN_TRADE_AMOUNT) {
      throw new BadRequestError(
        `Trade amount must be at least ${MIN_TRADE_AMOUNT}`
      );
    }
    // Checked again inside the lock. This read is what a hook running under
    // cancel observes without taking the lock cancel already holds.
    const preview = await this.ensureMarket(marketId);
    this.assertMarketActiveForBuy(preview);

    return withInProcessMarketLock(marketId, async () => {
      const prepared = await this.withLockedMarket(marketId, (db) =>
        this.prepareBuy(db, input)
      );
      return this.finishTrade(prepared);
    });
  }

  private async prepareBuy(
    db: PredictionDbPort,
    input: PredictionBuyInput
  ): Promise<PreparedPredictionTrade> {
    const { marketId, userId, amount, side } = input;
    const market = await db.getMarketById(marketId);
    if (!market) throw new NotFoundError('Market', marketId);
    this.assertMarketActiveForBuy(market);

    const tradeSource = this.deps.tradeSource ?? 'user_trade';
    const tradeActorType = this.deps.tradeActorType ?? 'user';

    // Calculate shares with fees (fee rate from deps)
    const calc = PredictionPricing.calculateBuyWithFees(
      market.yesShares,
      market.noShares,
      side,
      amount,
      this.deps.fees.tradingFeeRate
    );

    if (calc.netAmount <= 0) {
      throw new BadRequestError('Trade amount too low after fees');
    }

    // Price impact guard: prevent single trades from swinging odds too far.
    const currentTotal = market.yesShares + market.noShares;
    const currentYesOdds =
      currentTotal > 0 ? market.noShares / currentTotal : 0.5;
    const oddsShift = Math.abs(calc.newYesPrice - currentYesOdds);
    const maxAllowed = input.maxOddsMove ?? MAX_ODDS_MOVE_PER_TRADE;

    if (oddsShift > maxAllowed) {
      throw new BadRequestError(
        `Trade would move odds by ${(oddsShift * 100).toFixed(1)}ppt (max ${(maxAllowed * 100).toFixed(0)}ppt). Reduce trade size or split into smaller orders.`
      );
    }

    // Hard floor/ceiling: reject any trade that pushes odds to extreme values.
    if (
      calc.newYesPrice < ODDS_HARD_FLOOR ||
      calc.newYesPrice > ODDS_HARD_CEILING
    ) {
      throw new BadRequestError(
        `Trade would push YES odds to ${(calc.newYesPrice * 100).toFixed(1)}% — market is too thin for this trade size.`
      );
    }

    await this.deps.wallet.debit({
      userId,
      amount,
      reason: 'pred_buy',
      description: `Buy ${side.toUpperCase()} in ${market.question}`,
      relatedId: marketId,
    });

    const newLiquidity = market.liquidity + calc.netAmount;
    await db.updateMarketState(marketId, {
      yesShares: calc.newYesShares,
      noShares: calc.newNoShares,
      liquidity: newLiquidity,
    });

    const existingPos = await db.getPosition(userId, marketId, side);
    const position = await db.upsertPosition(
      existingPos
        ? {
            ...existingPos,
            shares: existingPos.shares + calc.sharesBought,
            avgPrice:
              (existingPos.avgPrice * existingPos.shares +
                calc.avgPrice * calc.sharesBought) /
              (existingPos.shares + calc.sharesBought),
            status: 'active',
            updatedAt: this.now(),
          }
        : {
            id: undefined,
            userId,
            marketId,
            side,
            shares: calc.sharesBought,
            avgPrice: calc.avgPrice,
            status: 'active',
            outcome: null,
            pnl: 0,
            resolvedAt: null,
            createdAt: this.now(),
            updatedAt: this.now(),
          }
    );

    return {
      result: {
        positionId: position.id,
        marketId,
        side,
        shares: calc.sharesBought,
        avgPrice: calc.avgPrice,
        totalCost: amount,
        feePaid: calc.fee,
        market: {
          yesPrice: calc.newYesPrice,
          noPrice: calc.newNoPrice,
          yesShares: calc.newYesShares,
          noShares: calc.newNoShares,
          priceImpact: calc.priceImpact,
          liquidity: newLiquidity,
        },
      },
      snapshot: {
        marketId,
        yesPrice: calc.newYesPrice,
        noPrice: calc.newNoPrice,
        yesShares: calc.newYesShares,
        noShares: calc.newNoShares,
        liquidity: newLiquidity,
        eventType: 'trade',
        source: tradeSource,
      },
      tradeEvent: {
        type: 'prediction_trade',
        marketId,
        yesPrice: calc.newYesPrice,
        noPrice: calc.newNoPrice,
        yesShares: calc.newYesShares,
        noShares: calc.newNoShares,
        liquidity: newLiquidity,
        trade: {
          actorType: tradeActorType,
          actorId: userId,
          action: 'buy',
          side,
          shares: calc.sharesBought,
          amount,
          price: calc.avgPrice,
          source: tradeSource,
          timestamp: this.now().toISOString(),
        },
      },
      fee: this.deps.feeProcessor
        ? {
            userId,
            amount,
            type: 'pred_buy',
            relatedId: marketId,
            positionId: position.id,
          }
        : null,
    };
  }

  async sell(input: PredictionSellInput): Promise<PredictionTradeResult> {
    const { marketId, userId, shares } = input;
    if (!Number.isFinite(shares) || shares < MIN_SHARES) {
      throw new BadRequestError(
        `Shares to sell must be at least ${MIN_SHARES}`
      );
    }
    const preview = await this.ensureMarket(marketId);
    this.assertMarketActiveForSell(preview);

    return withInProcessMarketLock(marketId, async () => {
      const prepared = await this.withLockedMarket(marketId, (db) =>
        this.prepareSell(db, input)
      );
      const netProceeds = prepared.result.netProceeds ?? 0;
      await this.deps.wallet.credit({
        userId,
        amount: netProceeds,
        reason: 'pred_sell',
        description: prepared.creditDescription,
        relatedId: marketId,
      });
      await this.deps.wallet.recordPnL({
        userId,
        pnl: prepared.result.pnl ?? 0,
        reason: 'pred_sell',
        relatedId: marketId,
      });
      return this.finishTrade(prepared);
    });
  }

  private async prepareSell(
    db: PredictionDbPort,
    input: PredictionSellInput
  ): Promise<PreparedPredictionTrade> {
    const { marketId, userId, shares } = input;
    const market = await db.getMarketById(marketId);
    if (!market) throw new NotFoundError('Market', marketId);
    this.assertMarketActiveForSell(market);

    const tradeSource = this.deps.tradeSource ?? 'user_trade';
    const tradeActorType = this.deps.tradeActorType ?? 'user';

    const yesPos = await db.getPosition(userId, marketId, 'yes');
    const noPos = await db.getPosition(userId, marketId, 'no');
    const positions = [yesPos, noPos]
      .filter((p): p is NonNullable<typeof p> => !!p)
      // Only allow selling active positions (whitelist approach for security)
      // This prevents selling cancelled/voided/resolved positions that have already been settled
      .filter(
        (p) => (!p.status || p.status === 'active') && p.shares >= MIN_SHARES
      );

    let pos: NonNullable<typeof yesPos> | NonNullable<typeof noPos> | null =
      null;
    if (input.positionId) {
      pos = positions.find((p) => p.id === input.positionId) ?? null;
    } else if (positions.length === 1) {
      pos = positions[0]!;
    } else if (positions.length > 1) {
      throw new BadRequestError(
        'Multiple positions exist on this market. Specify positionId.'
      );
    }

    if (!pos) {
      throw new NotFoundError('Position');
    }

    if (pos.shares < shares - 1e-9) {
      throw new BadRequestError('Insufficient shares');
    }

    const side: PredictionSide = pos.side;
    const calc = PredictionPricing.calculateSellWithFees(
      market.yesShares,
      market.noShares,
      side,
      shares,
      this.deps.fees.tradingFeeRate
    );

    const newLiquidity = market.liquidity - calc.totalCost;
    if (newLiquidity < 0) {
      throw new BadRequestError('Sale would exceed available liquidity');
    }
    await db.updateMarketState(marketId, {
      yesShares: calc.newYesShares,
      noShares: calc.newNoShares,
      liquidity: newLiquidity,
    });

    const remaining = pos.shares - shares;
    const positionClosed = remaining <= MIN_SHARES;
    if (positionClosed) {
      await db.upsertPosition({
        ...pos,
        shares: 0,
        status: 'closed',
        updatedAt: this.now(),
      });
    } else {
      await db.upsertPosition({
        ...pos,
        shares: remaining,
        updatedAt: this.now(),
      });
    }

    const costBasis = pos.avgPrice * shares;
    const netProceeds = calc.netProceeds ?? 0;
    // Position.avgPrice is based on the net buy amount (after fees), so costBasis excludes entry fees.
    // Gross-up the cost basis to include entry fees for accurate net PnL accounting.
    const costBasisWithFees = grossUpBuyAmount(
      costBasis,
      this.deps.fees.tradingFeeRate
    );
    const profitLoss = netProceeds - costBasisWithFees;

    return {
      creditDescription: `Sell ${side.toUpperCase()} in ${market.question}`,
      result: {
        positionId: pos.id,
        marketId,
        side,
        shares,
        avgPrice: calc.avgPrice,
        totalProceeds: calc.totalCost,
        netProceeds,
        feePaid: calc.fee,
        pnl: profitLoss,
        remainingShares: positionClosed ? 0 : remaining,
        positionClosed,
        market: {
          yesPrice: calc.newYesPrice,
          noPrice: calc.newNoPrice,
          yesShares: calc.newYesShares,
          noShares: calc.newNoShares,
          priceImpact: calc.priceImpact,
          liquidity: newLiquidity,
        },
      },
      snapshot: {
        marketId,
        yesPrice: calc.newYesPrice,
        noPrice: calc.newNoPrice,
        yesShares: calc.newYesShares,
        noShares: calc.newNoShares,
        liquidity: newLiquidity,
        eventType: 'trade',
        source: tradeSource,
      },
      tradeEvent: {
        type: 'prediction_trade',
        marketId,
        yesPrice: calc.newYesPrice,
        noPrice: calc.newNoPrice,
        yesShares: calc.newYesShares,
        noShares: calc.newNoShares,
        liquidity: newLiquidity,
        trade: {
          actorType: tradeActorType,
          actorId: userId,
          action: 'sell',
          side,
          shares,
          amount: netProceeds,
          price: calc.avgPrice,
          source: tradeSource,
          timestamp: this.now().toISOString(),
        },
      },
      fee: this.deps.feeProcessor
        ? {
            userId,
            amount: calc.totalCost,
            type: 'pred_sell',
            relatedId: marketId,
            positionId: pos.id,
          }
        : null,
    };
  }

  async resolve(input: PredictionResolveInput): Promise<void> {
    return withInProcessMarketLock(input.marketId, () =>
      this.resolveWhileLocked(input)
    );
  }

  private async resolveWhileLocked(
    input: PredictionResolveInput
  ): Promise<void> {
    const { marketId, winningSide, resolutionDescription, resolutionProofUrl } =
      input;
    const positions = await this.db.listPositionsForMarket(marketId);
    const market = await this.ensureMarket(marketId);
    if (market.resolved) return;

    const now = input.resolvedAt ?? this.now();

    // Pool-proportional payout: winners split losers' deposits
    const isWinnerSide = (p: { side: string }) =>
      (winningSide === 'yes' && p.side === 'yes') ||
      (winningSide === 'no' && p.side === 'no');

    const totalWinnerShares = positions
      .filter(isWinnerSide)
      .reduce((sum, p) => sum + p.shares, 0);
    const totalLoserDeposits = positions
      .filter((p) => !isWinnerSide(p))
      .reduce((sum, p) => sum + p.shares * p.avgPrice, 0);

    const totalPayout = positions
      .filter(isWinnerSide)
      .reduce(
        (acc, p) =>
          acc +
          PredictionPricing.calculateExpectedPayout(
            p.shares,
            p.avgPrice,
            totalWinnerShares,
            totalLoserDeposits
          ),
        0
      );

    const liquidityReduction = Math.min(totalPayout, market.liquidity);
    const newLiquidity = market.liquidity - liquidityReduction;

    await this.db.updateMarketState(marketId, {
      resolved: true,
      resolution: winningSide === 'yes',
      liquidity: newLiquidity,
      resolutionProofUrl: resolutionProofUrl ?? undefined,
      resolutionDescription: resolutionDescription ?? undefined,
    });

    for (const pos of positions) {
      const isWinner = isWinnerSide(pos);
      const payout = isWinner
        ? PredictionPricing.calculateExpectedPayout(
            pos.shares,
            pos.avgPrice,
            totalWinnerShares,
            totalLoserDeposits
          )
        : 0;
      const costBasisWithFees = grossUpBuyAmount(
        pos.avgPrice * pos.shares,
        this.deps.fees.tradingFeeRate
      );
      const pnl = payout - costBasisWithFees;

      if (payout > 0) {
        await this.deps.wallet.credit({
          userId: pos.userId,
          amount: payout,
          reason: 'pred_resolve',
          description: `Payout ${winningSide.toUpperCase()} for ${market.question}`,
          relatedId: marketId,
        });
      }
      if (pnl !== 0) {
        await this.deps.wallet.recordPnL({
          userId: pos.userId,
          pnl,
          reason: 'pred_resolve',
          relatedId: marketId,
        });
      }
      await this.db.upsertPosition({
        ...pos,
        status: 'resolved',
        outcome: isWinner,
        pnl,
        resolvedAt: now,
        updatedAt: now,
      });
    }

    await this.recordSnapshot({
      marketId,
      yesPrice: winningSide === 'yes' ? 1 : 0,
      noPrice: winningSide === 'no' ? 1 : 0,
      yesShares: market.yesShares,
      noShares: market.noShares,
      liquidity: newLiquidity,
      eventType: 'resolution',
      source: 'system',
    });

    await this.emitResolution({
      type: 'prediction_resolution',
      marketId,
      winningSide,
      yesShares: market.yesShares,
      noShares: market.noShares,
      liquidity: newLiquidity,
      totalPayout,
      timestamp: now.toISOString(),
      resolutionProofUrl,
      resolutionDescription,
    });

    await this.invalidateCaches(marketId);
  }

  /**
   * Cancel a market and refund all positions at cost basis.
   *
   * This is used when a market needs to be closed without a resolution
   * (e.g., voided by admin, cleanup of excess markets, invalid question).
   *
   * Unlike resolve(), this:
   * - Sets resolution to null (no winner/loser)
   * - Refunds each position at their original cost basis (shares * avgPrice).
   *   Fee gross-up of that basis is #1580 and is not applied here.
   * - Sets PnL to 0 for all positions (full refund)
   * - Marks positions as 'cancelled'
   *
   * The market is marked cancelled before any credit so buy and sell fail
   * closed for the rest of the loop. A credit failure on the first refund
   * clears that mark. A later failure leaves the mark so a retry can refund
   * positions that are still active.
   */
  async cancel(input: PredictionCancelInput): Promise<PredictionCancelResult> {
    return withInProcessMarketLock(input.marketId, () =>
      this.cancelWhileLocked(input)
    );
  }

  private async cancelWhileLocked(
    input: PredictionCancelInput
  ): Promise<PredictionCancelResult> {
    const { marketId, reason } = input;
    const now = input.cancelledAt ?? this.now();
    await this.ensureMarket(marketId);
    const gated = await this.withLockedMarket(marketId, async (db) => {
      const current = await db.getMarketById(marketId);
      if (!current) throw new NotFoundError('Market', marketId);
      if (current.resolved && typeof current.resolution === 'boolean') {
        throw new BadRequestError(
          'Market has already resolved with an outcome - cannot cancel'
        );
      }
      const alreadyCancelled =
        current.resolved && typeof current.resolution !== 'boolean';
      if (!alreadyCancelled) {
        await db.updateMarketState(marketId, {
          resolved: true,
          resolution: null,
          resolutionDescription: reason ?? 'Market cancelled',
        });
      }
      const positions = await db.listPositionsForMarket(marketId);
      return {
        market: current,
        positions,
        markedThisCall: !alreadyCancelled,
        previousDescription: current.resolutionDescription ?? null,
      };
    });

    let positionsRefunded = 0;
    let totalRefunded = 0;

    try {
      for (const pos of gated.positions) {
        if (pos.status && pos.status !== 'active') continue;

        const claimed = await this.claimCancelledPosition(pos, now);
        if (!claimed) continue;

        // Cost basis only. Do not gross up for fees; that arithmetic is #1580.
        const refundAmount = claimed.shares * claimed.avgPrice;
        if (!(refundAmount > 0)) continue;

        try {
          await this.deps.wallet.credit({
            userId: claimed.userId,
            amount: refundAmount,
            reason: 'pred_cancel',
            description: `Refund for cancelled market: ${gated.market.question}`,
            relatedId: marketId,
          });
        } catch (creditErr) {
          await this.restoreActivePosition(pos, claimed, creditErr);
          throw creditErr;
        }

        try {
          await this.deps.wallet.recordPnL({
            userId: claimed.userId,
            pnl: 0,
            reason: 'pred_cancel',
            relatedId: marketId,
          });
        } catch (pnlErr) {
          // The refund already committed. Restoring the position here would
          // let sell and a second cancel pay again.
          logger.error(
            'prediction cancel refund credited but recordPnL failed; leaving position cancelled',
            {
              userId: claimed.userId,
              marketId,
              positionId: claimed.id,
              refundAmount,
              error: pnlErr instanceof Error ? pnlErr.message : String(pnlErr),
            },
            'PredictionMarketService'
          );
        }

        totalRefunded += refundAmount;
        positionsRefunded++;
      }
    } catch (err) {
      if (gated.markedThisCall && positionsRefunded === 0) {
        try {
          await this.db.updateMarketState(marketId, {
            resolved: false,
            resolution: null,
            resolutionDescription: gated.previousDescription,
          });
        } catch (clearErr) {
          logger.error(
            'CRITICAL: Failed to reopen prediction market after cancel credit failure',
            {
              marketId,
              error:
                clearErr instanceof Error ? clearErr.message : String(clearErr),
            },
            'PredictionMarketService'
          );
        }
      }
      throw err;
    }

    if (gated.markedThisCall || positionsRefunded > 0) {
      await this.recordSnapshot({
        marketId,
        yesPrice: 0,
        noPrice: 0,
        yesShares: gated.market.yesShares,
        noShares: gated.market.noShares,
        liquidity: gated.market.liquidity,
        eventType: 'resolution',
        source: 'system',
      });
      await this.emitResolution({
        type: 'prediction_cancellation',
        marketId,
        reason: reason ?? 'Market cancelled',
        positionsRefunded,
        totalRefunded,
        timestamp: now.toISOString(),
      });
      await this.invalidateCaches(marketId);
    }

    return {
      marketId,
      positionsRefunded,
      totalRefunded,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  private async withLockedMarket<T>(
    marketId: string,
    fn: (db: PredictionDbPort) => Promise<T>
  ): Promise<T> {
    if (this.db.withMarketRowLock) {
      return this.db.withMarketRowLock(marketId, fn);
    }
    const market = await this.db.getMarketById(marketId);
    if (!market) throw new NotFoundError('Market', marketId);
    return fn(this.db);
  }

  private async finishTrade(
    prepared: PreparedPredictionTrade
  ): Promise<PredictionTradeResult> {
    await this.recordSnapshot(prepared.snapshot);
    await this.emitTrade(prepared.tradeEvent);
    await this.invalidateCaches(prepared.result.marketId);
    if (prepared.fee && this.deps.feeProcessor) {
      await this.deps.feeProcessor.processTradingFee(prepared.fee);
    }
    return prepared.result;
  }

  private async claimCancelledPosition(
    pos: PredictionPositionRecord,
    now: Date
  ): Promise<PredictionPositionRecord | null> {
    if (this.db.claimActivePosition) {
      return this.db.claimActivePosition(pos.id, {
        outcome: null,
        pnl: 0,
        resolvedAt: now,
        updatedAt: now,
      });
    }
    const current = await this.db.getPosition(
      pos.userId,
      pos.marketId,
      pos.side
    );
    if (!current || current.id !== pos.id) return null;
    if (current.status && current.status !== 'active') return null;
    return this.db.upsertPosition({
      ...current,
      status: 'cancelled',
      outcome: null,
      pnl: 0,
      resolvedAt: now,
      updatedAt: now,
    });
  }

  private async restoreActivePosition(
    pos: PredictionPositionRecord,
    claimed: PredictionPositionRecord,
    creditErr: unknown
  ): Promise<void> {
    try {
      await this.db.upsertPosition({
        ...pos,
        shares: claimed.shares,
        avgPrice: claimed.avgPrice,
        status: 'active',
        outcome: null,
        pnl: pos.pnl,
        resolvedAt: null,
        updatedAt: this.now(),
      });
    } catch (restoreErr) {
      logger.error(
        'CRITICAL: Failed to restore prediction position after cancel credit failure',
        {
          userId: pos.userId,
          marketId: pos.marketId,
          positionId: pos.id,
          creditError:
            creditErr instanceof Error ? creditErr.message : String(creditErr),
          restoreError:
            restoreErr instanceof Error
              ? restoreErr.message
              : String(restoreErr),
        },
        'PredictionMarketService'
      );
    }
  }

  private async ensureMarket(
    marketId: string
  ): Promise<PredictionMarketRecord> {
    const market = await this.db.getMarketById(marketId);
    if (market) return market;

    const question = await this.db.getQuestion?.(marketId);
    if (!question) {
      throw new NotFoundError('Market', marketId);
    }
    return this.db.createMarketFromQuestion(question, DEFAULT_LIQUIDITY);
  }

  /**
   * Assert market is open for new trades (buys).
   * Blocks if resolved, expired, or no liquidity.
   */
  private assertMarketActiveForBuy(market: PredictionMarketRecord) {
    if (market.resolved) {
      throw new BadRequestError('Market has resolved');
    }
    if (this.now() > market.endDate) {
      throw new BadRequestError('Market expired');
    }
    if (market.liquidity <= 0) {
      throw new BadRequestError('Market has no liquidity');
    }
  }

  /**
   * Assert market allows position exits (sells).
   * Users can sell on expired markets to close positions before resolution.
   * Blocks resolved markets (outcome settled) and cancelled markets (refunded).
   * Selling on a cancelled market enabled the cancel-refund + sell double-pay.
   */
  private assertMarketActiveForSell(market: PredictionMarketRecord) {
    if (market.resolved) {
      throw new BadRequestError(
        typeof market.resolution === 'boolean'
          ? 'Market has resolved with outcome - positions are auto-settled'
          : 'Market has been cancelled - positions are refunded'
      );
    }
    if (market.liquidity <= 0) {
      throw new BadRequestError('Market has no liquidity');
    }
  }

  private async recordSnapshot(snapshot: PredictionPriceSnapshotRecord) {
    if (!this.db.insertPriceSnapshot) return;
    await this.db.insertPriceSnapshot({
      ...snapshot,
      createdAt: snapshot.createdAt ?? this.now(),
    });
  }

  private async emitTrade(payload: Record<string, unknown>) {
    if (!this.deps.broadcast) return;
    await this.deps.broadcast.emit('markets', payload);
  }

  private async emitResolution(payload: Record<string, unknown>) {
    if (!this.deps.broadcast) return;
    await this.deps.broadcast.emit('markets', payload);
  }

  private async invalidateCaches(marketId: string) {
    if (!this.deps.cache) return;
    await this.deps.cache.invalidate(`prediction:${marketId}:*`);
  }

  private now() {
    return this.deps.clock?.now() ?? new Date();
  }
}
