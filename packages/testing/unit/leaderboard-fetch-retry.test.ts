import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  fetchLeaderboardData,
  isRetryableLeaderboardError,
  LeaderboardFetchError,
} from '../../../apps/web/src/app/leaderboard/fetchLeaderboardData';
import {
  getLeaderboardQueryKey,
  isSameLeaderboardExceptPage,
} from '../../../apps/web/src/app/leaderboard/useLeaderboardQuery';

const emptyPage = {
  leaderboard: [],
  pagination: { page: 1, pageSize: 100, totalCount: 0, totalPages: 0 },
  leaderboardType: 'wallet',
  leaderboardMetric: 'reputation',
  currentUser: null,
};

describe('fetchLeaderboardData', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes a single attempt (retries are owned by React Query)', async () => {
    const fetchMock = mock().mockRejectedValue(
      new TypeError('Failed to fetch')
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchLeaderboardData({
        currentPage: 1,
        pageSize: 100,
        selectedMetric: 'reputation',
        selectedScope: 'wallet',
      })
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws LeaderboardFetchError with the HTTP status', async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response('{}', { status: 403 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const error = await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: 'reputation',
      selectedScope: 'wallet',
    }).catch((err: LeaderboardFetchError) => err);

    expect(error).toBeInstanceOf(LeaderboardFetchError);
    expect((error as LeaderboardFetchError).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes the authenticated user in the request URL when provided', async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(JSON.stringify(emptyPage), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchLeaderboardData({
      currentPage: 1,
      pageSize: 100,
      selectedMetric: 'trading',
      selectedScope: 'wallet',
      userId: 'user-123',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('userId=user-123');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('metric=trading');
  });
});

describe('isRetryableLeaderboardError', () => {
  it('retries network failures and transient HTTP statuses', () => {
    expect(isRetryableLeaderboardError(new TypeError('Failed to fetch'))).toBe(
      true
    );
    for (const status of [408, 429, 500, 503]) {
      expect(
        isRetryableLeaderboardError(new LeaderboardFetchError('x', status))
      ).toBe(true);
    }
  });

  it('does not retry client errors or aborts', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(
        isRetryableLeaderboardError(new LeaderboardFetchError('x', status))
      ).toBe(false);
    }
    expect(
      isRetryableLeaderboardError(new DOMException('Aborted', 'AbortError'))
    ).toBe(false);
  });
});

describe('isSameLeaderboardExceptPage', () => {
  const base = {
    metric: 'reputation' as const,
    page: 1,
    pageSize: 100,
    scope: 'wallet' as const,
    userId: 'user-a',
    authToken: 'token',
  };

  it('keeps placeholder data when only the page changes', () => {
    expect(
      isSameLeaderboardExceptPage(
        getLeaderboardQueryKey(base),
        getLeaderboardQueryKey({ ...base, page: 2 })
      )
    ).toBe(true);
  });

  it('drops placeholder data across viewer, authentication or metric changes', () => {
    const key = getLeaderboardQueryKey(base);
    expect(
      isSameLeaderboardExceptPage(
        key,
        getLeaderboardQueryKey({ ...base, userId: 'user-b' })
      )
    ).toBe(false);
    expect(
      isSameLeaderboardExceptPage(
        key,
        getLeaderboardQueryKey({ ...base, authToken: null })
      )
    ).toBe(false);
    expect(
      isSameLeaderboardExceptPage(
        key,
        getLeaderboardQueryKey({ ...base, metric: 'trading' })
      )
    ).toBe(false);
  });
});
