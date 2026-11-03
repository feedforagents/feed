import { describe, expect, it } from 'bun:test';
import { buildPnlHistoryUrl } from './usePnlHistory';

describe('buildPnlHistoryUrl', () => {
  it('requests the signed-in owner history', () => {
    expect(
      buildPnlHistoryUrl({ scope: 'owner', timeframe: '4H', userId: 'owner-1' })
    ).toBe('/api/users/owner-1/pnl-history?range=4H&scope=owner');
  });
});
