export type PnlHistoryRange = '1H' | '4H' | '1D' | '1W' | 'ALL';
export type PnlHistoryScope = 'owner';

export interface PnlHistoryPoint {
  time: number;
  value: number;
}

export interface UserPnlMetrics {
  userId: string;
  lifetimePnL: number;
  unrealizedPnL: number;
  currentPnL: number;
}
