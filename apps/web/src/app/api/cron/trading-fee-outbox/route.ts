import {
  recordCronExecution,
  requireCronAuth,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { drainTradingFeeOutboxBatch } from '@feed/engine';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handler = async (request: NextRequest) => {
  const startTime = new Date();

  requireCronAuth(request, { jobName: 'trading-fee-outbox' });

  const result = await drainTradingFeeOutboxBatch();

  logger.info(
    'Trading fee outbox drain completed',
    result,
    'TradingFeeOutboxCron'
  );

  const payload = {
    success: true,
    ...result,
    timestamp: Date.now(),
  };
  recordCronExecution('trading-fee-outbox', startTime, payload);
  return successResponse(payload);
};

export const GET = withErrorHandling(handler);
export const POST = withErrorHandling(handler);
