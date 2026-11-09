import { describe, expect, it } from 'bun:test';
import type { PredictionMarket } from '@/types/markets';
import {
  formatTimeLeft,
  getYesProbability,
  sortPredictionMarkets,
} from './predictionDashboard';

function market(
  id: string,
  overrides: Partial<PredictionMarket> = {}
): PredictionMarket {
  return {
    id,
    text: `Market ${id}`,
    status: 'active',
    scenario: 1,
    ...overrides,
  };
}

describe('predictionDashboard', () => {
  it('treats missing/invalid probability as unavailable, not 0 or 50%', () => {
    expect(getYesProbability(market('a'))).toBeNull();
    expect(
      getYesProbability(market('a', { yesProbability: Number.NaN }))
    ).toBeNull();
    expect(getYesProbability(market('a', { yesProbability: 1.5 }))).toBeNull();
    expect(getYesProbability(market('a', { yesProbability: 0 }))).toBe(0);
  });

  it('sorts missing probability last in both directions', () => {
    const items = [
      market('missing'),
      market('zero', { yesProbability: 0 }),
      market('high', { yesProbability: 0.8 }),
    ];
    expect(
      sortPredictionMarkets(items, 'probability', false).map((m) => m.id)
    ).toEqual(['zero', 'high', 'missing']);
    expect(
      sortPredictionMarkets(items, 'probability', true).map((m) => m.id)
    ).toEqual(['high', 'zero', 'missing']);
  });

  it('sorts missing or invalid end dates last in both directions', () => {
    const items = [
      market('none'),
      market('bad', { endDate: 'not-a-date' }),
      market('soon', { endDate: '2026-01-01T00:00:00.000Z' }),
      market('later', { endDate: '2027-01-01T00:00:00.000Z' }),
    ];
    const asc = sortPredictionMarkets(items, 'timeLeft', false).map(
      (m) => m.id
    );
    const desc = sortPredictionMarkets(items, 'timeLeft', true).map(
      (m) => m.id
    );
    expect(asc.slice(0, 2)).toEqual(['soon', 'later']);
    expect(desc.slice(0, 2)).toEqual(['later', 'soon']);
    expect(new Set(asc.slice(2))).toEqual(new Set(['none', 'bad']));
  });

  it('breaks ties deterministically by id', () => {
    const items = [
      market('b', { yesProbability: 0.5 }),
      market('a', { yesProbability: 0.5 }),
    ];
    expect(
      sortPredictionMarkets(items, 'probability', true).map((m) => m.id)
    ).toEqual(['a', 'b']);
  });

  it('sorts by traded volume, not pool share balances', () => {
    // The idle market holds the deeper pool but never traded; the traded
    // market's pool is smaller while its ledger volume is real. Volume
    // sort must follow the traded volume (positions ledger), so the
    // traded market wins descending order despite its smaller pool.
    const items = [
      market('idle', { yesShares: 10000, noShares: 10000, volume: 0 }),
      market('traded', { yesShares: 2200, noShares: 2200, volume: 499.5 }),
    ];
    expect(
      sortPredictionMarkets(items, 'volume', true).map((m) => m.id)
    ).toEqual(['traded', 'idle']);
    expect(
      sortPredictionMarkets(items, 'volume', false).map((m) => m.id)
    ).toEqual(['idle', 'traded']);
  });

  it('formats invalid dates as unavailable instead of NaN', () => {
    expect(formatTimeLeft('not-a-date')).toBe('--');
    expect(formatTimeLeft(null)).toBe('--');
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(formatTimeLeft('2026-01-03T01:00:00.000Z', now)).toBe('2d');
    expect(formatTimeLeft('2025-12-31T00:00:00.000Z', now)).toBe('Ended');
  });
});
