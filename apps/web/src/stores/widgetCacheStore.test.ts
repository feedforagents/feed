import { beforeEach, describe, expect, it } from 'bun:test';
import type { PortfolioBreakdownSnapshot } from '@feed/engine/client';
import { useWidgetCacheStore } from './widgetCacheStore';

const portfolioA: PortfolioBreakdownSnapshot = {
  wallet: 100,
  positions: 50,
  available: 100,
  netPeerTransfers: 0,
  originalAmount: 90,
  totalAssets: 150,
  totalPnL: 60,
};

const portfolioB: PortfolioBreakdownSnapshot = {
  wallet: 300,
  positions: 10,
  available: 300,
  netPeerTransfers: 0,
  originalAmount: 250,
  totalAssets: 310,
  totalPnL: 60,
};

describe('widgetCacheStore portfolio widget cache', () => {
  beforeEach(() => {
    useWidgetCacheStore.getState().clearAll();
  });

  it('stores portfolio widget data per user', () => {
    useWidgetCacheStore.getState().setPortfolioWidget('user-a', portfolioA);
    useWidgetCacheStore.getState().setPortfolioWidget('user-b', portfolioB);

    expect(useWidgetCacheStore.getState().getPortfolioWidget('user-a')).toEqual(
      portfolioA
    );
    expect(useWidgetCacheStore.getState().getPortfolioWidget('user-b')).toEqual(
      portfolioB
    );
  });

  it('clears only the requested user portfolio widget cache', () => {
    useWidgetCacheStore.getState().setPortfolioWidget('user-a', portfolioA);
    useWidgetCacheStore.getState().setPortfolioWidget('user-b', portfolioB);

    useWidgetCacheStore.getState().clearPortfolioWidget('user-a');

    expect(useWidgetCacheStore.getState().getPortfolioWidget('user-a')).toBe(
      null
    );
    expect(useWidgetCacheStore.getState().getPortfolioWidget('user-b')).toEqual(
      portfolioB
    );
  });
});
