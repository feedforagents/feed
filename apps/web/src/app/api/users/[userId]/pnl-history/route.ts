import {
  checkRateLimitAsync,
  findUserByIdentifier,
  getClientIp,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { logger, UserIdParamSchema } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getPnlHistoryCutoff,
  loadScopedPnlHistoryPoints,
  type PnlHistoryRange,
} from '@/lib/wallet/pnlHistory';

function parseRange(value: string | null): PnlHistoryRange {
  switch (value) {
    case '1H':
    case '4H':
    case '1D':
    case '1W':
    case 'ALL':
      return value;
    default:
      return '1D';
  }
}

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const clientIp = getClientIp(request.headers);
    const rateLimitConfig = clientIp
      ? RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH
      : RATE_LIMIT_CONFIGS.PUBLIC_BALANCE_FETCH_ANONYMOUS;

    const rateLimitKey = clientIp ? `ip:${clientIp}` : 'ip:anonymous';
    const rateLimit = await checkRateLimitAsync(rateLimitKey, rateLimitConfig);

    if (!rateLimit.allowed) {
      const retryAfterSeconds = rateLimit.retryAfter || 60;
      return NextResponse.json(
        { error: 'Too many requests', retryAfter: retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
      );
    }

    const { userId } = UserIdParamSchema.parse(await context.params);
    const { searchParams } = new URL(request.url);
    const range = parseRange(searchParams.get('range'));

    const dbUser = await findUserByIdentifier(userId, { id: true });
    if (!dbUser) {
      return successResponse({ points: [] });
    }

    const now = new Date();
    const points = await loadScopedPnlHistoryPoints({
      cutoff: getPnlHistoryCutoff(range, now),
      now,
      scopeUserIds: [dbUser.id],
    });

    logger.info(
      'Wallet current P&L history fetched',
      {
        userId: dbUser.id,
        range,
        pointCount: points.length,
      },
      'GET /api/users/[userId]/pnl-history'
    );

    return successResponse({
      metric: 'currentPnL',
      points,
      scope: 'owner',
    });
  }
);
