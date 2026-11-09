import {
  ConflictError,
  calculateTradeImpact,
  getInitialReserves,
  logger,
  PERP_MARKET_CONFIG,
  ValidationError,
} from '@feed/shared';
import {
  evolveSyntheticPerpQuoteState,
  getSyntheticPerpExecutionPrice,
  getSyntheticPerpQuoteState,
} from './microstructure';
import { PerpQuoteStateService } from './PerpQuoteStateService';
import type {
  PerpCloseInput,
  PerpDbPort,
  PerpMarketRecord,
  PerpOpenExecutionPreview,
  PerpOpenInput,
  PerpPositionRecord,
  PerpServiceDeps,
  PerpSide,
  PerpTradeResult,
} from './types';
import {
  getOpenPerpPositionIntegrityIssue,
  isOpenPerpPositionStateValid,
  MAX_PERP_USER_EXPOSURE,
} from './utils';

/** Summary of price update operations */
export interface PriceUpdateSummary {
  marketsUpdated: number;
  positionsUpdated: number;
  liquidations: number;
  errors: Array<{ key: string; positionId?: string; error: string }>;
}

/** Add-to-position tx payload (includes post-commit helper fields). */
type AddToPositionTransactionResult = {
  positionId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  marginPaid: number;
  feePaid: number;
  isRebalance: true;
  rebalanceType: 'add';
  previousSize: number;
  previousEntryPrice: number;
  newOpenInterest: number;
  volume24h: number;
};

/** Flip-position tx payload (includes post-commit helper fields). */
type FlipPositionTransactionResult = {
  positionId: string;
  ticker: string;
  side: PerpSide;
  size: number;
  leverage: number;
  entryPrice: number;
  liquidationPrice: number;
  marginPaid: number;
  feePaid: number;
  exitPrice: number;
  realizedPnL: number;
  isRebalance: true;
  rebalanceType: 'flip';
  previousSize: number;
  previousEntryPrice: number;
  newOpenInterest: number;
  volume24h: number;
};

/** PRD §9.3 item 8 [D-17b]: max leverage is 20x. */
const DEFAULT_MAX_LEVERAGE = 20;

/**
 * Effective leverage cap for a market. The PRD cap is global, so a market
 * record stored above it (schema default / bootstrap seed from before the
 * cap existed) must not reopen the old 100x ceiling; a market configured
 * below the cap keeps its tighter limit.
 */
function effectiveMaxLeverage(market: { maxLeverage?: number | null }): number {
  return Math.min(
    market.maxLeverage ?? DEFAULT_MAX_LEVERAGE,
    DEFAULT_MAX_LEVERAGE
  );
}
const DEFAULT_MIN_ORDER_SIZE = 10;
const MIN_MAX_POSITION_SIZE = 10_000;
const OPEN_INTEREST_LIMIT_RATIO = 0.1;
const FUNDING_PERIOD_HOURS = 8;
const BASE_FUNDING_RATE = 0.01; // 1% APR base
const MAX_FUNDING_RATE = 0.5; // 50% APR cap
const IMBALANCE_EXPONENT = 3.0;

/** Maximum number of open positions per user */
const MAX_POSITIONS_PER_USER = 50;

const MIN_IMPACT_DELTA = 0.001;

/** Maximum retry attempts for fee processing (configurable via env var) */
const FEE_PROCESSING_MAX_RETRIES = parseInt(
  process.env.FEE_PROCESSING_MAX_RETRIES ?? '3',
  10
);
/** Base delay (ms) for exponential backoff */
const FEE_PROCESSING_BASE_DELAY_MS = 100;

/** Perpetual markets domain service (open/close flows, framework-agnostic). */
export class PerpMarketService {
  private readonly db: PerpDbPort;
  private readonly deps: PerpServiceDeps;

  constructor(deps: PerpServiceDeps) {
    this.deps = deps;
    this.db = deps.db;
  }

  private assertOpenPositionIntegrity(
    position: Pick<
      PerpPositionRecord,
      'id' | 'ticker' | 'userId' | 'size' | 'leverage'
    >
  ): void {
    const issue = getOpenPerpPositionIntegrityIssue(position);
    if (!issue) return;

    logger.error(
      'Invalid open perp position state detected',
      {
        positionId: position.id,
        userId: position.userId,
        ticker: position.ticker,
        size: position.size,
        leverage: position.leverage,
        issue,
      },
      'PerpService'
    );

    throw new Error(
      'Invalid persisted perp position state detected. Manual intervention required.'
    );
  }

  /**
   * Process trading fee with exponential backoff retries.
   * After exhaustion, persists to `tradingFeeOutbox` when configured; cron drains via
   * `FeeService.processTradingFee` and deletes the row in the same DB transaction.
   */
  private async processFeeWithRetry(
    params: {
      userId: string;
      amount: number;
      type: string;
      relatedId: string;
      positionId: string;
    },
    context: { ticker: string }
  ): Promise<void> {
    if (!this.deps.feeProcessor) return;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= FEE_PROCESSING_MAX_RETRIES; attempt++) {
      try {
        await this.deps.feeProcessor.processTradingFee(params);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < FEE_PROCESSING_MAX_RETRIES) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = FEE_PROCESSING_BASE_DELAY_MS * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      'CRITICAL: Fee processing failed after all retries — persisting to outbox for async retry',
      {
        positionId: params.positionId,
        userId: params.userId,
        ticker: context.ticker,
        type: params.type,
        amount: params.amount,
        retries: FEE_PROCESSING_MAX_RETRIES,
        error: lastError?.message,
        alertLevel: 'critical',
      },
      'PerpService'
    );

    // Emit metric for monitoring dashboards (Datadog, Grafana, etc.)
    // Note: This counter tracks inline fee processing failures for operator visibility
    this.deps.metrics?.increment('perp.fee_processing.inline_failure', 1, {
      ticker: context.ticker,
      type: params.type,
    });

    const outbox = this.deps.tradingFeeOutbox;
    if (outbox) {
      try {
        await outbox.enqueue({
          userId: params.userId,
          amount: params.amount,
          type: params.type,
          relatedId: params.relatedId,
          positionId: params.positionId,
          lastError: lastError?.message,
        });
      } catch (enqueueErr) {
        logger.error(
          'CRITICAL: Trading fee outbox enqueue failed — fee may require manual reconciliation',
          {
            positionId: params.positionId,
            userId: params.userId,
            type: params.type,
            amount: params.amount,
            outboxError:
              enqueueErr instanceof Error
                ? enqueueErr.message
                : String(enqueueErr),
          },
          'PerpService'
        );
      }
    }
  }

  /**
   * Apply post-trade price impact and adjust the position's entry price
   * to the constant-product AMM average fill price.
   *
   * Uses calculateTradeImpact() which computes:
   *   Buy:  baseOut = baseReserve * quoteIn / (quoteReserve + quoteIn)
   *         avgFill = quoteIn / baseOut  (worse than spot — slippage)
   *   Sell: quoteOut = quoteReserve * baseIn / (baseReserve + baseIn)
   *         avgFill = quoteOut / baseIn  (worse than spot — slippage)
   *
   * After computing the user's fill, we call `applyAndGetPrice` to
   * update the global market price to the AMM equilibrium.
   *
   * When `basis` is provided (adding to an existing position), the fill only
   * prices the incremental size and is size-weighted with the prior entry so
   * the historical cost basis is preserved.
   *
   * @returns Updated entry price and liquidation price, or undefined if no adjustment needed
   */
  private async applyPostTradeImpact(
    ticker: string,
    positionId: string,
    preImpactEntry: number,
    side: PerpSide,
    leverage: number,
    tradeSize: number,
    basis?: { previousSize: number; previousEntryPrice: number }
  ): Promise<
    | { entryPrice: number; liquidationPrice: number; fillPrice: number }
    | undefined
  > {
    if (!this.deps.priceImpact) return undefined;

    try {
      // Use the immutable base price so average-fill math matches the
      // constant-product price impact port on both open and close legs.
      const basePrice = await this.deps.priceImpact.getBasePrice?.(ticker);
      if (
        basePrice === undefined ||
        !Number.isFinite(basePrice) ||
        basePrice <= 0
      ) {
        throw new Error(
          'Configured price impact port returned missing or invalid required pricing context'
        );
      }

      const postImpactPrice =
        await this.deps.priceImpact.applyAndGetPrice(ticker);
      if (
        postImpactPrice === undefined ||
        !Number.isFinite(postImpactPrice) ||
        postImpactPrice <= 0
      ) {
        throw new Error(
          'Configured price impact port returned missing or invalid required pricing context'
        );
      }

      const signedTradeSize = side === 'long' ? tradeSize : -tradeSize;
      const netHoldingsAfter = deriveNetHoldingsFromSpotPrice(
        basePrice,
        postImpactPrice
      );
      if (netHoldingsAfter === undefined) {
        throw new Error(
          'Configured price impact port returned missing or invalid required pricing context'
        );
      }

      const netHoldingsBefore = netHoldingsAfter - signedTradeSize;
      const { avgFillPrice } = calculateTradeImpact(
        basePrice,
        netHoldingsBefore,
        signedTradeSize,
        PERP_MARKET_CONFIG
      );
      const newEntryPrice = basis
        ? (basis.previousSize * basis.previousEntryPrice +
            tradeSize * avgFillPrice) /
          (basis.previousSize + tradeSize)
        : avgFillPrice;
      const entryDelta = newEntryPrice - preImpactEntry;
      const marketDelta = postImpactPrice - preImpactEntry;

      const newLiquidationPrice = calculateLiquidationPrice(
        newEntryPrice,
        side,
        leverage
      );

      // Entry and current price are rewritten here, so the stored
      // unrealized PnL must be recomputed against the adjusted entry at
      // the post-impact price — otherwise the record keeps the PnL of the
      // pre-impact quote pair until the next price update overwrites it.
      const positionSize = basis ? basis.previousSize + tradeSize : tradeSize;
      const { pnl, pnlPercent } = calculateUnrealizedPnL(
        newEntryPrice,
        postImpactPrice,
        side,
        positionSize
      );

      await this.db.updateOpenPosition(positionId, {
        entryPrice: newEntryPrice,
        currentPrice: postImpactPrice ?? preImpactEntry,
        liquidationPrice: newLiquidationPrice,
        unrealizedPnL: pnl,
        unrealizedPnLPercent: pnlPercent,
      });

      logger.info(
        `Entry price adjusted to avg fill: ${preImpactEntry.toFixed(2)} → ${newEntryPrice.toFixed(2)} (delta: ${entryDelta.toFixed(4)}, market: ${(postImpactPrice ?? preImpactEntry).toFixed(2)})`,
        {
          positionId,
          ticker,
          side,
          preImpactPrice: preImpactEntry,
          avgFillPrice,
          entryPrice: newEntryPrice,
          deltaImpact: entryDelta,
          marketDelta,
          postMarketPrice: postImpactPrice,
          basePrice,
          netHoldingsBefore,
          netHoldingsAfter,
          liquidationPrice: newLiquidationPrice,
        },
        'PerpService'
      );

      return {
        entryPrice: newEntryPrice,
        liquidationPrice: newLiquidationPrice,
        fillPrice: avgFillPrice,
      };
    } catch (error) {
      logger.error(
        'Post-trade impact adjustment failed',
        {
          positionId,
          ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      throw error;
    }
  }

  /**
   * Compute the AMM average exit price for a close operation.
   * Uses constant-product slippage. Pure pricing step (no wallet or DB writes).
   */
  private async previewCloseImpact(params: {
    ticker: string;
    exitPrice: number;
    currentSpotPrice: number;
    side: PerpSide;
    closeSize: number;
  }): Promise<{ avgExitPrice: number; deltaImpact: number } | undefined> {
    const avgFillPrice = await this.previewImpactFill({
      ticker: params.ticker,
      currentSpotPrice: params.currentSpotPrice,
      signedTradeSize:
        params.side === 'long' ? -params.closeSize : params.closeSize,
    });
    if (avgFillPrice === undefined) return undefined;
    return {
      avgExitPrice: avgFillPrice,
      deltaImpact: avgFillPrice - params.exitPrice,
    };
  }

  /**
   * Preview the constant-product average fill for a signed trade (positive =
   * buy/long exposure, negative = sell/short exposure) from the current spot
   * price. Pure pricing step (no wallet or DB writes). Returns undefined when
   * no price impact port is configured.
   */
  private async previewImpactFill(params: {
    ticker: string;
    currentSpotPrice: number;
    signedTradeSize: number;
    precedingTradeSize?: number;
  }): Promise<number | undefined> {
    if (!this.deps.priceImpact) return undefined;

    try {
      const basePrice = await this.deps.priceImpact.getBasePrice?.(
        params.ticker
      );
      if (
        basePrice === undefined ||
        !Number.isFinite(basePrice) ||
        basePrice <= 0
      ) {
        throw new Error(
          'Configured price impact port returned missing or invalid required pricing context'
        );
      }

      const netHoldingsBefore = deriveNetHoldingsFromSpotPrice(
        basePrice,
        params.currentSpotPrice
      );
      if (netHoldingsBefore === undefined) {
        throw new Error(
          'Configured price impact port returned missing or invalid required pricing context'
        );
      }

      const { avgFillPrice } = calculateTradeImpact(
        basePrice,
        netHoldingsBefore + (params.precedingTradeSize ?? 0),
        params.signedTradeSize,
        PERP_MARKET_CONFIG
      );
      return avgFillPrice;
    } catch (error) {
      logger.error(
        'Failed to preview trade impact',
        {
          ticker: params.ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      throw error;
    }
  }

  /**
   * Apply post-close market impact update for mark-to-market consistency.
   */
  private async applyPostCloseMarketImpact(
    ticker: string
  ): Promise<number | undefined> {
    if (!this.deps.priceImpact) return undefined;

    try {
      const price = await this.deps.priceImpact.applyAndGetPrice(ticker);
      if (price === undefined || !Number.isFinite(price) || price <= 0)
        throw new Error(`Missing/invalid post-close price for ${ticker}`);
      return price;
    } catch (error) {
      logger.error(
        'Post-close market impact update failed',
        {
          ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      throw error;
    }
  }

  /**
   * Return current market snapshot (single source of truth).
   *
   * WHY optional pagination here (not only in the route): Keeps the service
   * usable from any caller (CLI, cron, tests) without coupling to HTTP query
   * params. When options are omitted the full snapshot is returned — callers
   * that want pagination supply { limit, offset } explicitly.
   */
  async getMarketsSnapshot(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PerpMarketRecord[]> {
    return this.db.listMarkets(options);
  }

  /** Row count for the full snapshot table (used for pagination metadata). */
  async countMarkets(): Promise<number> {
    return this.db.countMarkets();
  }

  /**
   * Preview the exact quote/execution engine used for opening a position.
   *
   * Convention:
   * - `currentPrice` is the canonical public market mid/spot
   * - quote state is derived around `currentPrice`
   * - execution price is side/size specific and may differ materially
   */
  async previewOpenPosition(
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): Promise<PerpOpenExecutionPreview> {
    if (input.size <= 0 || !Number.isFinite(input.size)) {
      throw new Error('Preview size must be positive');
    }
    if (input.leverage < 1 || !Number.isFinite(input.leverage)) {
      throw new Error('Preview leverage must be at least 1');
    }

    const market = await this.getRequiredMarket(input.ticker);
    const maxLeverage = effectiveMaxLeverage(market);
    if (input.leverage > maxLeverage) {
      throw new Error(`Invalid leverage (1-${maxLeverage})`);
    }
    return this.buildOpenExecutionPreview(market, input);
  }

  async previewOrder(
    input: Pick<
      PerpOpenInput,
      'userId' | 'ticker' | 'side' | 'size' | 'leverage'
    >
  ): Promise<PerpOpenExecutionPreview> {
    if (input.size <= 0 || !Number.isFinite(input.size)) {
      throw new Error('Preview size must be positive');
    }
    if (input.leverage < 1 || !Number.isFinite(input.leverage)) {
      throw new Error('Preview leverage must be at least 1');
    }

    const market = await this.getRequiredMarket(input.ticker);
    const maxLeverage = effectiveMaxLeverage(market);
    if (input.leverage > maxLeverage) {
      throw new Error(`Invalid leverage (1-${maxLeverage})`);
    }
    const existingPosition = await this.db.getOpenPositionByUserAndTicker(
      input.userId,
      input.ticker
    );

    if (!existingPosition) {
      return this.buildOpenExecutionPreview(market, input);
    }

    this.assertOpenPositionIntegrity(existingPosition);

    if (existingPosition.side === input.side) {
      return this.buildAddPreview(market, existingPosition, input);
    }

    return this.buildOppositeSidePreview(market, existingPosition, input);
  }

  /**
   * Open a perp position.
   *
   * @param input.maxSlippage - Maximum price deviation allowed from expected (0-1).
   */
  async openPosition(input: PerpOpenInput): Promise<PerpTradeResult> {
    const { ticker, side, size, leverage, maxSlippage } = input;
    if (
      !Number.isFinite(size) ||
      size <= 0 ||
      !Number.isFinite(leverage) ||
      leverage < 1
    )
      throw new Error(
        'Position size and leverage must be finite positive values'
      );
    if (side !== 'long' && side !== 'short')
      throw new Error('Invalid perp side');
    if (
      maxSlippage !== undefined &&
      (!Number.isFinite(maxSlippage) || maxSlippage < 0 || maxSlippage > 1)
    )
      throw new Error('maxSlippage must be finite and between 0 and 1');
    const markets = await this.db.listMarkets();
    const market = markets.find((m) => m.ticker === ticker);
    if (!market) {
      throw new Error(`Market not found: ${ticker}`);
    }

    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    const maxLeverage = effectiveMaxLeverage(market);

    if (size < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }
    if (leverage < 1 || leverage > maxLeverage) {
      throw new Error(`Invalid leverage (1-${maxLeverage})`);
    }

    const maxPositionSize = this.calculateMaxPositionSize(market.openInterest);
    if (size > maxPositionSize) {
      throw new Error(
        `Order size exceeds market limit (${maxPositionSize.toLocaleString()})`
      );
    }

    // Check for existing position on same ticker → rebalance instead of rejecting
    const existingPosition = await this.db.getOpenPositionByUserAndTicker(
      input.userId,
      ticker
    );
    if (existingPosition) {
      this.assertOpenPositionIntegrity(existingPosition);
      if (existingPosition.side === side) {
        // Same side → add to position (increase size, average entry price)
        const added = await this.addToPosition(existingPosition, input, market);
        await this.invalidateCaches(ticker);
        return added;
      } else {
        // Opposite side → reduce, close, or flip position
        const reduced = await this.reduceOrFlipPosition(
          existingPosition,
          input,
          market
        );
        await this.invalidateCaches(ticker);
        return reduced;
      }
    }

    const entryQuote = this.getOpenExecutionQuote(market, side, size);
    const entryPrice = entryQuote.executionPrice;

    // Reject non-finite or extreme prices to prevent NaN/Infinity PnL
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new Error(
        `Invalid market price for ${ticker}: ${entryPrice}. Cannot open position.`
      );
    }

    // Slippage protection against the fill the trade will actually execute
    // at (post-impact average fill), checked before any funds move.
    if (maxSlippage !== undefined && maxSlippage > 0) {
      this.assertWithinSlippage(
        await this.expectedOpenFill(market, side, size, entryPrice),
        market.markPrice,
        maxSlippage
      );
    }
    const liquidationPrice = calculateLiquidationPrice(
      entryPrice,
      side,
      leverage
    );
    const marginRequired = size / leverage;
    const fee = this.calculateFee(size);
    const totalCost = marginRequired + fee;

    const now = this.deps.clock?.now() ?? new Date();
    const { position, marketTotals, balance } = await this.deps.settlement.run(
      input.userId,
      async (tx, wallet) => {
        if (await tx.getOpenPositionByUserAndTicker(input.userId, ticker)) {
          throw new ConflictError(
            'Position changed concurrently; retry with fresh state'
          );
        }
        await this.assertUserExposure(
          tx,
          input.userId,
          size * leverage,
          undefined,
          true
        );
        await wallet.debit({
          userId: input.userId,
          amount: totalCost,
          reason: 'perp_open',
          description: `Open ${leverage}x ${side} ${ticker}`,
        });

        const position = await tx.upsertPosition({
          id: undefined,
          userId: input.userId,
          ticker,
          organizationId: market.organizationId,
          side,
          entryPrice,
          currentPrice: entryPrice,
          size,
          leverage,
          liquidationPrice,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          fundingPaid: 0,
          openedAt: now,
          lastUpdated: now,
        });

        // Open interest = sum of notional values (size), not leveraged exposure
        const marketTotals = await tx.applyMarketDeltas(ticker, {
          openInterest: size,
          volume24h: size,
        });

        await wallet.recordPnL({
          userId: input.userId,
          pnl: -fee,
          reason: 'perp_open',
          relatedId: position.id,
        });
        return {
          position,
          marketTotals,
          balance: (await wallet.getBalance(input.userId)).balance,
        };
      }
    );

    // Fee bookkeeping must not fail a committed open: the margin is debited
    // and the position row is open by now, so an awaited fee failure would
    // report the trade as failed and invite a retry that adds to the
    // position (doubling exposure). Route through the same retry + outbox
    // path the add/close/flip legs already use. Await completion or durable
    // enqueue before returning; serverless hosts need not retain detached work.
    await this.processFeeWithRetry(
      {
        userId: input.userId,
        amount: size,
        type: 'perp_open',
        relatedId: ticker,
        positionId: position.id,
      },
      { ticker }
    ).catch(() => {
      // Error already logged in processFeeWithRetry; catch to prevent unhandled rejection
    });

    const result: PerpTradeResult = {
      positionId: position.id,
      ticker,
      side,
      size,
      leverage,
      entryPrice,
      fillPrice: entryPrice,
      liquidationPrice,
      marginPaid: marginRequired,
      feePaid: fee,
      balance,
    };

    // Broadcast trade event for real-time UI updates
    await this.emitTradeEvent({
      type: 'perp_trade',
      action: 'open',
      ticker,
      side,
      size,
      leverage,
      entryPrice,
      positionId: position.id,
      openInterest: marketTotals.openInterest,
      volume24h: marketTotals.volume24h,
      timestamp: now.toISOString(),
    });

    // BF-75: Apply price impact and adjust entry price to prevent self-impact exploit.
    // The trade above is already committed, so an impact failure must not
    // turn it into a reported failure (which would invite a retry that adds
    // to the position a second time). The failure is already logged inside
    // applyPostTradeImpact; keep the pre-impact entry and report success.
    const impactAdj = await this.applyPostTradeImpact(
      ticker,
      position.id,
      entryPrice,
      side,
      leverage,
      size
    ).catch(() => undefined);
    if (impactAdj) {
      result.entryPrice = impactAdj.entryPrice;
      result.fillPrice = impactAdj.fillPrice;
      result.liquidationPrice = impactAdj.liquidationPrice;
    }

    await this.invalidateCaches(ticker);

    return result;
  }

  /**
   * Close a perp position (full or partial).
   *
   * @param input.percentage - Close a portion (0-1). Defaults to 1 (full close).
   * @param input.maxSlippage - Maximum price deviation from entry. Rejects if exceeded.
   */
  async closePosition(input: PerpCloseInput): Promise<PerpTradeResult> {
    const settlement = await this.db.transaction(async (tx) => {
      const position = await tx.lockOpenPositionById(input.positionId);
      if (!position) {
        throw new Error(
          `Position not found or already closed: ${input.positionId}`
        );
      }
      if (position.userId !== input.userId) {
        throw new Error('Not your position');
      }

      const markets = await tx.listMarkets();
      const market = markets.find((m) => m.ticker === position.ticker);
      if (!market) {
        throw new Error(
          `Market not found for position ticker ${position.ticker}`
        );
      }

      const closePercentage = resolveClosePercentage(input.percentage);

      const closeSize = position.size * closePercentage;
      const remainingSize = position.size - closeSize;
      const isFullClose = remainingSize < 0.01;
      const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
      if (!isFullClose && closeSize < minOrderSize) {
        throw new Error(
          `Partial close below minimum order size (${minOrderSize})`
        );
      }

      const requestedExitPrice =
        input.exitPriceOverride ??
        this.getCloseExecutionQuote(market, position.side, closeSize)
          .executionPrice;

      if (!Number.isFinite(requestedExitPrice) || requestedExitPrice <= 0) {
        throw new Error(
          `Invalid exit price for ${position.ticker}: ${requestedExitPrice}. Cannot close position.`
        );
      }

      const closeImpact = await this.previewCloseImpact({
        ticker: position.ticker,
        exitPrice: requestedExitPrice,
        currentSpotPrice: market.currentPrice,
        side: position.side,
        closeSize,
      });
      const exitPrice = closeImpact?.avgExitPrice ?? requestedExitPrice;

      // Enforce tolerance against the actual (post-impact) exit fill.
      this.assertWithinSlippage(
        exitPrice,
        market.markPrice ?? market.currentPrice,
        input.maxSlippage
      );

      const { pnl } = calculateUnrealizedPnL(
        position.entryPrice,
        exitPrice,
        position.side,
        closeSize
      );
      const proportionalFunding = position.fundingPaid * closePercentage;
      const realizedPnL = pnl - proportionalFunding;
      const marginPaid = closeSize / position.leverage;
      // A close cannot lose more than the leg's margin: the settlement
      // below is already floored at 0, but the uncapped realizedPnL above
      // was stored/returned while recordPnL booked only -marginPaid, so
      // the two records of the same close disagreed past the margin.
      // Cap here, matching the liquidation cap (Math.max(..., -marginLoss)).
      const cappedRealizedPnL = Math.max(realizedPnL, -marginPaid);
      const grossSettlement = marginPaid + cappedRealizedPnL;
      const fee = this.calculateFee(closeSize);
      const netSettlement = Math.max(0, grossSettlement - fee);
      const now = this.deps.clock?.now() ?? new Date();

      if (isFullClose) {
        await tx.closePosition(position.id, {
          currentPrice: exitPrice,
          closedAt: now,
          realizedPnL: (position.realizedPnL ?? 0) + cappedRealizedPnL,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
        });
      } else {
        const remainingFunding = position.fundingPaid - proportionalFunding;
        const { pnl: remainingPnl, pnlPercent: remainingPnlPercent } =
          calculateUnrealizedPnL(
            position.entryPrice,
            exitPrice,
            position.side,
            remainingSize
          );
        await tx.updateOpenPosition(position.id, {
          size: remainingSize,
          fundingPaid: remainingFunding,
          currentPrice: exitPrice,
          // Keep the row's realized PnL in step with what has been settled,
          // so the final close and the position views report lifetime PnL.
          realizedPnL: (position.realizedPnL ?? 0) + cappedRealizedPnL,
          unrealizedPnL: remainingPnl,
          unrealizedPnLPercent: remainingPnlPercent,
          lastUpdated: now,
        });
      }

      const marketTotals = await tx.applyMarketDeltas(position.ticker, {
        openInterest: -closeSize,
        volume24h: closeSize,
      });

      return {
        closeImpact,
        closePercentage,
        closeSize,
        exitPrice,
        fee,
        isFullClose,
        marginPaid,
        marketTotals,
        netSettlement,
        now,
        position,
        requestedExitPrice,
        realizedPnL: cappedRealizedPnL,
        remainingSize,
      };
    });

    if (settlement.netSettlement > 0) {
      await this.deps.wallet.credit({
        userId: input.userId,
        amount: settlement.netSettlement,
        reason: settlement.isFullClose ? 'perp_close' : 'perp_partial_close',
        description: `${settlement.isFullClose ? 'Close' : `Partial close ${(settlement.closePercentage * 100).toFixed(0)}%`} ${settlement.position.leverage}x ${settlement.position.side} ${settlement.position.ticker}`,
        relatedId: settlement.position.id,
      });
    }

    await this.deps.wallet.recordPnL({
      userId: input.userId,
      pnl: settlement.netSettlement - settlement.marginPaid,
      reason: settlement.isFullClose ? 'perp_close' : 'perp_partial_close',
      relatedId: settlement.position.id,
    });

    const balanceResult = await this.deps.wallet.getBalance(input.userId);

    // Fee bookkeeping: retries + optional outbox (see processFeeWithRetry).
    void this.processFeeWithRetry(
      {
        userId: input.userId,
        amount: settlement.closeSize,
        type: 'perp_close',
        relatedId: settlement.position.ticker,
        positionId: settlement.position.id,
      },
      { ticker: settlement.position.ticker }
    ).catch(() => {
      // Error already logged in processFeeWithRetry; catch to prevent unhandled rejection
    });

    // Apply market-level post-close impact after settlement to keep the close
    // path fail-safe (position is already settled if this step fails).
    // The failure is already logged inside applyPostCloseMarketImpact, so
    // fall back to no re-mark instead of reporting a settled close as failed.
    const postCloseMarketPrice = settlement.closeImpact
      ? await this.applyPostCloseMarketImpact(settlement.position.ticker).catch(
          () => undefined
        )
      : undefined;

    // For partial closes, re-mark remaining position to the post-impact price.
    if (
      !settlement.isFullClose &&
      postCloseMarketPrice !== undefined &&
      Number.isFinite(postCloseMarketPrice) &&
      Math.abs(postCloseMarketPrice - settlement.exitPrice) > MIN_IMPACT_DELTA
    ) {
      const { pnl: markedPnl, pnlPercent: markedPnlPercent } =
        calculateUnrealizedPnL(
          settlement.position.entryPrice,
          postCloseMarketPrice,
          settlement.position.side,
          settlement.remainingSize
        );

      await this.db.updateOpenPosition(settlement.position.id, {
        currentPrice: postCloseMarketPrice,
        unrealizedPnL: markedPnl,
        unrealizedPnLPercent: markedPnlPercent,
        lastUpdated: settlement.now,
      });
    }

    const result: PerpTradeResult = {
      positionId: settlement.position.id,
      ticker: settlement.position.ticker,
      side: settlement.position.side,
      size: settlement.closeSize,
      leverage: settlement.position.leverage,
      entryPrice: settlement.position.entryPrice,
      exitPrice: settlement.exitPrice,
      fillPrice: settlement.exitPrice,
      liquidationPrice: settlement.position.liquidationPrice,
      realizedPnL: settlement.realizedPnL,
      feePaid: settlement.fee,
      marginPaid: settlement.marginPaid,
      balance: balanceResult.balance,
      remainingSize: settlement.isFullClose ? 0 : settlement.remainingSize,
      fullyClosed: settlement.isFullClose,
    };

    // Broadcast trade event for real-time UI updates.
    // emitTradeEvent already handles errors internally, so fire-and-forget
    // to avoid blocking the response.
    this.emitTradeEvent({
      type: 'perp_trade',
      action: settlement.isFullClose ? 'close' : 'partial_close',
      ticker: settlement.position.ticker,
      side: settlement.position.side,
      size: settlement.closeSize,
      leverage: settlement.position.leverage,
      entryPrice: settlement.position.entryPrice,
      exitPrice: settlement.exitPrice,
      positionId: settlement.position.id,
      realizedPnL: settlement.realizedPnL,
      openInterest: settlement.marketTotals.openInterest,
      volume24h: settlement.marketTotals.volume24h,
      timestamp: (this.deps.clock?.now() ?? new Date()).toISOString(),
    }).catch(() => {
      // Error already logged in emitTradeEvent; catch to prevent unhandled rejection
    });

    await this.invalidateCaches(settlement.position.ticker);

    if (settlement.closeImpact) {
      logger.info(
        `Exit price adjusted to avg fill: ${settlement.requestedExitPrice.toFixed(2)} → ${settlement.exitPrice.toFixed(2)} (delta: ${settlement.closeImpact.deltaImpact.toFixed(4)})`,
        {
          positionId: settlement.position.id,
          ticker: settlement.position.ticker,
          side: settlement.position.side,
          requestedExitPrice: settlement.requestedExitPrice,
          avgExitPrice: settlement.exitPrice,
          deltaImpact: settlement.closeImpact.deltaImpact,
          postCloseMarketPrice,
        },
        'PerpService'
      );
    }

    return result;
  }
  /**
   * Update open positions with new prices, apply liquidations, and update market stats.
   *
   * @returns Summary of updates applied, including any errors encountered.
   */
  async applyPriceUpdates(
    priceUpdates:
      | Map<string, number>
      | Record<string, number>
      | Array<[string, number]>
  ): Promise<PriceUpdateSummary> {
    const summary: PriceUpdateSummary = {
      marketsUpdated: 0,
      positionsUpdated: 0,
      liquidations: 0,
      errors: [],
    };

    const priceMap = normalizePriceMap(priceUpdates);
    if (priceMap.size === 0) return summary;

    // Filter out invalid prices (must be positive finite numbers)
    for (const [key, price] of priceMap.entries()) {
      if (!Number.isFinite(price) || price <= 0) {
        priceMap.delete(key);
        summary.errors.push({
          key,
          error: 'Invalid price (must be positive finite number)',
        });
      }
    }
    if (priceMap.size === 0) return summary;

    const markets = await this.db.listMarkets();
    const marketByOrg = new Map(markets.map((m) => [m.organizationId, m]));
    const marketByTicker = new Map(markets.map((m) => [m.ticker, m]));

    const positions = await this.db.listOpenPositions();

    for (const position of positions) {
      const newPrice =
        priceMap.get(position.organizationId) ??
        priceMap.get(position.ticker) ??
        null;
      if (newPrice === null || newPrice === undefined) continue;

      const market =
        marketByOrg.get(position.organizationId) ??
        marketByTicker.get(position.ticker);

      const now = this.deps.clock?.now() ?? new Date();

      // A user close can change the snapshot before the liquidation write.
      // Reread under the row lock before settling its remaining margin.
      let live = position;

      // PRD §9.3: liquidation uses the mark price, not the raw feed price.
      const markPrice = market
        ? this.calculateMarkPrice(newPrice, market.fundingRate.rate)
        : newPrice;
      if (
        shouldLiquidate(markPrice, position.liquidationPrice, position.side)
      ) {
        try {
          const outcome = await this.db.transaction(async (tx) => {
            const current = await tx.lockOpenPositionById(position.id);
            // Already closed concurrently (e.g. by the user): nothing to settle.
            if (!current) return null;
            if (
              !shouldLiquidate(
                markPrice,
                current.liquidationPrice,
                current.side
              )
            ) {
              return { liquidated: false as const, current };
            }

            // Remaining margin is what the liquidation takes: the current
            // size, on top of whatever earlier partial closes already settled.
            const marginLoss = current.size / current.leverage;
            const closed = await tx.closePosition(current.id, {
              currentPrice: newPrice,
              closedAt: now,
              realizedPnL: (current.realizedPnL ?? 0) - marginLoss,
              unrealizedPnL: 0,
              unrealizedPnLPercent: 0,
            });
            if (!closed) return null;

            if (market) {
              // OI decreases by the remaining notional (size), not leveraged
              // exposure. Apply as a delta so multiple liquidations on one
              // market accumulate.
              await tx.applyMarketDeltas(current.ticker, {
                openInterest: -current.size,
              });
            }
            return { liquidated: true as const, current, marginLoss };
          });

          if (outcome === null) continue;
          if (outcome.liquidated) {
            await this.deps.wallet.recordPnL({
              userId: outcome.current.userId,
              pnl: -outcome.marginLoss,
              reason: 'perp_liquidation',
              relatedId: outcome.current.id,
            });
            summary.liquidations++;
            await this.invalidateCaches(outcome.current.ticker);
            continue;
          }
          // The locked row no longer liquidates at this mark; fall through
          // and refresh its metrics from the current values instead.
          live = outcome.current;
        } catch (err) {
          summary.errors.push({
            key: position.ticker,
            positionId: position.id,
            error: `Liquidation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
      }

      // Update unrealized
      const { pnl, pnlPercent } = calculateUnrealizedPnL(
        live.entryPrice,
        newPrice,
        live.side,
        live.size
      );

      // Persist open position metrics
      try {
        await this.db.updateOpenPosition(position.id, {
          currentPrice: newPrice,
          unrealizedPnL: pnl,
          unrealizedPnLPercent: pnlPercent,
          lastUpdated: now,
        });
        summary.positionsUpdated++;
      } catch (err) {
        summary.errors.push({
          key: position.ticker,
          positionId: position.id,
          error: `Position update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Update market prices (simple stats update)
    for (const [key, price] of priceMap.entries()) {
      const market =
        marketByOrg.get(key) ??
        marketByTicker.get(key) ??
        markets.find((m) => m.organizationId === key || m.ticker === key);
      if (!market) continue;

      // Calculate 24h change using price24hAgo (falls back to current if not set)
      const referencePrice = market.price24hAgo ?? market.currentPrice;
      const change24h = price - referencePrice;
      const changePercent24h =
        referencePrice === 0 ? 0 : (change24h / referencePrice) * 100;

      // Calculate mark price with funding premium
      const markPrice = this.calculateMarkPrice(price, market.fundingRate.rate);
      const evolvedQuote = evolveSyntheticPerpQuoteState({
        market: {
          ...market,
          currentPrice: price,
          markPrice,
        },
        previousQuote: getSyntheticPerpQuoteState(market),
      });

      try {
        await this.db.updateMarketStats(market.ticker, {
          currentPrice: price,
          change24h,
          changePercent24h,
          high24h: Math.max(market.high24h, price),
          low24h: Math.min(market.low24h, price),
          bidPrice: evolvedQuote.bidPrice,
          askPrice: evolvedQuote.askPrice,
          spreadBps: evolvedQuote.spreadBps,
          bidDepth: evolvedQuote.bidDepth,
          askDepth: evolvedQuote.askDepth,
          liquidityRegime: evolvedQuote.liquidityRegime,
          quoteUpdatedAt: this.deps.clock?.now() ?? new Date(),
          markPrice,
        });
        summary.marketsUpdated++;
      } catch (err) {
        summary.errors.push({
          key: market.ticker,
          error: `Market stats update failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return summary;
  }

  /**
   * Refresh quote state for all markets so spread/depth can relax over time
   * during quieter periods where the mid price barely moves.
   */
  async refreshQuoteStates(): Promise<number> {
    return new PerpQuoteStateService({
      db: this.db,
      clock: this.deps.clock,
    }).refreshQuoteStates();
  }

  /**
   * Run a funding step (8h by default), updating fundingPaid per position and fundingRate per market.
   * Funding is accrued to positions (not settled to wallets here; PnL is adjusted on close).
   */
  async processFundingStep(): Promise<void> {
    const markets = await this.db.listMarkets();
    const positions = await this.db.listOpenPositions();

    const positionsByTicker = new Map<string, PerpPositionAggregate>();
    for (const pos of positions) {
      const agg =
        positionsByTicker.get(pos.ticker) ||
        createPerpAggregate(pos.ticker, pos.organizationId);
      if (pos.side === 'long') {
        agg.longOpenInterest += pos.size;
      } else {
        agg.shortOpenInterest += pos.size;
      }
      agg.positions.push(pos);
      positionsByTicker.set(pos.ticker, agg);
    }

    const now = this.deps.clock?.now() ?? new Date();
    const nextFundingTime = new Date(
      now.getTime() + FUNDING_PERIOD_HOURS * 60 * 60 * 1000
    ).toISOString();

    for (const market of markets) {
      const agg = positionsByTicker.get(market.ticker);

      // Markets without open positions still get their funding terms
      // refreshed (zero open interest yields the base rate), so the rate and
      // nextFundingTime shown to users never go stale.
      const funding = calculateDynamicFundingRate({
        longOpenInterest: agg?.longOpenInterest ?? 0,
        shortOpenInterest: agg?.shortOpenInterest ?? 0,
        baseFundingRate: BASE_FUNDING_RATE,
        maxFundingRate: MAX_FUNDING_RATE,
        imbalanceExponent: IMBALANCE_EXPONENT,
      });

      const periodRate = funding.periodRate;
      for (const pos of agg?.positions ?? []) {
        // A close may have settled funding since the snapshot. Recompute from
        // the locked row so settled funding is not restored or charged again.
        await this.db.transaction(async (tx) => {
          const fresh = await tx.lockOpenPositionById(pos.id);
          if (!fresh) return;

          // periodRate is signed (negative when shorts dominate); the payer is
          // decided by paymentDirection, so apply only the magnitude here.
          const payment = Math.abs(
            calculateFundingPaymentForPeriod(fresh.size, periodRate)
          );
          // Positive fundingPaid = paid by the position holder
          const delta =
            funding.paymentDirection === 'balanced'
              ? 0
              : funding.paymentDirection === 'longs_pay'
                ? fresh.side === 'long'
                  ? payment
                  : -payment
                : fresh.side === 'short'
                  ? payment
                  : -payment;

          if (delta !== 0) {
            await tx.updateOpenPosition(fresh.id, {
              fundingPaid: fresh.fundingPaid + delta,
              lastUpdated: now,
            });
          }
        });
      }

      await this.db.updateMarketStats(market.ticker, {
        fundingRate: {
          ticker: market.ticker,
          rate: funding.annualRate,
          nextFundingTime,
          predictedRate: funding.annualRate,
        },
      });
    }
  }

  /**
   * Convenience: run price updates + funding in one pass.
   *
   * @returns Summary of price update operations (if priceUpdates provided).
   */
  async processFundingAndLiquidations(
    priceUpdates?:
      | Map<string, number>
      | Record<string, number>
      | Array<[string, number]>
  ): Promise<PriceUpdateSummary | void> {
    let summary: PriceUpdateSummary | undefined;
    if (priceUpdates) {
      summary = await this.applyPriceUpdates(priceUpdates);
    }
    await this.processFundingStep();
    return summary;
  }

  private async assertUserExposure(
    db: PerpDbPort,
    userId: string,
    addedExposure: number,
    excludedPositionId?: string,
    opensPosition = false
  ): Promise<void> {
    const positions = await db.getOpenPositionsByUser(userId);
    for (const position of positions)
      this.assertOpenPositionIntegrity(position);
    const exposure = positions
      .filter((position) => position.id !== excludedPositionId)
      .reduce((sum, position) => sum + position.size * position.leverage, 0);
    if (exposure + addedExposure > MAX_PERP_USER_EXPOSURE) {
      throw new ValidationError(
        `Total exposure would exceed limit: current ${exposure.toLocaleString()}, new ${addedExposure.toLocaleString()}, max ${MAX_PERP_USER_EXPOSURE.toLocaleString()}`
      );
    }
    if (opensPosition && positions.length >= MAX_POSITIONS_PER_USER) {
      throw new ValidationError(
        `Maximum positions reached (${MAX_POSITIONS_PER_USER}). Close a position first.`
      );
    }
  }

  private calculateFee(notional: number): number {
    // FeeService records and splits the fee in integer cents (one
    // canonical rounded fee), so charge that same cent-rounded amount:
    // an unrounded charge would disagree with the fee ledger, the
    // platform/referrer split and users.totalFeesPaid.
    const fee =
      Math.round(notional * this.deps.fees.tradingFeeRate * 100) / 100;
    return Math.max(fee, this.deps.fees.minFeeAmount);
  }

  /**
   * Expected average fill for opening/adding `size` on `side`: the
   * constant-product impact fill when a price impact port is configured
   * (this is what the position's entry is adjusted to), otherwise the quote.
   * A flip applies its signed closing leg before pricing the inverse leg.
   */
  private async expectedOpenFill(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number,
    quotePrice: number,
    precedingTradeSize = 0
  ): Promise<number> {
    const impactFill = await this.previewImpactFill({
      ticker: market.ticker,
      currentSpotPrice: market.currentPrice,
      signedTradeSize: side === 'long' ? size : -size,
      precedingTradeSize,
    });
    return impactFill ?? quotePrice;
  }

  /** Quote the AMM open fill, retaining the existing quote if the port fails. */
  private async resolvePreviewOpenFill(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number,
    quotePrice: number,
    precedingTradeSize = 0
  ): Promise<number> {
    try {
      return await this.expectedOpenFill(
        market,
        side,
        size,
        quotePrice,
        precedingTradeSize
      );
    } catch (error) {
      logger.warn(
        'Preview AMM fill unavailable; falling back to synthetic quote',
        {
          ticker: market.ticker,
          error: error instanceof Error ? error.message : String(error),
        },
        'PerpService'
      );
      return quotePrice;
    }
  }

  /**
   * Reject when the execution fill deviates from the reference price by more
   * than the requested tolerance (0 or undefined disables the check).
   */
  private assertWithinSlippage(
    fillPrice: number,
    referencePrice: number | undefined,
    maxSlippage: number | undefined
  ): void {
    if (maxSlippage === undefined || maxSlippage <= 0) return;
    if (!referencePrice || !Number.isFinite(referencePrice)) return;
    const priceDeviation =
      Math.abs(fillPrice - referencePrice) / referencePrice;
    if (priceDeviation > maxSlippage) {
      throw new ValidationError(
        `Slippage exceeded: execution price ${fillPrice.toFixed(2)} deviates ` +
          `${(priceDeviation * 100).toFixed(2)}% from mark price ${referencePrice.toFixed(2)} ` +
          `(max allowed: ${(maxSlippage * 100).toFixed(2)}%)`
      );
    }
  }

  /**
   * Invalidate the cached perp trades list for a ticker after a trade.
   * Mirrors PredictionMarketService.invalidateCaches: the web perp
   * trades route caches `perp-trades:<ticker>:<limit>:<offset>` for
   * 30s, so without this the list keeps serving the pre-trade state
   * until the TTL expires. Never throws — a cache failure must not
   * fail a trade that has already settled.
   */
  private async invalidateCaches(ticker: string) {
    if (!this.deps.cache) return;
    try {
      await this.deps.cache.invalidate(`perp:${ticker}:*`);
    } catch (err) {
      logger.warn(
        'Perp trades cache invalidation failed',
        { ticker, error: err instanceof Error ? err.message : String(err) },
        'PerpMarketService'
      );
    }
  }

  /**
   * Emit a trade event via the broadcast port for real-time UI updates.
   * Silently skips if no broadcast port is configured.
   * Logs errors for observability but never fails the trade.
   */
  private async emitTradeEvent(
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.deps.broadcast) return;
    try {
      await this.deps.broadcast.emit('markets', payload);
    } catch (err) {
      // Broadcast is optional - don't fail the trade if SSE fails
      // Log for observability to help diagnose real-time update issues
      logger.warn(
        'Broadcast failed',
        { error: err instanceof Error ? err.message : String(err) },
        'PerpMarketService'
      );
    }
  }

  /**
   * Add to an existing position (same side).
   * Calculates weighted average entry price and increases position size.
   *
   * Uses transaction for atomicity to prevent race conditions when
   * multiple add-to-position requests arrive concurrently.
   */
  private async addToPosition(
    existing: PerpPositionRecord,
    input: PerpOpenInput,
    market: PerpMarketRecord
  ): Promise<PerpTradeResult> {
    const { size: addedSize } = input;
    const currentPrice = this.getOpenExecutionQuote(
      market,
      existing.side,
      addedSize
    ).executionPrice;

    // Validate added size
    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    if (addedSize < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }

    // An add inherits the existing position's leverage, so the top-level
    // input-leverage check in openPosition cannot catch a legacy position
    // already above the cap: adding to it would grow above-cap exposure
    // even when the add itself requests an at-cap leverage. Reject the
    // exposure-increasing add; closing or reducing stays allowed.
    const maxLeverage = effectiveMaxLeverage(market);
    if (existing.leverage > maxLeverage) {
      throw new Error(
        `Cannot add to a position above the leverage cap (existing ${existing.leverage}x exceeds ${maxLeverage}x); close or reduce it first`
      );
    }

    // Check max position size
    const maxPositionSize = this.calculateMaxPositionSize(market.openInterest);
    const newTotalSize = existing.size + addedSize;
    if (newTotalSize > maxPositionSize) {
      throw new Error(
        `Total position size would exceed market limit (${maxPositionSize.toLocaleString()})`
      );
    }

    // Slippage protection against the expected post-impact fill
    if (input.maxSlippage !== undefined && input.maxSlippage > 0) {
      this.assertWithinSlippage(
        await this.expectedOpenFill(
          market,
          existing.side,
          addedSize,
          currentPrice
        ),
        market.markPrice,
        input.maxSlippage
      );
    }

    // Calculate margin and fees for added portion only
    const effectiveLeverage = existing.leverage;
    const marginRequired = addedSize / effectiveLeverage;
    const fee = this.calculateFee(addedSize);
    const totalCost = marginRequired + fee;

    const now = this.deps.clock?.now() ?? new Date();

    // Use transaction for atomic position + market stats update
    // This prevents race conditions when concurrent requests modify the same position
    const result =
      await this.deps.settlement.run<AddToPositionTransactionResult>(
        input.userId,
        async (tx, wallet) => {
          // Re-fetch and row-lock the position so concurrent adds/closes on the
          // same position serialize instead of overwriting each other.
          const freshPosition = await tx.lockOpenPositionById(existing.id);
          if (!freshPosition) {
            throw new Error('Position no longer exists or was closed');
          }
          if (!isOpenPerpPositionStateValid(freshPosition)) {
            this.assertOpenPositionIntegrity(freshPosition);
          }

          if (
            freshPosition.userId !== input.userId ||
            freshPosition.side !== existing.side ||
            freshPosition.leverage !== existing.leverage
          ) {
            throw new ConflictError(
              'Position changed concurrently; retry with fresh state'
            );
          }
          await this.assertUserExposure(
            tx,
            input.userId,
            addedSize * freshPosition.leverage
          );
          if (freshPosition.size + addedSize > maxPositionSize) {
            throw new ValidationError(
              `Total position size would exceed market limit (${maxPositionSize.toLocaleString()})`
            );
          }
          await wallet.debit({
            userId: input.userId,
            amount: totalCost,
            reason: 'perp_add_to_position',
            description: `Add ${addedSize} to ${effectiveLeverage}x ${existing.side} ${existing.ticker}`,
          });
          // Recalculate with fresh position data to handle concurrent updates
          const actualNewSize = freshPosition.size + addedSize;
          const newEntryPrice =
            (freshPosition.size * freshPosition.entryPrice +
              addedSize * currentPrice) /
            actualNewSize;

          // Recalculate liquidation price with new entry
          const newLiquidationPrice = calculateLiquidationPrice(
            newEntryPrice,
            freshPosition.side,
            effectiveLeverage
          );

          // Calculate unrealized PnL with new entry price
          const { pnl, pnlPercent } = calculateUnrealizedPnL(
            newEntryPrice,
            currentPrice,
            freshPosition.side,
            actualNewSize
          );

          // Update the existing position
          await tx.updateOpenPosition(freshPosition.id, {
            size: actualNewSize,
            entryPrice: newEntryPrice,
            currentPrice,
            liquidationPrice: newLiquidationPrice,
            unrealizedPnL: pnl,
            unrealizedPnLPercent: pnlPercent,
            lastUpdated: now,
          });

          // Update market stats (atomic deltas)
          const marketTotals = await tx.applyMarketDeltas(
            freshPosition.ticker,
            {
              openInterest: addedSize,
              volume24h: addedSize,
            }
          );

          await wallet.recordPnL({
            userId: input.userId,
            pnl: -fee,
            reason: 'perp_add_to_position',
            relatedId: existing.id,
          });

          // Return result data for use after transaction commits
          return {
            positionId: freshPosition.id,
            ticker: freshPosition.ticker,
            side: freshPosition.side,
            size: actualNewSize,
            leverage: effectiveLeverage,
            entryPrice: newEntryPrice,
            liquidationPrice: newLiquidationPrice,
            marginPaid: marginRequired,
            feePaid: fee,
            isRebalance: true,
            rebalanceType: 'add' as const,
            previousSize: freshPosition.size,
            previousEntryPrice: freshPosition.entryPrice,
            newOpenInterest: marketTotals.openInterest,
            volume24h: marketTotals.volume24h,
          };
        }
      );

    // Process fees outside transaction to avoid holding locks during external work.
    // Uses retry logic for reliability.
    void this.processFeeWithRetry(
      {
        userId: input.userId,
        amount: addedSize,
        type: 'perp_add_to_position',
        relatedId: result.ticker,
        positionId: result.positionId,
      },
      { ticker: result.ticker }
    ).catch(() => {
      // Error already logged in processFeeWithRetry; catch to prevent unhandled rejection
    });

    // Get balance after transaction commits
    const balance = (await this.deps.wallet.getBalance(input.userId)).balance;

    // Broadcast trade event outside transaction (SSE should not hold DB locks)
    void this.emitTradeEvent({
      type: 'perp_trade',
      action: 'add_to_position',
      ticker: result.ticker,
      side: result.side,
      size: result.size,
      addedSize,
      leverage: result.leverage,
      entryPrice: result.entryPrice,
      previousEntryPrice: result.previousEntryPrice,
      positionId: result.positionId,
      openInterest: result.newOpenInterest,
      volume24h: result.volume24h,
      timestamp: now.toISOString(),
    });

    // Return final result with balance (exclude helper fields not in PerpTradeResult)
    const finalResult: PerpTradeResult = {
      positionId: result.positionId,
      ticker: result.ticker,
      side: result.side,
      size: result.size,
      leverage: result.leverage,
      entryPrice: result.entryPrice,
      // The added size filled at the open quote; entryPrice is the blend.
      fillPrice: currentPrice,
      liquidationPrice: result.liquidationPrice,
      marginPaid: result.marginPaid,
      feePaid: result.feePaid,
      balance,
      isRebalance: result.isRebalance,
      rebalanceType: result.rebalanceType,
      previousSize: result.previousSize,
      previousEntryPrice: result.previousEntryPrice,
    };

    // BF-75: Apply price impact to the added size only, then re-average it
    // with the pre-add basis so historical cost is preserved. The add is
    // already committed, so an impact failure must not report it as failed
    // (the failure is already logged inside applyPostTradeImpact).
    const impactAdj = await this.applyPostTradeImpact(
      existing.ticker,
      finalResult.positionId,
      finalResult.entryPrice,
      finalResult.side,
      existing.leverage,
      input.size,
      {
        previousSize: result.previousSize,
        previousEntryPrice: result.previousEntryPrice,
      }
    ).catch(() => undefined);
    if (impactAdj) {
      finalResult.entryPrice = impactAdj.entryPrice;
      finalResult.fillPrice = impactAdj.fillPrice;
      finalResult.liquidationPrice = impactAdj.liquidationPrice;
    }

    return finalResult;
  }

  /**
   * Reduce, close, or flip an existing position (opposite side trade).
   *
   * - If tradeSize < existingSize: Partial close (reduce position)
   * - If tradeSize = existingSize: Full close (flatten)
   * - If tradeSize > existingSize: Close existing + open inverse (flip)
   */
  private async reduceOrFlipPosition(
    existing: PerpPositionRecord,
    input: PerpOpenInput,
    market: PerpMarketRecord
  ): Promise<PerpTradeResult> {
    const { size: tradeSize, side: tradeSide, leverage, maxSlippage } = input;

    // Validate trade size
    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    if (tradeSize < minOrderSize) {
      throw new Error(`Order size below minimum (${minOrderSize})`);
    }

    const now = this.deps.clock?.now() ?? new Date();

    if (tradeSize < existing.size) {
      // REDUCE: Partial close of existing position
      const closePercentage = tradeSize / existing.size;
      const closeResult = await this.closePosition({
        userId: input.userId,
        positionId: existing.id,
        percentage: closePercentage,
        maxSlippage,
      });

      return {
        ...closeResult,
        isRebalance: true,
        rebalanceType: 'reduce',
        previousSize: existing.size,
        previousEntryPrice: existing.entryPrice,
      };
    } else if (Math.abs(tradeSize - existing.size) < 0.01) {
      // CLOSE: Full close (sizes are equal within tolerance)
      const closeResult = await this.closePosition({
        userId: input.userId,
        positionId: existing.id,
        percentage: 1,
        maxSlippage,
      });

      return {
        ...closeResult,
        isRebalance: true,
        rebalanceType: 'close',
        previousSize: existing.size,
        previousEntryPrice: existing.entryPrice,
      };
    } else {
      // FLIP: Close existing and open inverse position
      // The new leg is a fresh position, so it must clear the minimum order
      // size on its own: the gross trade size clearing it is not enough,
      // or a flip could open a dust position below the minimum.
      const inverseSize = tradeSize - existing.size;
      if (inverseSize < minOrderSize) {
        throw new ValidationError(`Order size below minimum (${minOrderSize})`);
      }
      // Slippage protection for both legs against the fills the flip will
      // execute at, checked before any funds move (same as a fresh open).
      if (maxSlippage !== undefined && maxSlippage > 0) {
        const closeQuote = this.getCloseExecutionQuote(
          market,
          existing.side,
          existing.size
        ).executionPrice;
        // The close leg executes at the AMM average exit fill (same as a
        // standalone close), so check slippage against that fill.
        const closeImpact = await this.previewCloseImpact({
          ticker: market.ticker,
          exitPrice: closeQuote,
          currentSpotPrice: market.currentPrice,
          side: existing.side,
          closeSize: existing.size,
        });
        this.assertWithinSlippage(
          closeImpact?.avgExitPrice ?? closeQuote,
          market.markPrice ?? market.currentPrice,
          maxSlippage
        );
        const inverseSize = tradeSize - existing.size;
        const inverseQuote = this.getOpenExecutionQuote(
          market,
          tradeSide,
          inverseSize
        ).executionPrice;
        this.assertWithinSlippage(
          await this.expectedOpenFill(
            market,
            tradeSide,
            inverseSize,
            inverseQuote,
            existing.side === 'long' ? -existing.size : existing.size
          ),
          market.markPrice,
          maxSlippage
        );
      }
      // Use transaction for atomicity - all DB operations use tx
      const flipResult =
        await this.deps.settlement.run<FlipPositionTransactionResult>(
          input.userId,
          async (tx, wallet) => {
            // Row-lock the position being flipped so a concurrent close/flip
            // cannot settle it twice.
            const position = await tx.lockOpenPositionById(existing.id);
            if (!position) {
              throw new Error(
                `Position not found or already closed: ${existing.id}`
              );
            }
            this.assertOpenPositionIntegrity(position);
            if (
              position.userId !== input.userId ||
              position.side === tradeSide ||
              tradeSize <= position.size ||
              position.size !== existing.size
            ) {
              throw new ConflictError(
                'Position changed concurrently; retry the flip with fresh state'
              );
            }

            await this.assertUserExposure(
              tx,
              input.userId,
              (tradeSize - position.size) *
                Math.min(leverage, effectiveMaxLeverage(market)),
              position.id
            );

            const closeExecution = this.getCloseExecutionQuote(
              market,
              position.side,
              position.size
            );
            // Settle the closing leg at the AMM average exit fill, exactly
            // like a standalone close (closePosition), so a flip and a
            // close + open round trip settle identically.
            const closeImpact = await this.previewCloseImpact({
              ticker: position.ticker,
              exitPrice: closeExecution.executionPrice,
              currentSpotPrice: market.currentPrice,
              side: position.side,
              closeSize: position.size,
            });
            const exitPrice =
              closeImpact?.avgExitPrice ?? closeExecution.executionPrice;

            // === STEP 1: Close existing position (inline logic for atomicity) ===

            // Calculate PnL for the closed position
            const { pnl: closePnl } = calculateUnrealizedPnL(
              position.entryPrice,
              exitPrice,
              position.side,
              position.size
            );
            const realizedPnL = closePnl - position.fundingPaid;
            const closeMarginPaid = position.size / position.leverage;
            const closeFee = this.calculateFee(position.size);
            // A close cannot lose more than the leg's margin: the
            // settlement below is already floored at 0, but the uncapped
            // realizedPnL was stored/returned while recordPnL booked only
            // the capped loss, so the two records of the same close
            // disagreed past the margin. Cap here, matching closePosition
            // and the liquidation cap (Math.max(..., -marginLoss)).
            const cappedRealizedPnL = Math.max(realizedPnL, -closeMarginPaid);
            const grossSettlement = closeMarginPaid + cappedRealizedPnL;
            const netSettlement = Math.max(0, grossSettlement - closeFee);

            await tx.closePosition(position.id, {
              currentPrice: exitPrice,
              closedAt: now,
              realizedPnL: (position.realizedPnL ?? 0) + cappedRealizedPnL,
              unrealizedPnL: 0,
              unrealizedPnLPercent: 0,
            });

            // === STEP 2: Open inverse position ===

            const inverseSize = tradeSize - position.size;
            const maxLeverage = effectiveMaxLeverage(market);
            const effectiveLeverage = Math.min(leverage, maxLeverage);

            const entryPrice = this.getOpenExecutionQuote(
              market,
              tradeSide,
              inverseSize
            ).executionPrice;
            const liquidationPrice = calculateLiquidationPrice(
              entryPrice,
              tradeSide,
              effectiveLeverage
            );
            const marginRequired = inverseSize / effectiveLeverage;
            const openFee = this.calculateFee(inverseSize);
            const totalCost = marginRequired + openFee;

            // Create new position using transaction
            const newPosition = await tx.upsertPosition({
              id: undefined,
              userId: input.userId,
              ticker: position.ticker,
              organizationId: position.organizationId,
              side: tradeSide,
              entryPrice,
              currentPrice: entryPrice,
              size: inverseSize,
              leverage: effectiveLeverage,
              liquidationPrice,
              unrealizedPnL: 0,
              unrealizedPnLPercent: 0,
              fundingPaid: 0,
              openedAt: now,
              lastUpdated: now,
            });

            // === STEP 3: Update market stats atomically ===
            // OI change: -position.size (closed) + inverseSize (opened)
            const volumeTraded = position.size + inverseSize;
            const marketTotals = await tx.applyMarketDeltas(position.ticker, {
              openInterest: inverseSize - position.size,
              volume24h: volumeTraded,
            });

            // Settle the wallet and P&L in the same transaction as both legs.
            const walletNet = netSettlement - totalCost;
            const walletDescription = `Flip ${position.leverage}x ${position.side} to ${effectiveLeverage}x ${tradeSide} ${position.ticker}`;
            if (walletNet > 0) {
              await wallet.credit({
                userId: input.userId,
                amount: walletNet,
                reason: 'perp_flip_position',
                description: walletDescription,
                relatedId: position.id,
              });
            } else if (walletNet < 0) {
              await wallet.debit({
                userId: input.userId,
                amount: -walletNet,
                reason: 'perp_flip_position',
                description: walletDescription,
                relatedId: newPosition.id,
              });
            }

            // Net realized PnL for the flip operation:
            // - Close leg: settlement minus returned margin (includes any fee actually collected)
            // - Open leg: fee is realized immediately
            const netClosePnL = netSettlement - closeMarginPaid;
            const netFlipPnL = netClosePnL - openFee;
            await wallet.recordPnL({
              userId: input.userId,
              pnl: netFlipPnL,
              reason: 'perp_flip_position',
              relatedId: position.id,
            });

            // Return result data for use after transaction commits
            const totalFees = closeFee + openFee;
            return {
              positionId: newPosition.id,
              ticker: position.ticker,
              side: tradeSide,
              size: inverseSize,
              leverage: effectiveLeverage,
              entryPrice,
              liquidationPrice,
              marginPaid: marginRequired,
              feePaid: totalFees,
              exitPrice,
              realizedPnL: cappedRealizedPnL,
              isRebalance: true,
              rebalanceType: 'flip' as const,
              previousSize: position.size,
              previousEntryPrice: position.entryPrice,
              newOpenInterest: marketTotals.openInterest,
              volume24h: marketTotals.volume24h,
            };
          }
        );

      // Fee bookkeeping for close + open legs (retries + optional outbox).
      void Promise.all([
        this.processFeeWithRetry(
          {
            userId: input.userId,
            amount: existing.size,
            type: 'perp_close',
            relatedId: existing.ticker,
            positionId: existing.id,
          },
          { ticker: existing.ticker }
        ),
        this.processFeeWithRetry(
          {
            userId: input.userId,
            amount: flipResult.size,
            type: 'perp_flip_position',
            relatedId: existing.ticker,
            positionId: flipResult.positionId,
          },
          { ticker: existing.ticker }
        ),
      ]).catch(() => {
        // Errors logged inside processFeeWithRetry; avoid unhandled rejection
      });

      // Get balance after transaction commits
      const balance = (await this.deps.wallet.getBalance(input.userId)).balance;

      // Broadcast flip event outside transaction (SSE should not hold DB locks)
      void this.emitTradeEvent({
        type: 'perp_trade',
        action: 'flip_position',
        ticker: existing.ticker,
        previousSide: existing.side,
        newSide: flipResult.side,
        closedSize: existing.size,
        newSize: flipResult.size,
        leverage: flipResult.leverage,
        entryPrice: flipResult.entryPrice,
        realizedPnL: flipResult.realizedPnL,
        positionId: flipResult.positionId,
        previousPositionId: existing.id,
        openInterest: flipResult.newOpenInterest,
        volume24h: flipResult.volume24h,
        timestamp: now.toISOString(),
      });

      // Return final result with balance (exclude helper fields not in PerpTradeResult)
      const finalResult: PerpTradeResult = {
        positionId: flipResult.positionId,
        ticker: flipResult.ticker,
        side: flipResult.side,
        size: flipResult.size,
        leverage: flipResult.leverage,
        entryPrice: flipResult.entryPrice,
        fillPrice: flipResult.entryPrice,
        exitPrice: flipResult.exitPrice,
        liquidationPrice: flipResult.liquidationPrice,
        marginPaid: flipResult.marginPaid,
        feePaid: flipResult.feePaid,
        realizedPnL: flipResult.realizedPnL,
        balance,
        isRebalance: flipResult.isRebalance,
        rebalanceType: flipResult.rebalanceType,
        previousSize: flipResult.previousSize,
        previousEntryPrice: flipResult.previousEntryPrice,
      };

      // BF-75: Apply price impact and adjust entry for the new flipped position.
      // The flip is already committed, so an impact failure must not report
      // it as failed (the failure is already logged inside
      // applyPostTradeImpact).
      const impactAdj = await this.applyPostTradeImpact(
        existing.ticker,
        finalResult.positionId,
        finalResult.entryPrice,
        tradeSide,
        Math.min(leverage, effectiveMaxLeverage(market)),
        tradeSize - existing.size
      ).catch(() => undefined);
      if (impactAdj) {
        finalResult.entryPrice = impactAdj.entryPrice;
        finalResult.fillPrice = impactAdj.fillPrice;
        finalResult.liquidationPrice = impactAdj.liquidationPrice;
      }

      return finalResult;
    }
  }

  private calculateMaxPositionSize(openInterest: number): number {
    const fromOi = openInterest * OPEN_INTEREST_LIMIT_RATIO;
    return Math.max(fromOi, MIN_MAX_POSITION_SIZE);
  }

  private async getRequiredMarket(ticker: string): Promise<PerpMarketRecord> {
    const normalizedTicker = ticker.toUpperCase();
    const markets = await this.db.listMarkets();
    const market = markets.find(
      (candidate) => candidate.ticker.toUpperCase() === normalizedTicker
    );
    if (!market) {
      throw new Error(`Market not found: ${ticker}`);
    }
    return market;
  }

  private async buildOpenExecutionPreview(
    market: PerpMarketRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): Promise<PerpOpenExecutionPreview> {
    const execution = this.getOpenExecutionQuote(
      market,
      input.side,
      input.size
    );
    // Quote the fill execution actually settles at: the AMM average fill
    // when a price-impact port is configured, otherwise the synthetic
    // quote. Quoting the synthetic price here misstates the entry (and
    // the liquidation price derived from it) once the impact cap binds.
    const executionPrice = await this.resolvePreviewOpenFill(
      market,
      input.side,
      input.size,
      execution.executionPrice
    );
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : execution.midPrice;
    const quotedPrice =
      input.side === 'long' ? execution.askPrice : execution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(executionPrice - currentPrice) / Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const liquidationPrice = calculateLiquidationPrice(
      executionPrice,
      input.side,
      input.leverage
    );
    const liquidationDistancePercent =
      input.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;
    const marginRequired = input.size / input.leverage;
    const estimatedFee = this.calculateFee(input.size);

    return {
      previewType: 'open',
      isRebalance: false,
      ticker: input.ticker.toUpperCase(),
      side: input.side,
      size: input.size,
      leverage: input.leverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: execution.bidPrice,
      askPrice: execution.askPrice,
      spreadBps: execution.spreadBps,
      bidDepth: execution.bidDepth,
      askDepth: execution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee,
      totalRequired: marginRequired + estimatedFee,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private async buildAddPreview(
    market: PerpMarketRecord,
    existing: PerpPositionRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): Promise<PerpOpenExecutionPreview> {
    const addedSize = input.size;
    const effectiveLeverage = existing.leverage;
    const execution = this.getOpenExecutionQuote(
      market,
      existing.side,
      addedSize
    );
    // Same AMM-fill quoting as the open preview: execution blends this
    // fill with the existing basis via applyPostTradeImpact.
    const executionPrice = await this.resolvePreviewOpenFill(
      market,
      existing.side,
      addedSize,
      execution.executionPrice
    );
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : execution.midPrice;
    const quotedPrice =
      existing.side === 'long' ? execution.askPrice : execution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(executionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(executionPrice - currentPrice) / Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const resultingSize = existing.size + addedSize;
    const averagedEntryPrice =
      (existing.size * existing.entryPrice + addedSize * executionPrice) /
      resultingSize;
    const liquidationPrice = calculateLiquidationPrice(
      averagedEntryPrice,
      existing.side,
      effectiveLeverage
    );
    const liquidationDistancePercent =
      existing.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;
    const marginRequired = addedSize / effectiveLeverage;
    const estimatedFee = this.calculateFee(addedSize);

    return {
      previewType: 'add',
      isRebalance: true,
      rebalanceType: 'add',
      ticker: input.ticker.toUpperCase(),
      side: existing.side,
      size: addedSize,
      leverage: effectiveLeverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: execution.bidPrice,
      askPrice: execution.askPrice,
      spreadBps: execution.spreadBps,
      bidDepth: execution.bidDepth,
      askDepth: execution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee,
      totalRequired: marginRequired + estimatedFee,
      resultingSize,
      resultingSide: existing.side,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  /**
   * Average exit fill for a close leg of `closeSize`: the constant-product
   * impact fill when a price impact port is configured, otherwise the quote.
   * Mirrors the settlement in closePosition and in the flip leg of
   * reduceOrFlipPosition, so the preview and the execution agree.
   */
  private async resolveCloseExitPrice(
    market: PerpMarketRecord,
    existing: PerpPositionRecord,
    closeSize: number,
    closeExecution: ReturnType<PerpMarketService['getCloseExecutionQuote']>
  ): Promise<number> {
    const closeImpact = await this.previewCloseImpact({
      ticker: market.ticker,
      exitPrice: closeExecution.executionPrice,
      currentSpotPrice: market.currentPrice,
      side: existing.side,
      closeSize,
    });
    return closeImpact?.avgExitPrice ?? closeExecution.executionPrice;
  }

  private async buildOppositeSidePreview(
    market: PerpMarketRecord,
    existing: PerpPositionRecord,
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>
  ): Promise<PerpOpenExecutionPreview> {
    const currentPrice =
      Number.isFinite(market.currentPrice) && market.currentPrice > 0
        ? market.currentPrice
        : existing.currentPrice;

    if (input.size < existing.size) {
      const closeExecution = this.getCloseExecutionQuote(
        market,
        existing.side,
        input.size
      );
      const closeExitPrice = await this.resolveCloseExitPrice(
        market,
        existing,
        input.size,
        closeExecution
      );
      return this.buildReduceOrClosePreview({
        market,
        existing,
        input,
        closeSize: input.size,
        closeExecution,
        closeExitPrice,
        rebalanceType: 'reduce',
        resultingSize: existing.size - input.size,
        currentPrice,
      });
    }

    if (Math.abs(input.size - existing.size) < 0.01) {
      const closeExecution = this.getCloseExecutionQuote(
        market,
        existing.side,
        existing.size
      );
      const closeExitPrice = await this.resolveCloseExitPrice(
        market,
        existing,
        existing.size,
        closeExecution
      );
      return this.buildReduceOrClosePreview({
        market,
        existing,
        input,
        closeSize: existing.size,
        closeExecution,
        closeExitPrice,
        rebalanceType: 'close',
        resultingSize: 0,
        currentPrice,
      });
    }

    const closeExecution = this.getCloseExecutionQuote(
      market,
      existing.side,
      existing.size
    );
    // The close leg settles at the AMM average exit fill (same as a
    // standalone close), so price the preview settlement at that fill —
    // not at the raw-quote close price — or totalRequired disagrees
    // with the debit the flip actually takes.
    const closeExitPrice = await this.resolveCloseExitPrice(
      market,
      existing,
      existing.size,
      closeExecution
    );
    const inverseSize = input.size - existing.size;
    const minOrderSize = market.minOrderSize ?? DEFAULT_MIN_ORDER_SIZE;
    if (inverseSize < minOrderSize) {
      throw new ValidationError(`Order size below minimum (${minOrderSize})`);
    }
    const effectiveLeverage = Math.min(
      input.leverage,
      effectiveMaxLeverage(market)
    );
    const openExecution = this.getOpenExecutionQuote(
      market,
      input.side,
      inverseSize
    );
    const openExecutionPrice = await this.resolvePreviewOpenFill(
      market,
      input.side,
      inverseSize,
      openExecution.executionPrice,
      existing.side === 'long' ? -existing.size : existing.size
    );
    const quotedPrice =
      input.side === 'long' ? openExecution.askPrice : openExecution.bidPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(openExecutionPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(openExecutionPrice - currentPrice) /
        Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const { pnl: closePnl } = calculateUnrealizedPnL(
      existing.entryPrice,
      closeExitPrice,
      existing.side,
      existing.size
    );
    const closeMarginPaid = existing.size / existing.leverage;
    const closeFee = this.calculateFee(existing.size);
    const realizedPnL = closePnl - existing.fundingPaid;
    const grossSettlement = closeMarginPaid + realizedPnL;
    const estimatedCloseSettlement = Math.max(0, grossSettlement - closeFee);
    const marginRequired = inverseSize / effectiveLeverage;
    const openFee = this.calculateFee(inverseSize);
    const openCost = marginRequired + openFee;
    const liquidationPrice = calculateLiquidationPrice(
      openExecutionPrice,
      input.side,
      effectiveLeverage
    );
    const liquidationDistancePercent =
      input.side === 'long'
        ? ((currentPrice - liquidationPrice) / Math.max(currentPrice, 1)) * 100
        : ((liquidationPrice - currentPrice) / Math.max(currentPrice, 1)) * 100;

    return {
      previewType: 'flip',
      isRebalance: true,
      rebalanceType: 'flip',
      ticker: input.ticker.toUpperCase(),
      side: input.side,
      size: inverseSize,
      leverage: effectiveLeverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: openExecutionPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: openExecution.bidPrice,
      askPrice: openExecution.askPrice,
      spreadBps: openExecution.spreadBps,
      bidDepth: openExecution.bidDepth,
      askDepth: openExecution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired,
      estimatedFee: closeFee + openFee,
      totalRequired: Math.max(0, openCost - estimatedCloseSettlement),
      resultingSize: inverseSize,
      resultingSide: input.side,
      estimatedClosePrice: closeExitPrice,
      estimatedCloseSettlement,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private buildReduceOrClosePreview(params: {
    market: PerpMarketRecord;
    existing: PerpPositionRecord;
    input: Pick<PerpOpenInput, 'ticker' | 'side' | 'size' | 'leverage'>;
    closeSize: number;
    closeExecution: ReturnType<PerpMarketService['getCloseExecutionQuote']>;
    closeExitPrice: number;
    rebalanceType: 'reduce' | 'close';
    resultingSize: number;
    currentPrice: number;
  }): PerpOpenExecutionPreview {
    const {
      market,
      existing,
      input,
      closeSize,
      closeExecution,
      closeExitPrice,
      rebalanceType,
      resultingSize,
      currentPrice,
    } = params;
    const { pnl: closePnl } = calculateUnrealizedPnL(
      existing.entryPrice,
      closeExitPrice,
      existing.side,
      closeSize
    );
    const closePercentage = closeSize / existing.size;
    const proportionalFunding = existing.fundingPaid * closePercentage;
    const realizedPnL = closePnl - proportionalFunding;
    const closeMarginPaid = closeSize / existing.leverage;
    const closeFee = this.calculateFee(closeSize);
    const grossSettlement = closeMarginPaid + realizedPnL;
    const estimatedCloseSettlement = Math.max(0, grossSettlement - closeFee);
    const quotedPrice =
      existing.side === 'long'
        ? closeExecution.bidPrice
        : closeExecution.askPrice;
    const quoteImpactPrice = Math.max(
      0,
      Math.abs(closeExitPrice - quotedPrice)
    );
    const totalSlippageBps =
      (Math.abs(closeExitPrice - currentPrice) / Math.max(currentPrice, 1)) *
      10_000;
    const quoteImpactBps =
      (quoteImpactPrice / Math.max(currentPrice, 1)) * 10_000;
    const liquidationPrice =
      rebalanceType === 'reduce' ? existing.liquidationPrice : 0;
    const liquidationDistancePercent =
      rebalanceType === 'reduce'
        ? existing.side === 'long'
          ? ((currentPrice - existing.liquidationPrice) /
              Math.max(currentPrice, 1)) *
            100
          : ((existing.liquidationPrice - currentPrice) /
              Math.max(currentPrice, 1)) *
            100
        : 0;

    return {
      previewType: rebalanceType,
      isRebalance: true,
      rebalanceType,
      ticker: input.ticker.toUpperCase(),
      side: existing.side,
      size: closeSize,
      leverage: existing.leverage,
      currentPrice,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      quotedPrice,
      executionPrice: closeExitPrice,
      quoteImpactPrice,
      quoteImpactBps,
      totalSlippageBps,
      bidPrice: closeExecution.bidPrice,
      askPrice: closeExecution.askPrice,
      spreadBps: closeExecution.spreadBps,
      bidDepth: closeExecution.bidDepth,
      askDepth: closeExecution.askDepth,
      liquidityRegime: getSyntheticPerpQuoteState(market).liquidityRegime,
      marginRequired: 0,
      estimatedFee: closeFee,
      totalRequired: 0,
      resultingSize,
      resultingSide: resultingSize > 0 ? existing.side : null,
      estimatedClosePrice: closeExitPrice,
      estimatedCloseSettlement,
      liquidationPrice,
      liquidationDistancePercent,
    };
  }

  private getOpenExecutionQuote(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number
  ) {
    return getSyntheticPerpExecutionPrice({
      market,
      side: side === 'long' ? 'buy' : 'sell',
      size,
    });
  }

  private getCloseExecutionQuote(
    market: PerpMarketRecord,
    side: PerpSide,
    size: number
  ) {
    return getSyntheticPerpExecutionPrice({
      market,
      side: side === 'long' ? 'sell' : 'buy',
      size,
    });
  }

  /**
   * Calculate mark price from spot price and funding rate.
   *
   * Mark price = Spot price × (1 + funding premium)
   * Funding premium = annual funding rate / periods per year
   *
   * This helps prevent unnecessary liquidations during short-term volatility.
   */
  private calculateMarkPrice(
    spotPrice: number,
    annualFundingRate: number
  ): number {
    const fundingPremium = annualFundingRate / periodsPerYear();
    return spotPrice * (1 + fundingPremium);
  }
}

function calculateLiquidationPrice(
  entryPrice: number,
  side: PerpSide,
  leverage: number
): number {
  // Guard against division by zero - leverage must be >= 1
  if (leverage < 1) leverage = 1;
  // Standard perp liquidation: full margin loss (1/leverage) triggers liquidation.
  // Matches Hyperliquid-style mechanics where initial margin = 1/leverage.
  const liquidationThreshold = 1 / leverage;
  if (side === 'long') {
    return entryPrice * (1 - liquidationThreshold);
  }
  return entryPrice * (1 + liquidationThreshold);
}

function deriveNetHoldingsFromSpotPrice(
  initialPrice: number,
  spotPrice: number
): number | undefined {
  if (
    !Number.isFinite(initialPrice) ||
    initialPrice <= 0 ||
    !Number.isFinite(spotPrice) ||
    spotPrice <= 0
  ) {
    return undefined;
  }

  const { quoteReserve, k } = getInitialReserves(
    initialPrice,
    PERP_MARKET_CONFIG
  );
  const currentQuote = Math.sqrt(spotPrice * k);
  if (!Number.isFinite(currentQuote)) {
    return undefined;
  }

  return currentQuote - quoteReserve;
}

function calculateUnrealizedPnL(
  entryPrice: number,
  currentPrice: number,
  side: PerpSide,
  size: number
): { pnl: number; pnlPercent: number } {
  // Guard against division by zero and non-finite values
  if (
    entryPrice <= 0 ||
    size <= 0 ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(size)
  ) {
    return { pnl: 0, pnlPercent: 0 };
  }
  const pnl =
    side === 'long'
      ? ((currentPrice - entryPrice) / entryPrice) * size
      : ((entryPrice - currentPrice) / entryPrice) * size;
  const pnlPercent = (pnl / size) * 100;
  return { pnl, pnlPercent };
}

/**
 * Resolve a requested close fraction. Omitted means a full close; anything
 * explicit must be a finite fraction in (0, 1] — NaN, zero, negative or
 * oversize values are rejected rather than silently becoming a full close.
 */
function resolveClosePercentage(percentage: number | undefined): number {
  if (percentage === undefined) return 1;
  if (
    !Number.isFinite(percentage) ||
    percentage <= 0 ||
    percentage > 1 + 1e-9
  ) {
    throw new Error(
      `Close percentage must be a finite number in (0, 1], got ${percentage}`
    );
  }
  return Math.min(1, percentage);
}

function normalizePriceMap(
  input: Map<string, number> | Record<string, number> | Array<[string, number]>
): Map<string, number> {
  // Always copy: invalid entries are filtered out of the result and must not
  // mutate the caller's Map.
  if (input instanceof Map) return new Map(input);
  if (Array.isArray(input)) return new Map(input);
  return new Map(
    Object.entries(input).map(([k, v]) => [k, Number(v)] as [string, number])
  );
}

interface PerpPositionAggregate {
  ticker: string;
  organizationId: string;
  longOpenInterest: number;
  shortOpenInterest: number;
  positions: PerpPositionRecord[];
}

function createPerpAggregate(
  ticker: string,
  organizationId: string
): PerpPositionAggregate {
  return {
    ticker,
    organizationId,
    longOpenInterest: 0,
    shortOpenInterest: 0,
    positions: [],
  };
}

interface FundingRateResult {
  annualRate: number;
  periodRate: number;
  imbalance: number;
  isSeverelyImbalanced: boolean;
  paymentDirection: 'longs_pay' | 'shorts_pay' | 'balanced';
}

function calculateDynamicFundingRate(params: {
  longOpenInterest: number;
  shortOpenInterest: number;
  baseFundingRate?: number;
  maxFundingRate?: number;
  imbalanceExponent?: number;
}): FundingRateResult {
  const {
    longOpenInterest,
    shortOpenInterest,
    baseFundingRate = BASE_FUNDING_RATE,
    maxFundingRate = MAX_FUNDING_RATE,
    imbalanceExponent = IMBALANCE_EXPONENT,
  } = params;

  const totalOI = longOpenInterest + shortOpenInterest;
  if (totalOI === 0) {
    const base = baseFundingRate;
    return {
      annualRate: base,
      periodRate: base / periodsPerYear(),
      imbalance: 0,
      isSeverelyImbalanced: false,
      paymentDirection: 'balanced',
    };
  }

  const imbalance = (longOpenInterest - shortOpenInterest) / totalOI;
  let paymentDirection: 'longs_pay' | 'shorts_pay' | 'balanced';
  if (Math.abs(imbalance) < 0.05) {
    paymentDirection = 'balanced';
  } else if (imbalance > 0) {
    paymentDirection = 'longs_pay';
  } else {
    paymentDirection = 'shorts_pay';
  }

  const absImbalance = Math.abs(imbalance);
  // At max imbalance (1.0), rate should reach maxFundingRate
  // At zero imbalance, rate stays at baseFundingRate
  // Using polynomial curve: rate = base + (max - base) * imbalance^exponent
  const rateRange = maxFundingRate - baseFundingRate;
  const rateMultiplier = rateRange * absImbalance ** imbalanceExponent;

  let annualRate: number;
  if (absImbalance < 0.01) {
    // The premium must follow the imbalance even within the base-rate band.
    annualRate = imbalance < 0 ? -baseFundingRate : baseFundingRate;
  } else {
    const signedRate =
      (baseFundingRate + rateMultiplier) * Math.sign(imbalance);
    annualRate = Math.max(
      -maxFundingRate,
      Math.min(maxFundingRate, signedRate)
    );
  }

  const periodRate = annualRate / periodsPerYear();
  const isSeverelyImbalanced = absImbalance > 0.4;

  return {
    annualRate,
    periodRate,
    imbalance,
    isSeverelyImbalanced,
    paymentDirection,
  };
}

/**
 * Funding payment for a single period given a **pre-converted** period rate.
 *
 * NOTE: This differs from the shared ``calculateFundingPayment`` in
 * ``@feed/shared/perps-types`` which accepts an **annual** rate and
 * internally divides by periods-per-year.  Here the caller
 * (``processFundingStep``) already converts to a period rate via
 * ``annualRate / periodsPerYear()``, so no further division is needed.
 */
function calculateFundingPaymentForPeriod(
  size: number,
  periodRate: number
): number {
  return size * periodRate;
}

function periodsPerYear(): number {
  return (365.25 * 24) / FUNDING_PERIOD_HOURS;
}

import { shouldLiquidate } from './utils';
