import {
  recordCronExecution,
  relayCronToStaging,
  requireCronAuth,
  successResponse,
  ValidationError,
  withErrorHandling,
} from '@feed/api';
import {
  fundingPeriodStart,
  PerpDbAdapter,
  PerpMarketService,
} from '@feed/core/markets/perps';
import {
  createPerpSettlement,
  createPerpTradesCachePort,
  FEE_CONFIG,
  WalletService,
} from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const POST = withErrorHandling(async (request: NextRequest) => {
  const startTime = new Date();

  // Use centralized cron auth (fail-closed in production)
  requireCronAuth(request, { jobName: 'PerpFunding' });

  const firstPeriodValue = process.env.PERP_FUNDING_FIRST_PERIOD;
  if (!firstPeriodValue) {
    return successResponse({ success: true, skipped: 'funding-paused' });
  }
  const firstPeriod = new Date(firstPeriodValue);
  if (
    !firstPeriodValue.endsWith('Z') ||
    fundingPeriodStart(firstPeriod).getTime() !== firstPeriod.getTime()
  ) {
    throw new Error('Invalid configured first perp funding period');
  }

  const scheduledTime = request.headers.get('X-Cloudflare-Cron-Time');
  if (
    (scheduledTime === null && request.method === 'GET') ||
    (scheduledTime !== null && !/^\d{13}$/.test(scheduledTime))
  ) {
    throw new ValidationError('Funding requires a valid scheduled timestamp');
  }
  const period =
    scheduledTime === null
      ? fundingPeriodStart(startTime)
      : new Date(Number(scheduledTime));
  if (
    fundingPeriodStart(period).getTime() !== period.getTime() ||
    period > startTime
  ) {
    throw new ValidationError(
      'Funding requires a completed UTC schedule boundary'
    );
  }
  if (period < firstPeriod) {
    return successResponse({
      success: true,
      skipped: 'before-funding-cutover',
    });
  }

  // Relay to staging if configured (REDIRECT_CRON_STAGING; disabled on Cloudflare)
  // but still execute locally (fan-out).
  const relay = await relayCronToStaging(request, 'perp-funding');
  if (relay.forwarded) {
    logger.info(
      'Perp funding cron relayed to staging (fan-out: also executing locally)',
      { status: relay.status, error: relay.error },
      'Cron:perp-funding'
    );
  }

  const service = new PerpMarketService({
    settlement: createPerpSettlement(),
    db: new PerpDbAdapter(),
    cache: createPerpTradesCachePort(),
    wallet: {
      debit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.debit(
          userId,
          amount,
          reason,
          description ?? '',
          relatedId
        ),
      credit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.credit(
          userId,
          amount,
          reason,
          description ?? '',
          relatedId
        ),
      recordPnL: async ({ userId, pnl, reason, relatedId }) => {
        await WalletService.recordPnL(userId, pnl, reason, relatedId);
      },
      getBalance: (userId: string) => WalletService.getBalance(userId),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });

  await service.processFundingStep(period);

  logger.info(
    'Perp funding step executed via cron',
    undefined,
    'Cron:perp-funding'
  );

  // Record metrics
  recordCronExecution('perp-funding', startTime, { success: true });

  return successResponse({ success: true });
});
