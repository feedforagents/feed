import { withErrorHandling } from '@feed/api';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const TRADING_BALANCE_TRANSFER_DISABLED_ERROR =
  'Trading balance transfers are no longer supported. Points can be bought but are never transferred between users.';

export const POST = withErrorHandling(async (_request: NextRequest) => {
  return NextResponse.json(
    {
      error: TRADING_BALANCE_TRANSFER_DISABLED_ERROR,
      code: 'TRADING_BALANCE_TRANSFER_DISABLED',
    },
    { status: 410 }
  );
});
