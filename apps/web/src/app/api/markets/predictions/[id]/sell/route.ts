import type { JsonValue } from '@feed/api';
import {
  authenticate,
  broadcastToChannel,
  checkProgress,
  invalidateMarketsApiPredictionsAfterUserTrade,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import {
  FEE_CONFIG,
  FeeService,
  invalidateAfterPredictionTrade,
  type PredictionSettlementOptions,
  WalletService,
  withPredictionSettlement,
} from '@feed/engine';
import {
  logger,
  PredictionMarketIdSchema,
  PredictionMarketSellSchema,
} from '@feed/shared';
import type { NextRequest } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';

const serviceOptions = (marketId: string): PredictionSettlementOptions => ({
  broadcast: {
    emit: (channel, payload) =>
      broadcastToChannel(channel, payload as Record<string, JsonValue>),
  },
  cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
  clock: { now: () => new Date() },
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
  feeProcessor: (tx) => ({
    processTradingFee: ({ userId, amount, type, relatedId, positionId }) =>
      FeeService.processTradingFee(
        userId,
        type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
        amount,
        positionId,
        relatedId,
        tx
      ),
  }),
});

// POST /api/markets/predictions/[id]/sell - offchain prediction market sell
export const POST = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    const { id: marketId } = PredictionMarketIdSchema.parse(
      await context.params
    );
    const user = await authenticate(request);
    const { shares, positionId } = PredictionMarketSellSchema.parse(
      await request.json()
    );

    const result = await withPredictionSettlement(
      marketId,
      { userId: user.userId },
      (service) =>
        service.sell({
          userId: user.userId,
          marketId,
          shares,
          positionId,
        }),
      serviceOptions(marketId)
    );

    const balance = await WalletService.getBalance(user.userId);

    trackServerEvent(user.userId, 'prediction_sold', {
      marketId,
      sharesSold: shares,
      grossProceeds: result.totalProceeds ?? result.netProceeds ?? 0,
      netProceeds: result.netProceeds ?? 0,
      pnl: result.pnl ?? 0,
      priceImpact: result.market.priceImpact,
      feeCharged: result.feePaid,
      positionId: result.positionId,
    } as Record<string, JsonValue>).catch((error) => {
      logger.warn('Failed to track prediction_sold event', { error });
    });

    void checkProgress(user.userId, { type: 'prediction_trade', marketId });
    void invalidateMarketsApiPredictionsAfterUserTrade(user.userId);

    return successResponse({
      sharesSold: shares,
      grossProceeds: result.totalProceeds ?? result.netProceeds,
      netProceeds: result.netProceeds,
      pnl: result.pnl,
      market: result.market,
      fee: {
        amount: result.feePaid,
        referrerPaid: 0,
      },
      remainingShares: result.remainingShares,
      positionClosed: result.positionClosed ?? false,
      newBalance: balance.balance,
      positionId: result.positionId,
    });
  }
);
