import type { FeedPost } from '@feed/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';

const PAGE_SIZE = 20;
const PAGE_RETRY_DELAY_MS = 1000;

interface UseFollowingPostsOptions {
  enabled?: boolean;
}

interface UseFollowingPostsResult {
  posts: FeedPost[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  cursor: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface FollowingPage {
  viewerId: string;
  posts: FeedPost[];
  cursor: string | null;
}

/** Load the signed-in viewer's Following feed using the server's cursor. */
export function useFollowingPosts(
  options: UseFollowingPostsOptions = {}
): UseFollowingPostsResult {
  const { enabled = true } = options;
  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const viewerId = enabled && authenticated ? user?.id : undefined;

  const [page, setPage] = useState<FollowingPage | null>(null);
  const [pending, setPending] = useState<{
    viewerId: string;
    append: boolean;
  } | null>(null);
  const request = useRef<AbortController | null>(null);
  const retryAfter = useRef(0);

  const fetchFollowingPosts = useCallback(
    async (requestCursor: string | null) => {
      const append = requestCursor !== null;
      if (
        !viewerId ||
        (append && (request.current || Date.now() < retryAfter.current))
      )
        return;

      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPending({ viewerId, append });
      if (!append) retryAfter.current = 0;
      let succeeded = false;

      try {
        const token = await getAccessToken();
        if (!token || controller.signal.aborted) return;
        const params = new URLSearchParams({
          following: 'true',
          userId: viewerId,
          limit: String(PAGE_SIZE),
        });
        if (requestCursor !== null) params.set('cursor', requestCursor);
        const response = await fetch(apiUrl(`/api/posts?${params}`), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data: { posts: FeedPost[]; nextCursor?: string | null } =
          await response.json();
        if (controller.signal.aborted) return;

        setPage((previous) => {
          const combined =
            append && previous?.viewerId === viewerId
              ? [...previous.posts, ...data.posts]
              : data.posts;
          const unique = new Map(combined.map((post) => [post.id, post]));
          const posts = Array.from(unique.values()).sort(
            (a, b) =>
              new Date(b.timestamp ?? 0).getTime() -
              new Date(a.timestamp ?? 0).getTime()
          );
          return { viewerId, posts, cursor: data.nextCursor ?? null };
        });
        succeeded = true;
      } catch {
        // Keep the last successful page available after a network failure.
      } finally {
        if (request.current === controller) {
          // The observer can run again as soon as loadingMore clears.
          if (append && !succeeded)
            retryAfter.current = Date.now() + PAGE_RETRY_DELAY_MS;
          request.current = null;
          setPending(null);
        }
      }
    },
    [viewerId, getAccessToken]
  );

  useEffect(() => {
    setPage(null);
    setPending(null);
    if (viewerId) void fetchFollowingPosts(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [viewerId, fetchFollowingPosts]);

  // Render only data for the current viewer, even before effect cleanup runs.
  const visiblePage = page?.viewerId === viewerId ? page : null;
  const visibleRequest = pending?.viewerId === viewerId ? pending : null;
  const cursor = visiblePage?.cursor ?? null;
  const loadMore = useCallback(async () => {
    if (cursor !== null) await fetchFollowingPosts(cursor);
  }, [cursor, fetchFollowingPosts]);
  const refresh = useCallback(
    () => fetchFollowingPosts(null),
    [fetchFollowingPosts]
  );

  return {
    posts: visiblePage?.posts ?? [],
    loading: Boolean(visibleRequest && !visibleRequest.append),
    loadingMore: Boolean(visibleRequest?.append),
    hasMore: cursor !== null,
    cursor,
    loadMore,
    refresh,
  };
}
