import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { usePnlHistory } from '@/hooks/usePnlHistory';

type History = ReturnType<typeof usePnlHistory>;
let history: History;
const useHistory = mock(() => history);
const renderChart = mock(({ history: value }: { history: History }) => (
  <div data-current-pnl={value.points.at(-1)?.value} />
));

const historyModule = await import('@/hooks/usePnlHistory');
mock.module('@/hooks/usePnlHistory', () => ({
  ...historyModule,
  usePnlHistory: useHistory,
}));
mock.module('@/stores/walletBalanceStore', () => ({
  useWalletBalance: () => ({ lifetimePnL: 20, loading: false, error: null }),
}));
mock.module('./pnl-chart', () => ({ PnLChart: renderChart }));

const { PnLTab } = await import('./pnl-tab');

beforeEach(() => {
  history = {
    points: [
      { time: 1, value: 30 },
      { time: 2, value: 130 },
    ],
    loading: false,
    error: null,
  };
  useHistory.mockClear();
  renderChart.mockClear();
});

describe('personal wallet P&L', () => {
  it('uses the same canonical latest value for the summary and chart', () => {
    const html = renderToStaticMarkup(<PnLTab userId="owner-1" />);

    expect(useHistory).toHaveBeenCalledWith('owner-1', '1D', {
      scope: 'owner',
    });
    expect(html).toContain('+$130.00');
    expect(html).toContain('+$20.00');
    expect(html).toContain('+$110.00');
    expect(html).toContain('data-current-pnl="130"');
    expect(renderChart.mock.calls[0]?.[0].history).toBe(history);
  });

  it('hides stale values while a timeframe refresh is pending', () => {
    history = { ...history, loading: true };
    const html = renderToStaticMarkup(<PnLTab userId="owner-1" />);

    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('+$130.00');
    expect(renderChart).not.toHaveBeenCalled();
  });

  it('shows a history failure instead of a fabricated current total', () => {
    history = { ...history, error: new Error('History unavailable') };
    const html = renderToStaticMarkup(<PnLTab userId="owner-1" />);

    expect(html).toContain('Failed to load P&amp;L');
    expect(html).toContain('History unavailable');
    expect(renderChart).not.toHaveBeenCalled();
  });
});
