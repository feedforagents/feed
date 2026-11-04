import type { LeaderboardMetric, LeaderboardScope } from '@feed/shared';

export interface LeaderboardUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  balance: number;
  lifetimePnL: number;
  capitalBase?: number;
  effectiveCapitalBase?: number;
  tradingReturn?: number;
  /** ISO timestamp (JSON). */
  createdAt: string;
  rank: number;
  isAgent?: boolean;
  managedBy?: string | null;
  nftTokenId?: number | null;
}

export interface CurrentUserPosition {
  rank: number;
  page: number;
  entry: LeaderboardUser;
}

export interface LeaderboardData {
  leaderboard: LeaderboardUser[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
  leaderboardType: LeaderboardScope;
  leaderboardMetric: LeaderboardMetric;
  currentUser: CurrentUserPosition | null;
  followingUserIds: string[];
  followingUserIdsResolved: boolean;
  generatedAt?: string;
}

export class LeaderboardFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'LeaderboardFetchError';
  }
}

export type FetchLeaderboardOptions = {
  currentPage: number;
  pageSize: number;
  selectedMetric: LeaderboardMetric;
  selectedScope: LeaderboardScope;
  userId?: string;
  authToken?: string | null;
  signal?: AbortSignal;
};

function buildLeaderboardUrl({
  currentPage,
  pageSize,
  selectedMetric,
  selectedScope,
  userId,
}: Omit<FetchLeaderboardOptions, 'signal' | 'authToken'>) {
  const searchParams = new URLSearchParams({
    metric: selectedMetric,
    type: selectedScope,
    page: String(currentPage),
    pageSize: String(pageSize),
  });

  if (userId) {
    searchParams.set('userId', userId);
  }

  return `/api/leaderboard?${searchParams.toString()}`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Retry policy for leaderboard queries (applied once, in the query layer):
 * network failures and 408/429/5xx are retryable; other HTTP errors and
 * aborts are not.
 */
export function isRetryableLeaderboardError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof LeaderboardFetchError) {
    return (
      error.status === undefined ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  // fetch() rejects with TypeError on network failure.
  return error instanceof TypeError;
}

/** Single attempt; retries are owned by React Query (see useLeaderboardQuery). */
export async function fetchLeaderboardData({
  currentPage,
  pageSize,
  selectedMetric,
  selectedScope,
  userId,
  authToken,
  signal,
}: FetchLeaderboardOptions): Promise<LeaderboardData> {
  const url = buildLeaderboardUrl({
    currentPage,
    pageSize,
    selectedMetric,
    selectedScope,
    userId,
  });

  const headers: HeadersInit | undefined = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : undefined;

  const response = await fetch(url, { signal, headers });
  if (!response.ok) {
    throw new LeaderboardFetchError(
      `Failed to fetch leaderboard: ${response.status}`,
      response.status
    );
  }
  return (await response.json()) as LeaderboardData;
}
