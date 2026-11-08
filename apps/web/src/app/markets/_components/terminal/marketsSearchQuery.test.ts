import { describe, expect, it } from 'bun:test';
import { parseSearchQuery } from './MarketsTradingTerminal';

describe('parseSearchQuery', () => {
  it('reads the search param that cashtag links produce', () => {
    expect(parseSearchQuery(new URLSearchParams('search=BTC'))).toBe('BTC');
  });

  it('decodes percent-encoded symbols', () => {
    expect(parseSearchQuery(new URLSearchParams('search=BRK%2FB'))).toBe(
      'BRK/B'
    );
  });

  it('returns an empty string when the param is absent or empty', () => {
    expect(parseSearchQuery(new URLSearchParams('filter=all'))).toBe('');
    expect(parseSearchQuery(new URLSearchParams('search='))).toBe('');
  });
});
