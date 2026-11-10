/**
 * Daily Login Rewards API
 *
 * GET  - Returns current streak info
 * POST - Retired: daily login rewards pay no points (PRD §9.1, MVP Phase 1)
 */

import {
  authenticateWithDbUser,
  DailyLoginService,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { toISOOrNull } from '@feed/shared';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const DAILY_LOGIN_REWARDS_RETIRED_ERROR =
  'Daily login rewards are no longer supported. Points come only from the starting grant, purchases and trading.';

export const GET = withErrorHandling(async (request: NextRequest) => {
  const { dbUserId } = await authenticateWithDbUser(request);
  const info = await DailyLoginService.getStreakInfo(dbUserId);
  return successResponse({
    ...info,
    lastClaim: toISOOrNull(info.lastClaim),
  });
});

export const POST = withErrorHandling(async (_request: NextRequest) => {
  return NextResponse.json(
    {
      error: DAILY_LOGIN_REWARDS_RETIRED_ERROR,
      code: 'DAILY_LOGIN_REWARDS_RETIRED',
    },
    { status: 410 }
  );
});
