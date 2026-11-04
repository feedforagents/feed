/**
 * Trade Execution Service
 *
 * Executes LLM-generated trading decisions for NPCs.
 * Creates positions, updates balances, records trades.
 *
 * NPC perp trades now use PerpMarketService for consistency with user trades,
 * ensuring funding and liquidation logic applies uniformly.
 *
 * ## NPC Trade Rate Limiting
 *
 * NPC trading is rate-limited at two levels (by design):
 *
 * 1. **Probability Filter (MarketDecisionEngine)**: Before LLM calls, NPCs are
 *    filtered by `NPC_TRADE_PROBABILITY` (default 60%). This reduces LLM API
 *    costs and spreads trading decisions across ticks.
 *
 * 2. **Hard Rate Limits (TradeExecutionService)**: Before execution, each NPC
 *    is checked against cooldown (`NPC_MIN_MINUTES_BETWEEN_TRADES`) and daily
 *    cap (`NPC_MAX_TRADES_PER_DAY`) via `NpcTradeRateLimiter`.
 *
 * The dual filtering is intentional:
 * - Probability filter = reduces LLM workload per tick (cost optimization)
 * - Execution filter = enforces hard rate limits (behavior control)
 *
 * @see NpcTradeRateLimiter for rate limiting implementation details
 */
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { PredictionDbAdapter as CorePredictionDbAdapter } from '@feed/core/markets/prediction';
import {
  actorState,
  and,
  db,
  eq,
  isNull,
  type JsonValue,
  npcTrades,
  organizationState,
  perpPositions,
  poolPositions,
  sql,
  type Transaction,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { FEE_CONFIG } from '../config/fees';
import { getSimulationPrice } from '../config/simulation';
import { isSimulationMode } from '../storage-bridge';
import type {
  ExecutedTrade,
  MarketAction,
  TradingDecision,
  TradingExecutionResult,
} from '../types/market-decisions';
import { formatError } from '../utils/error-utils';
import { FeeService } from './fee-service';
import { NpcTradeRateLimiter } from './npc-trade-rate-limiter';
import { createNpcWalletAdapter } from './npc-wallet-adapter';
import { createPerpPriceImpactPort } from './perp-price-impact-port';
import { createPerpSettlement } from './perp-settlement';
import {
  type PredictionSettlementOptions,
  withPredictionSettlement,
} from './prediction-settlement';
import { broadcastToChannel } from './realtime-broadcaster';
import {
  StaticDataRegistry,
  type StaticOrganization,
} from './static-data-registry';
import { invalidateAfterPredictionTrade } from './trade-cache-invalidation';

type PredictionTradeBroadcast = {
  type: 'prediction_trade';
  version?: string;
  marketId: string;
  yesPrice: number;
  noPrice: number;
  yesShares: number;
  noShares: number;
  liquidity?: number;
  trade: {
    actorType: 'user' | 'npc' | 'system';
    actorId?: string;
    action: 'buy' | 'sell' | 'close';
    side: 'yes' | 'no';
    shares: number;
    amount: number;
    price: number;
    source: 'user_trade' | 'npc_trade' | 'system';
    timestamp: string;
  };
};

type PredictionResolutionBroadcast = {
  type: 'prediction_resolution';
  version?: string;
  marketId: string;
  winningSide: 'yes' | 'no';
  yesShares: number;
  noShares: number;
  liquidity?: number;
  totalPayout: number;
  timestamp: string;
  resolutionProofUrl?: string | null;
  resolutionDescription?: string | null;
};

type PredictionBroadcastPayload =
  | PredictionTradeBroadcast
  | PredictionResolutionBroadcast;

const isPredictionBroadcastPayload = (
  payload: Record<string, unknown>
): payload is PredictionBroadcastPayload => {
  const type = (payload as { type?: unknown }).type;
  return type === 'prediction_trade' || type === 'prediction_resolution';
};

const normalizeIdentifier = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Resolve an LLM-provided ticker/organization identifier to exactly one
 * organization. Accepts exact id, case-insensitive ticker, and normalized
 * (punctuation/case-insensitive) id/ticker/name equality. Substring matching
 * is intentionally not supported: it let blank or partial identifiers select
 * an unrelated first organization. Ambiguous or empty identifiers are
 * rejected.
 */
export function resolveOrganizationByTicker(
  identifier: string,
  organizations: StaticOrganization[] = StaticDataRegistry.getAllOrganizations()
): StaticOrganization | undefined {
  const exact = organizations.find((o) => o.id === identifier);
  if (exact) return exact;

  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return undefined;

  const tickerMatches = organizations.filter(
    (o) => o.ticker && normalizeIdentifier(o.ticker) === normalized
  );
  const matches =
    tickerMatches.length > 0
      ? tickerMatches
      : organizations.filter(
          (o) =>
            normalizeIdentifier(o.id) === normalized ||
            normalizeIdentifier(o.name) === normalized
        );

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous organization identifier "${identifier}": matches ${matches
        .map((o) => o.id)
        .join(', ')}`
    );
  }
  return matches[0];
}

export class TradeExecutionService {
  /**
   * Execute a batch of trading decisions
   */
  async executeDecisionBatch(
    decisions: TradingDecision[]
  ): Promise<TradingExecutionResult> {
    const startTime = Date.now();

    // Simulation Mode Bypass
    if (isSimulationMode()) {
      const batchTimestamp = Date.now();
      const executedTrades: ExecutedTrade[] = decisions
        .filter((d) => d.action !== 'hold')
        .map((d, index) => ({
          npcId: d.npcId,
          npcName: d.npcName,
          poolId: 'sim-pool',
          marketType: d.marketType || 'perp',
          ticker: d.ticker,
          marketId: d.marketId,
          action: d.action,
          side: this.deriveSideFromAction(d.action),
          amount: d.amount,
          size: d.amount,
          executionPrice: getSimulationPrice(d.ticker ?? ''),
          confidence: d.confidence,
          reasoning: d.reasoning,
          positionId: `sim-pos-${batchTimestamp}-${index}`,
          timestamp: new Date().toISOString(),
        }));

      return {
        totalDecisions: decisions.length,
        successfulTrades: executedTrades.length,
        failedTrades: 0,
        holdDecisions: decisions.length - executedTrades.length,
        totalVolumePerp: 0,
        totalVolumePrediction: 0,
        errors: [],
        executedTrades,
      };
    }

    const result: TradingExecutionResult = {
      totalDecisions: decisions.length,
      successfulTrades: 0,
      failedTrades: 0,
      holdDecisions: 0,
      totalVolumePerp: 0,
      totalVolumePrediction: 0,
      errors: [],
      executedTrades: [],
    };

    // Compute strict mode once before the loop to avoid repeated env lookups
    const isStrictMode =
      process.env.STRICT_LLM_VALIDATION === 'true' ||
      process.env.STRICT_LLM_VALIDATION === '1';

    // Track rate-limited trades for logging
    let rateLimitedCount = 0;

    for (const decision of decisions) {
      if (decision.action === 'hold') {
        result.holdDecisions++;
        continue;
      }

      // Check rate limits before executing (cooldown + daily cap)
      // Uses NpcTradeRateLimiter which supports pluggable providers for distributed deployments
      const canTrade = await NpcTradeRateLimiter.canTrade(decision.npcId);
      if (!canTrade) {
        rateLimitedCount++;
        logger.debug(
          `NPC ${decision.npcName} rate limited, skipping trade`,
          { npcId: decision.npcId, action: decision.action },
          'TradeExecutionService'
        );
        result.holdDecisions++; // Count as hold since we're not executing
        continue;
      }

      let executedTrade: ExecutedTrade;
      try {
        executedTrade = await this.executeSingleDecision(decision);
      } catch (error) {
        result.failedTrades++;
        const errorMessage = formatError(error);
        result.errors.push({
          npcId: decision.npcId,
          decision,
          error: errorMessage,
        });

        // Use warn level for expected failures (non-existent organizations, insufficient balance, limits)
        // Use error level for unexpected system failures
        const isExpectedFailure =
          errorMessage.includes('Organization not found') ||
          errorMessage.includes('Insufficient trading balance') ||
          errorMessage.includes('Market not found') ||
          errorMessage.includes('Market already resolved') ||
          errorMessage.includes('Market expired') ||
          /exceed(?:s)? market limit/i.test(errorMessage) || // Handles all variants
          errorMessage.includes('Position already closed') ||
          errorMessage.includes('Position not found') ||
          errorMessage.includes('Already have an open') ||
          // Prediction market price impact guards — expected for oversized trades
          errorMessage.includes('move odds by') ||
          errorMessage.includes('market is too thin for this trade size');
        const logLevel = isExpectedFailure ? 'warn' : 'error';

        logger[logLevel](
          `Failed to execute trade for ${decision.npcName}`,
          {
            error,
            decision,
          },
          'TradeExecutionService'
        );

        // Log loudly in development, throw in strict mode
        if (process.env.NODE_ENV !== 'production' && !isExpectedFailure) {
          if (isStrictMode) {
            throw new Error(
              `[DEV] NPC trade execution failed for ${decision.npcName}: ${errorMessage}`,
              { cause: error }
            );
          }
          logger.error(
            `[DEV] NPC trade execution failed for ${decision.npcName}: ${errorMessage} - continuing with remaining trades`,
            { decision: JSON.stringify(decision) },
            'TradeExecutionService'
          );
        }
        continue;
      }

      // The trade is committed from here on: ancillary tracking failures must
      // not turn it into a failed (retryable) trade.
      result.executedTrades.push(executedTrade);
      result.successfulTrades++;
      if (executedTrade.marketType === 'perp') {
        result.totalVolumePerp += executedTrade.size;
      } else {
        result.totalVolumePrediction += executedTrade.size;
      }

      // Record successful trade for rate limiting
      await NpcTradeRateLimiter.recordTrade(decision.npcId).catch(
        (error: Error) => {
          logger.error(
            'Failed to record NPC trade for rate limiting',
            { npcId: decision.npcId, error: error.message },
            'TradeExecutionService'
          );
        }
      );
    }

    const duration = Date.now() - startTime;

    // Periodically clean up stale rate limit entries to prevent memory growth
    // This is cheap (O(n) scan) and only runs when using in-memory provider
    const cleanedEntries = NpcTradeRateLimiter.cleanupStaleEntries();
    const providerStats = NpcTradeRateLimiter.getProviderStats();

    logger.info(
      `Executed ${result.successfulTrades} trades in ${duration}ms`,
      {
        ...result,
        rateLimited: rateLimitedCount,
        durationMs: duration,
        ...(cleanedEntries > 0 && { rateLimitEntriesCleaned: cleanedEntries }),
        ...(providerStats && { rateLimitMapSize: providerStats.lastTradeTime }),
      },
      'TradeExecutionService'
    );

    return result;
  }

  /**
   * Execute a single trading decision
   */
  async executeSingleDecision(
    decision: TradingDecision
  ): Promise<ExecutedTrade> {
    // Normalize NPC ID to lowercase for case-insensitive lookup
    const normalizedNpcId = decision.npcId.toLowerCase();

    // Normalize amount - handle string amounts with commas (e.g., "12,000" -> 12000)
    if (typeof decision.amount === 'string') {
      const cleanedAmount = String(decision.amount).replace(/,/g, '');
      const parsed = Number.parseFloat(cleanedAmount);
      // Validate parsed value is finite (not NaN, not Infinity, not -Infinity)
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid amount (not finite): ${decision.amount}`);
      }
      decision.amount = parsed;
    }

    // For close_position and prediction sell actions, amount=0 is valid and
    // means "close the full position". Other actions must carry a positive amount.
    const isClosePosition = decision.action === 'close_position';
    const isPredictionSell =
      decision.action === 'sell_yes' || decision.action === 'sell_no';
    if (!Number.isFinite(decision.amount)) {
      throw new Error(`Invalid amount (not finite): ${decision.amount}`);
    }
    if (!(isClosePosition || isPredictionSell) && decision.amount <= 0) {
      throw new Error(`Invalid amount: ${decision.amount}`);
    }
    if ((isClosePosition || isPredictionSell) && decision.amount !== 0) {
      // Closes and prediction sells always exit the full position; a
      // non-zero amount would otherwise be silently ignored.
      throw new Error(
        `Invalid amount for ${decision.action}: ${decision.amount} (must be 0; partial exits are not supported)`
      );
    }

    // Get NPC actor
    const [actor] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, normalizedNpcId))
      .limit(1);

    if (!actor) {
      throw new Error(`Actor not found: ${decision.npcId}`);
    }

    // Update decision to use normalized ID
    decision.npcId = normalizedNpcId;

    // Balance checks are performed inside transactions to ensure atomicity
    // and prevent race conditions when multiple trades are queued for the same NPC

    // Handle close position
    if (decision.action === 'close_position') {
      return await this.closePosition(decision, actor.id);
    }

    // Handle open position
    if (decision.action === 'open_long' || decision.action === 'open_short') {
      return await this.openPerpPosition(decision, actor.id);
    }

    if (decision.action === 'buy_yes' || decision.action === 'buy_no') {
      return await this.openPredictionPosition(decision, actor.id);
    }

    // Handle sell actions for prediction markets (close existing position)
    if (decision.action === 'sell_yes' || decision.action === 'sell_no') {
      // Selling is closing a prediction market position
      return await this.closePredictionPosition(decision, actor.id);
    }

    throw new Error(`Unknown action: ${decision.action}`);
  }

  /**
   * Derive the trade side from the action type
   */
  private deriveSideFromAction(action: MarketAction): string {
    switch (action) {
      case 'open_long':
        return 'LONG';
      case 'open_short':
        return 'SHORT';
      case 'buy_yes':
        return 'YES';
      case 'buy_no':
        return 'NO';
      case 'sell_yes':
        return 'SELL_YES';
      case 'sell_no':
        return 'SELL_NO';
      case 'close_position':
        return 'CLOSE';
      default:
        return 'UNKNOWN';
    }
  }

  private createPredictionBroadcast() {
    return {
      emit: async (channel: string, payload: Record<string, unknown>) => {
        if (!isPredictionBroadcastPayload(payload)) return;

        await broadcastToChannel(channel, payload as Record<string, JsonValue>);

        logger.debug('Prediction broadcast event', {
          type: payload.type,
          marketId: payload.marketId,
        });
      },
    };
  }

  /**
   * Open a perpetual position
   */
  private async openPerpPosition(
    decision: TradingDecision,
    actorId: string
  ): Promise<ExecutedTrade> {
    if (!decision.ticker) {
      throw new Error('Ticker required for perp position');
    }

    const staticOrg = resolveOrganizationByTicker(decision.ticker);

    // Get price from organizationState
    let currentPrice: number | null = null;
    if (staticOrg) {
      const [state] = await db
        .select({ currentPrice: organizationState.currentPrice })
        .from(organizationState)
        .where(eq(organizationState.id, staticOrg.id))
        .limit(1);
      currentPrice = state?.currentPrice ?? staticOrg.initialPrice ?? null;
    }

    if (!staticOrg || !currentPrice) {
      logger.warn(
        'NPC tried to trade non-existent organization or org has no price',
        {
          npcId: decision.npcId,
          npcName: decision.npcName,
          ticker: decision.ticker,
          action: decision.action,
          orgFound: !!staticOrg,
          hasPrice: !!currentPrice,
        },
        'TradeExecutionService'
      );
      throw new Error(`Organization not found: ${decision.ticker}`);
    }

    // Use staticOrg for the rest of the function
    const org = staticOrg;

    const leverage = 5; // Standard leverage for NPCs
    const side = decision.action === 'open_long' ? 'long' : 'short';

    // Cap position size to market limit (max 10,000 or 10% of open interest)
    const MAX_POSITION_SIZE = 10_000;
    const maxAmount = MAX_POSITION_SIZE / leverage; // e.g., 10,000 / 5 = 2,000
    const cappedAmount = Math.min(decision.amount, maxAmount);
    const positionSize = cappedAmount * leverage;

    // Use PerpMarketService for consistency with user trades
    // This ensures NPC positions get funding and liquidation applied
    const perpService = new PerpMarketService({
      settlement: createPerpSettlement({
        system: 'npc_perp_trade',
        wallet: (userId, tx) => createNpcWalletAdapter(userId, tx),
      }),
      db: new PerpDbAdapter(),
      wallet: createNpcWalletAdapter(actorId),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    // Open position via PerpMarketService (uses perpPositions table)
    // Use org.ticker for perp market lookup (e.g., "NVDAI" not "nvidai")
    const tradeTicker = org.ticker || org.id;

    const result = await perpService.openPosition({
      userId: actorId, // Use actorId as userId for NPC
      ticker: tradeTicker,
      side,
      size: positionSize,
      leverage,
    });

    // Record NPC trade for analytics/tracking (separate from position)
    await this.recordAfterCommit(
      'perp open analytics',
      { npcId: decision.npcId, positionId: result.positionId },
      async () => {
        await db.insert(npcTrades).values({
          id: await generateSnowflakeId(),
          npcActorId: decision.npcId,
          poolId: null,
          marketType: 'perp',
          ticker: tradeTicker,
          action: decision.action,
          side,
          amount: cappedAmount,
          price: result.entryPrice,
          sentiment: decision.confidence * (side === 'long' ? 1 : -1),
          reason: decision.reasoning,
        });
      }
    );

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: 'perp',
      ticker: tradeTicker,
      action: decision.action,
      side,
      amount: cappedAmount,
      size: positionSize,
      executionPrice: result.entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: result.positionId,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run an ancillary write (NPC analytics / legacy mirror) after a trade has
   * already committed. Failures are logged loudly but must not turn the
   * committed trade into a failed — and therefore retryable — trade.
   */
  private async recordAfterCommit(
    label: string,
    context: Record<string, string | number | null | undefined>,
    write: () => Promise<void>
  ): Promise<void> {
    await write().catch((error: Error) => {
      logger.error(
        `Failed to record ${label} after committed NPC trade`,
        { ...context, error: error.message },
        'TradeExecutionService'
      );
    });
  }

  /** Prediction market service wired to the NPC's actorState wallet. */
  private npcPredictionOptions(
    actorId: string,
    marketId: string
  ): PredictionSettlementOptions {
    return {
      wallet: (tx) => createNpcWalletAdapter(actorId, tx),
      broadcast: this.createPredictionBroadcast(),
      cache: {
        invalidate: () => invalidateAfterPredictionTrade(marketId),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      tradeSource: 'npc_trade',
      tradeActorType: 'npc',
    };
  }

  /**
   * Open a prediction market position
   */
  private async openPredictionPosition(
    decision: TradingDecision,
    actorId: string
  ): Promise<ExecutedTrade> {
    if (!decision.marketId) {
      throw new Error('MarketId required for prediction position');
    }
    const marketIdStr = decision.marketId.toString();

    const sideLabel: 'yes' | 'no' =
      decision.action === 'buy_yes' ? 'yes' : 'no';
    const mirrorSide = sideLabel === 'yes' ? 'YES' : 'NO';

    const result = await withPredictionSettlement(
      marketIdStr,
      { system: 'npc_prediction_trade' },
      (service) =>
        service.buy({
          userId: actorId,
          marketId: marketIdStr,
          side: sideLabel,
          amount: decision.amount,
        }),
      this.npcPredictionOptions(actorId, marketIdStr)
    );

    // avgPrice from CPMM is cost-per-share (can exceed 1 for large trades),
    // NOT a 0-1 probability. Store as-is without * 100 conversion.
    const entryPrice = result.avgPrice;
    const now = new Date();
    const tradeCost = result.totalCost ?? decision.amount;
    const currentPrice =
      result.market[sideLabel === 'yes' ? 'yesPrice' : 'noPrice'];

    // Back-compat: mirror the canonical position into poolPositions (read by
    // NPC market context) and log npcTrades. The canonical position holds the
    // accumulated holdings, so repeated buys mirror its total shares instead
    // of overwriting them with this trade's shares.
    await this.recordAfterCommit(
      'prediction buy mirror',
      { npcId: decision.npcId, marketId: marketIdStr },
      async () => {
        const canonical = await new CorePredictionDbAdapter().getPosition(
          actorId,
          marketIdStr,
          sideLabel
        );
        const shares = canonical?.shares ?? result.shares;
        const avgPrice = canonical?.avgPrice ?? entryPrice;

        await db.transaction(async (tx: Transaction) => {
          await tx
            .insert(poolPositions)
            .values({
              id: result.positionId,
              poolId: actorId,
              marketType: 'prediction',
              marketId: marketIdStr,
              side: mirrorSide,
              entryPrice: avgPrice,
              currentPrice,
              size: tradeCost,
              shares,
              unrealizedPnL: 0,
              openedAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: poolPositions.id,
              set: {
                entryPrice: avgPrice,
                currentPrice,
                // Accumulate cost while open; a reopened mirror starts fresh.
                size: sql`CASE WHEN ${poolPositions.closedAt} IS NULL THEN ${poolPositions.size} + ${tradeCost} ELSE ${tradeCost} END`,
                shares,
                closedAt: null,
                updatedAt: now,
              },
            });

          await tx.insert(npcTrades).values({
            id: await generateSnowflakeId(),
            npcActorId: decision.npcId,
            poolId: null,
            marketType: 'prediction',
            marketId: marketIdStr,
            action: decision.action,
            side: mirrorSide,
            amount: decision.amount,
            price: entryPrice,
            sentiment: decision.confidence * (sideLabel === 'yes' ? 1 : -1),
            reason: decision.reasoning,
          });
        });
      }
    );

    await invalidateAfterPredictionTrade(marketIdStr).catch((error) => {
      logger.warn(
        'Failed to invalidate cache after NPC prediction buy',
        { error, marketId: marketIdStr },
        'TradeExecutionService'
      );
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: 'prediction',
      marketId: decision.marketId,
      action: decision.action,
      side: mirrorSide,
      amount: decision.amount,
      size: tradeCost,
      shares: result.shares,
      executionPrice: entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: result.positionId,
      timestamp: now.toISOString(),
    };
  }

  /**
   * Sell an NPC's entire canonical prediction position on one side of a
   * market, then close the legacy poolPositions mirror and log npcTrades.
   * Shared by sell_yes/sell_no and close_position on a prediction position.
   */
  private async sellEntirePredictionPosition(params: {
    decision: TradingDecision;
    actorId: string;
    marketId: string;
    side: 'yes' | 'no';
    tradeAction: string;
  }): Promise<ExecutedTrade> {
    const { decision, actorId, marketId, side, tradeAction } = params;
    const mirrorSide = side === 'yes' ? 'YES' : 'NO';

    // The canonical core position is the source of truth for holdings.
    const canonical = await new CorePredictionDbAdapter().getPosition(
      actorId,
      marketId,
      side
    );
    if (
      !canonical ||
      (canonical.status && canonical.status !== 'active') ||
      canonical.shares <= 0
    ) {
      throw new Error(
        `No open ${mirrorSide} position found for NPC ${decision.npcName} in market ${marketId}`
      );
    }

    const sellResult = await withPredictionSettlement(
      marketId,
      { system: 'npc_prediction_sell' },
      (service) =>
        service.sell({
          userId: actorId,
          marketId,
          shares: canonical.shares,
          positionId: canonical.id,
        }),
      this.npcPredictionOptions(actorId, marketId)
    );
    const now = new Date();

    await this.recordAfterCommit(
      'prediction sell mirror',
      { npcId: decision.npcId, marketId },
      async () => {
        await db.transaction(async (tx: Transaction) => {
          await tx
            .update(poolPositions)
            .set({
              closedAt: now,
              currentPrice:
                sellResult.market[side === 'yes' ? 'yesPrice' : 'noPrice'],
              shares: 0,
              unrealizedPnL: 0,
              realizedPnL: sellResult.pnl ?? 0,
              updatedAt: now,
            })
            .where(
              and(
                eq(poolPositions.poolId, actorId),
                eq(poolPositions.marketId, marketId),
                eq(poolPositions.side, mirrorSide),
                eq(poolPositions.marketType, 'prediction'),
                isNull(poolPositions.closedAt)
              )
            );

          await tx.insert(npcTrades).values({
            id: await generateSnowflakeId(),
            npcActorId: decision.npcId,
            poolId: null,
            marketType: 'prediction',
            marketId,
            action: tradeAction,
            side: mirrorSide,
            amount: sellResult.netProceeds ?? 0,
            price: sellResult.avgPrice ?? 0,
            sentiment: 0,
            reason: decision.reasoning,
          });
        });
      }
    );

    await invalidateAfterPredictionTrade(marketId).catch((error) => {
      logger.warn(
        'Failed to invalidate cache after NPC prediction sell',
        { error, marketId },
        'TradeExecutionService'
      );
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId,
      marketType: 'prediction',
      marketId,
      action: decision.action,
      side: mirrorSide,
      amount: sellResult.netProceeds ?? 0,
      size: sellResult.netProceeds ?? 0, // Executed sell volume
      shares: canonical.shares,
      executionPrice: sellResult.avgPrice ?? 0,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: canonical.id,
      timestamp: now.toISOString(),
    };
  }

  /**
   * Close a prediction position by selling shares
   * Used for sell_yes and sell_no actions
   */
  private async closePredictionPosition(
    decision: TradingDecision,
    actorId: string
  ): Promise<ExecutedTrade> {
    if (!decision.marketId) {
      throw new Error('MarketId required for prediction sell');
    }
    return this.sellEntirePredictionPosition({
      decision,
      actorId,
      marketId: decision.marketId.toString(),
      side: decision.action === 'sell_yes' ? 'yes' : 'no',
      tradeAction: decision.action,
    });
  }

  /**
   * Close an existing position
   *
   * For perp positions: First checks perpPositions (new system), then poolPositions (legacy).
   * For prediction positions: Uses the canonical prediction position.
   */
  private async closePosition(
    decision: TradingDecision,
    actorId: string
  ): Promise<ExecutedTrade> {
    if (!decision.positionId) {
      throw new Error('PositionId required to close position');
    }
    const positionId = decision.positionId;

    // Try perpPositions first (new system for perp trades)
    const [perpPosition] = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.id, positionId))
      .limit(1);

    if (perpPosition && !perpPosition.closedAt) {
      // Use PerpMarketService to close perp position
      return this.closePerpPositionViaService(decision, actorId, perpPosition);
    }

    // Fall back to poolPositions (legacy perp or prediction positions)
    const [position] = await db
      .select()
      .from(poolPositions)
      .where(eq(poolPositions.id, positionId))
      .limit(1);

    if (!position) {
      throw new Error(`Position not found: ${positionId}`);
    }

    // Never settle another actor's position to this caller.
    if (position.poolId !== actorId) {
      throw new Error(
        `Position not found: ${positionId} is not owned by ${actorId}`
      );
    }

    if (position.closedAt) {
      throw new Error(`Position already closed: ${positionId}`);
    }

    if (position.marketType === 'prediction') {
      if (!position.marketId) {
        throw new Error(`Prediction position missing marketId: ${position.id}`);
      }
      if (position.side !== 'YES' && position.side !== 'NO') {
        throw new Error(`Invalid prediction position side: ${position.side}`);
      }
      return this.sellEntirePredictionPosition({
        decision,
        actorId,
        marketId: position.marketId,
        side: position.side === 'YES' ? 'yes' : 'no',
        tradeAction: 'close',
      });
    }

    const now = new Date();

    // Get current price
    let currentPrice = position.currentPrice;

    if (position.marketType === 'perp' && position.ticker) {
      const staticOrg = resolveOrganizationByTicker(position.ticker);

      if (staticOrg) {
        const [state] = await db
          .select({ price: organizationState.currentPrice })
          .from(organizationState)
          .where(eq(organizationState.id, staticOrg.id))
          .limit(1);
        if (state?.price) {
          currentPrice = state.price;
        }
      }
    }

    // Calculate P&L
    const priceChange = currentPrice - position.entryPrice;
    const isLong = position.side === 'long' || position.side === 'YES';
    const pnlMultiplier = isLong ? 1 : -1;

    let realizedPnL: number;
    if (position.marketType === 'perp') {
      const percentChange =
        position.entryPrice !== 0 ? priceChange / position.entryPrice : 0;
      realizedPnL = percentChange * position.size * pnlMultiplier;
    } else {
      const shares = position.shares || 0;
      realizedPnL = (priceChange / 100) * shares;
    }

    // Calculate trading fee (0.1% on position size)
    const feeCalc = FeeService.calculateFee(position.size);
    const grossReturn = position.size + realizedPnL;
    const netReturn = Math.max(0, grossReturn - feeCalc.feeAmount);

    // Execute in transaction
    await db.transaction(async (tx: Transaction) => {
      // Atomically claim the close: only the caller whose update flips
      // closedAt from NULL may credit the settlement, so concurrent closes
      // cannot both pay out.
      const claimed = await tx
        .update(poolPositions)
        .set({
          closedAt: now,
          currentPrice,
          unrealizedPnL: 0,
          realizedPnL,
          updatedAt: now,
        })
        .where(
          and(
            eq(poolPositions.id, positionId),
            eq(poolPositions.poolId, actorId),
            isNull(poolPositions.closedAt)
          )
        )
        .returning({ id: poolPositions.id });

      if (claimed.length === 0) {
        throw new Error(`Position already closed: ${positionId}`);
      }

      // Return capital + P&L to actor's trading balance (after fee deduction)
      const credited = await tx
        .update(actorState)
        .set({
          tradingBalance: sql`${actorState.tradingBalance} + ${netReturn}`,
          updatedAt: new Date(),
        })
        .where(eq(actorState.id, actorId))
        .returning({ id: actorState.id });

      if (credited.length === 0) {
        throw new Error(`Actor not found: ${actorId}`);
      }

      // Record trade (poolId is optional now)
      await tx.insert(npcTrades).values({
        id: await generateSnowflakeId(),
        npcActorId: decision.npcId,
        poolId: null, // No longer using pools
        marketType: position.marketType,
        ticker: position.ticker,
        marketId: position.marketId,
        action: 'close',
        side: position.side,
        amount: position.size,
        price: currentPrice,
        sentiment: 0,
        reason: decision.reasoning,
      });
    });

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId, // Using actorId for backward compatibility
      marketType: position.marketType as 'perp' | 'prediction',
      ticker: position.ticker || undefined,
      marketId: position.marketId ?? undefined,
      action: 'close_position',
      side: position.side,
      amount: position.size,
      size: position.size,
      shares: position.shares || undefined,
      executionPrice: currentPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: position.id,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Close a perp position via PerpMarketService (new system)
   */
  private async closePerpPositionViaService(
    decision: TradingDecision,
    actorId: string,
    position: {
      id: string;
      ticker: string;
      side: string;
      size: number;
      entryPrice: number;
      leverage: number;
    }
  ): Promise<ExecutedTrade> {
    const perpService = new PerpMarketService({
      settlement: createPerpSettlement({
        system: 'npc_perp_trade',
        wallet: (userId, tx) => createNpcWalletAdapter(userId, tx),
      }),
      db: new PerpDbAdapter(),
      wallet: createNpcWalletAdapter(actorId),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
      priceImpact: createPerpPriceImpactPort(),
    });

    const result = await perpService.closePosition({
      userId: actorId,
      positionId: position.id,
    });

    // Record NPC trade for analytics/tracking
    await this.recordAfterCommit(
      'perp close analytics',
      { npcId: decision.npcId, positionId: position.id },
      async () => {
        await db.insert(npcTrades).values({
          id: await generateSnowflakeId(),
          npcActorId: decision.npcId,
          poolId: null,
          marketType: 'perp',
          ticker: position.ticker,
          action: 'close',
          side: position.side,
          amount: result.size,
          price: result.exitPrice ?? result.entryPrice,
          sentiment: 0,
          reason: decision.reasoning,
        });
      }
    );

    return {
      npcId: decision.npcId,
      npcName: decision.npcName,
      poolId: actorId,
      marketType: 'perp',
      ticker: position.ticker,
      action: 'close_position',
      side: position.side,
      amount: result.size,
      size: result.size,
      executionPrice: result.exitPrice ?? result.entryPrice,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      positionId: position.id,
      timestamp: new Date().toISOString(),
    };
  }
}
