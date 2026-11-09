import type { PredictionMarket } from '@/types/markets';

export type PredictionSort = 'question' | 'probability' | 'volume' | 'timeLeft';

/** Valid YES probability in [0, 1], or null when unavailable. */
export function getYesProbability(market: PredictionMarket): number | null {
  const p = market.yesProbability;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    return null;
  }
  return p;
}

/** End time in ms, or null when missing or unparseable. */
export function getEndTime(endDate: string | null | undefined): number | null {
  if (!endDate) return null;
  const t = new Date(endDate).getTime();
  return Number.isFinite(t) ? t : null;
}

export function formatTimeLeft(
  endDate: string | null | undefined,
  now: number = Date.now()
): string {
  const end = getEndTime(endDate);
  if (end === null) return '--';
  const diff = end - now;
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(diff / 60_000);
  return `${mins}m`;
}

/**
 * Traded volume from the positions ledger, as reported by the list API.
 * Pool share balances (yesShares + noShares) are not volume: a seeded,
 * never-traded market would outrank markets with real trades.
 */
function tradedVolume(market: PredictionMarket): number {
  return Number(market.volume ?? 0);
}

/**
 * Compare nullable numbers so that missing values sort last regardless of
 * direction. Returns 0 when both are missing or equal.
 */
function compareNullable(
  a: number | null,
  b: number | null,
  dir: 1 | -1
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir * (a - b);
}

export function sortPredictionMarkets(
  markets: readonly PredictionMarket[],
  sort: PredictionSort,
  desc: boolean
): PredictionMarket[] {
  const dir: 1 | -1 = desc ? -1 : 1;
  return [...markets].sort((a, b) => {
    let byKey: number;
    switch (sort) {
      case 'question':
        byKey = dir * a.text.localeCompare(b.text);
        break;
      case 'probability':
        byKey = compareNullable(
          getYesProbability(a),
          getYesProbability(b),
          dir
        );
        break;
      case 'volume':
        byKey = dir * (tradedVolume(a) - tradedVolume(b));
        break;
      case 'timeLeft':
        byKey = compareNullable(
          getEndTime(a.endDate),
          getEndTime(b.endDate),
          dir
        );
        break;
    }
    if (byKey !== 0) return byKey;
    return String(a.id).localeCompare(String(b.id));
  });
}
