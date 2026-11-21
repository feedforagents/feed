import type { FeedPost } from '@feed/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';

const PAGE_SIZE = 20;

interface UseFollowingPostsOptions {
  enabled?: boolean;
}

interface UseFollowingPostsResult {
  posts: FeedPost[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  cursor: string | null;
  fetchFollowingPosts: (
    cursor: string | null,
    append?: boolean
  ) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching posts from followed users/actors
 *
 * Requires authentication - returns empty if not logged in.
 *
 * Cursor-paginated like the Latest tab (`useFeedPosts`): the API returns
 * `nextCursor` for `GET /api/posts?following=true`, and `loadMore`
 * follows it, so followed users' posts past the first page are reachable.
 * Previously this hook fetched page 1 once and never paginated, which
 * capped the Following tab at 20 posts.
 */
export function useFollowingPosts(
  options: UseFollowingPostsOptions = {}
): UseFollowingPostsResult {
  const { enabled = true } = options;

  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();

  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const initialFetchDone = useRef(false);

  const fetchFollowingPosts = useCallback(
    async (requestCursor: string | null, append = false) => {
      const userId = user?.id;
      if (!enabled || !authenticated || !userId) {
        if (!append) setPosts([]);
        return;
      }

      // Prevent duplicate page appends
      if (append && loadingMoreRef.current) return;

      if (append) {
        setLoadingMore(true);
        loadingMoreRef.current = true;
      } else {
        setLoading(true);
      }

      try {
        const token = await getAccessToken();

        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const url = requestCursor
          ? apiUrl(
              `/api/posts?following=true&userId=${userId}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(requestCursor)}`
            )
          : apiUrl(
              `/api/posts?following=true&userId=${userId}&limit=${PAGE_SIZE}&offset=0`
            );

        const response = await fetch(url, { headers });

        if (response.ok) {
          const data = await response.json();
          const newPosts = data.posts as FeedPost[];
          const nextCursor = (data.nextCursor as string | null) ?? null;
          setPosts((prev) => {
            const combined = append ? [...prev, ...newPosts] : newPosts;
            const unique = new Map<string, FeedPost>();
            combined.forEach((post) => unique.set(post.id, post));
            return Array.from(unique.values()).sort((a, b) => {
              const aTime = new Date(a.timestamp ?? 0).getTime();
              const bTime = new Date(b.timestamp ?? 0).getTime();
              return bTime - aTime;
            });
          });
          setCursor(nextCursor);
          // The endpoint's nextCursor is the pagination signal: a page
          // shortened by moderation filtering can still have a next page.
          setHasMore(nextCursor !== null);
        } else if (append) {
          setHasMore(false);
        }
      } catch {
        // Network error - no action needed
        if (append) setHasMore(false);
      } finally {
        if (append) {
          setLoadingMore(false);
          loadingMoreRef.current = false;
        } else {
          setLoading(false);
        }
      }
    },
    [enabled, authenticated, user?.id, getAccessToken]
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMoreRef.current) return;
    await fetchFollowingPosts(cursor, true);
  }, [cursor, fetchFollowingPosts]);

  const refresh = useCallback(async () => {
    await fetchFollowingPosts(null, false);
  }, [fetchFollowingPosts]);

  // Fetch on mount when enabled and authenticated. Only mark the
  // initial fetch done when a fetch actually starts: auth may arrive
  // after the first effect run, and the effect must retry then.
  useEffect(() => {
    if (!enabled) {
      initialFetchDone.current = false;
      setLoading(false);
      return;
    }
    if (initialFetchDone.current) return;
    if (enabled && authenticated && user?.id) {
      initialFetchDone.current = true;
      void fetchFollowingPosts(null, false);
    }
  }, [enabled, authenticated, user?.id, fetchFollowingPosts]);

  return {
    posts,
    loading,
    loadingMore,
    hasMore,
    cursor,
    fetchFollowingPosts,
    loadMore,
    refresh,
  };
}
