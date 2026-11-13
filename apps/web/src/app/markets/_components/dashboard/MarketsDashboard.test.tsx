import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PerpMarket } from '@/types/markets';
import { MarketsDashboard } from './MarketsDashboard';

function perp(ticker: string, name: string): PerpMarket {
  return {
    ticker,
    organizationId: `org-${ticker}`,
    name,
    currentPrice: 100,
    change24h: 1,
    changePercent24h: 1,
    high24h: 110,
    low24h: 90,
    volume24h: 1000,
    openInterest: 500,
    fundingRate: {
      rate: 0.01,
      nextFundingTime: '2026-01-01T00:00:00.000Z',
      predictedRate: 0.01,
    },
    maxLeverage: 10,
    minOrderSize: 1,
  };
}

function renderDashboard(initialSearchQuery?: string): string {
  return renderToStaticMarkup(
    <MarketsDashboard
      initialSearchQuery={initialSearchQuery}
      perpMarkets={[perp('BTC-PERP', 'Bitcoin'), perp('ETH-PERP', 'Ethereum')]}
      predictionMarkets={[]}
      perpLoading={false}
      predictionLoading={false}
      perpError={false}
      predictionError={false}
      onSelectMarket={() => {}}
    />
  );
}

describe('MarketsDashboard arrival search', () => {
  it('seeds the search box and filters the list from the arrival search', () => {
    const html = renderDashboard('BTC');
    expect(html).toContain('value="BTC"');
    expect(html).toContain('Bitcoin');
    expect(html).not.toContain('Ethereum');
  });

  it('matches the arrival search case-insensitively', () => {
    const html = renderDashboard('btc');
    expect(html).toContain('Bitcoin');
    expect(html).not.toContain('Ethereum');
  });

  it('shows the full list with an empty search box when no search arrives', () => {
    const html = renderDashboard();
    expect(html).toContain('value=""');
    expect(html).toContain('Bitcoin');
    expect(html).toContain('Ethereum');
  });
});
