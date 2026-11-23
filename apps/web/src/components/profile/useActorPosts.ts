import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 100;

export interface ActorPost {
  id: string;
  content: string;
  author: string;
  authorId: string;
  timestamp: string;
  authorName?: string;
  authorUsername?: string | null;
  authorProfileImageUrl?: string | null;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  isLiked?: boolean;
  isShared?: boolean;
  isRepost?: boolean;
  isQuote?: boolean;
  quoteComment?: string | null;
  originalPostId?: string | null;
  originalPost?: {
    id: string;
    content: string;
    authorId: string;
    authorName: string;
    authorUsername: string | null;
    authorProfileImageUrl: string | null;
    timestamp: string;
  } | null;
}

interface UseActorPostsResult {
  posts: ActorPost[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  cursor: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Load an actor's profile posts from GET /api/posts?actorId=…, following the
 * API's cursor past the first page like useFollowingPosts does. The route
 * already returns `cursor`/`hasMore` for the actor branch; the profile page
 * used to fetch page 1 once (limit 100) and never continue, so posts past
 * the first 100 were unreachable on the profile even though the header
 * counts them all.
 */
export function useActorPosts(actorId: string | null): UseActorPostsResult {
  const [posts, setPosts] = useState<ActorPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (requestCursor: string | null) => {
      const append = requestCursor !== null;
      if (!actorId || (append && request.current)) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const params = new URLSearchParams({
          actorId,
          limit: String(PAGE_SIZE),
        });
        if (requestCursor !== null) params.set('cursor', requestCursor);
        const response = await fetch(`/api/posts?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          posts?: unknown;
          cursor?: string | null;
          hasMore?: boolean;
        };
        if (controller.signal.aborted) return;
        if (data.posts && Array.isArray(data.posts)) {
          const pagePosts = data.posts as ActorPost[];
          setPosts((previous) => {
            const combined = append ? [...previous, ...pagePosts] : pagePosts;
            const unique = new Map(combined.map((post) => [post.id, post]));
            return Array.from(unique.values()).sort(
              (a, b) =>
                new Date(b.timestamp ?? 0).getTime() -
                new Date(a.timestamp ?? 0).getTime()
            );
          });
        }
        setCursor(data.cursor ?? null);
        setHasMore(data.hasMore === true);
      } catch {
        // Keep the last successful page (and its cursor) after a failure,
        // so the continuation stays retryable.
      } finally {
        if (request.current === controller) {
          request.current = null;
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [actorId]
  );

  useEffect(() => {
    setPosts([]);
    setCursor(null);
    setHasMore(false);
    if (actorId) void fetchPage(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [actorId, fetchPage]);

  const loadMore = useCallback(async () => {
    if (cursor !== null) await fetchPage(cursor);
  }, [cursor, fetchPage]);
  const refresh = useCallback(() => fetchPage(null), [fetchPage]);

  return {
    posts,
    loading,
    loadingMore,
    hasMore,
    cursor,
    loadMore,
    refresh,
  };
}
