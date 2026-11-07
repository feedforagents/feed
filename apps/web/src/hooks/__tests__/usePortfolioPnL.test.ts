import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fetchPortfolioBreakdownSnapshot } from '../usePortfolioPnL';

describe('fetchPortfolioBreakdownSnapshot', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes the portfolio breakdown payload', async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(
        JSON.stringify({
          wallet: '12.5',
          positions: '4.5',
          available: '12.5',
          originalAmount: '10',
          totalAssets: '17',
          totalPnL: '7',
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await fetchPortfolioBreakdownSnapshot('user-1');

    expect(snapshot).toEqual({
      wallet: 12.5,
      positions: 4.5,
      available: 12.5,
      netPeerTransfers: 0,
      originalAmount: 10,
      totalAssets: 17,
      totalPnL: 7,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps non-ok responses to the existing generic fetch error', async () => {
    globalThis.fetch = mock().mockResolvedValue(
      new Response('{}', { status: 503 })
    ) as unknown as typeof fetch;

    await expect(fetchPortfolioBreakdownSnapshot('user-1')).rejects.toThrow(
      'Failed to fetch portfolio breakdown'
    );
  });
});
