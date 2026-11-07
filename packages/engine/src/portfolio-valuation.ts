import { isOpenPerpPositionStateValid } from '@feed/core/markets/perps/client';
import { toNumber } from '@feed/shared';

export { toNumber };

/**
 * Canonical mark-to-market value for an open perpetual position.
 *
 * `size` is the leveraged notional, so we recover posted margin as
 * `abs(size / leverage)` and then add current unrealized PnL.
 *
 * Accrued funding settles at close (realizedPnL = pnl - fundingPaid in
 * PerpMarketService), so the open position's equity is net of it: funding
 * owed (fundingPaid > 0) reduces the value, a funding rebate
 * (fundingPaid < 0) increases it. Omitting it overstates the value by
 * exactly the accrued funding.
 */
export function calculatePerpPositionMarketValue(position: {
  leverage: unknown;
  size: unknown;
  unrealizedPnL: unknown;
  fundingPaid?: unknown;
}): number {
  if (!isOpenPerpPositionStateValid(position)) {
    return 0;
  }

  const size = toNumber(position.size);
  const leverage = toNumber(position.leverage);
  const unrealizedPnL = toNumber(position.unrealizedPnL);
  const fundingPaid = toNumber(position.fundingPaid);
  const effectiveLeverage =
    Number.isFinite(leverage) && leverage > 0 ? leverage : 1;
  const margin = Math.abs(size / effectiveLeverage);

  return margin + unrealizedPnL - fundingPaid;
}
