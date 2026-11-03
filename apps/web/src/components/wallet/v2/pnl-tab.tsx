'use client';

import { cn, formatCurrency } from '@feed/shared';
import { useState } from 'react';
import { usePnlHistory } from '@/hooks/usePnlHistory';
import { useWalletBalance } from '@/stores/walletBalanceStore';
import { PnLChart } from './pnl-chart';

const timeFilters = ['1H', '4H', '1D', '1W', 'ALL'];

export function PnLTab({ userId }: { userId: string }) {
  const [selectedTime, setSelectedTime] = useState('1D');
  const wallet = useWalletBalance(userId);
  const history = usePnlHistory(userId, selectedTime, { scope: 'owner' });
  const currentPnL = history.points.at(-1)?.value ?? wallet.lifetimePnL;
  const unrealized = currentPnL - wallet.lifetimePnL;
  const error = wallet.error ?? history.error?.message;

  if (wallet.loading || history.loading) {
    return (
      <div className="space-y-3 md:space-y-4">
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
        <div className="h-[200px] animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border py-10 text-center">
        <p className="text-muted-foreground">Failed to load P&L</p>
        <p className="mt-1 text-muted-foreground text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 md:space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-base">You</h2>
        <div className="flex items-center gap-0.5">
          {timeFilters.map((time) => (
            <button
              key={time}
              type="button"
              aria-pressed={selectedTime === time}
              onClick={() => setSelectedTime(time)}
              className={cn(
                'rounded-md px-2.5 py-1 font-medium text-xs transition-colors',
                selectedTime === time
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {time}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5 md:grid-cols-3 md:gap-3">
        {[
          { label: 'Current', value: currentPnL },
          { label: 'Lifetime', value: wallet.lifetimePnL },
          { label: 'Unrealized', value: unrealized },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl border border-border px-3 py-2.5 md:p-4"
          >
            <div className="mb-1 text-muted-foreground text-xs tracking-wide">
              {label}
            </div>
            <div
              className={cn(
                'font-semibold text-sm md:text-base',
                value >= 0 ? 'text-emerald-500' : 'text-red-500'
              )}
            >
              {value >= 0 ? '+' : '-'}
              {formatCurrency(Math.abs(value), { useThousandsSeparator: true })}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border p-2 md:p-3">
        <PnLChart
          metricLabel="Current P&L"
          history={history}
          timeframe={selectedTime}
        />
      </div>
    </div>
  );
}
