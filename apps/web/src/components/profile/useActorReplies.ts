import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProfileReply } from '@/components/profile/ProfileReplyCard';
import { useAuth } from '@/hooks/useAuth';

const PAGE_SIZE = 100;

interface UseActorRepliesResult {
  replies: ProfileReply[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number | null;
  loadFailed: boolean;
  loadMore: () => Promise<void>;
  clearLoadFailed: () => void;
  refresh: () => Promise<void>;
}

function sortReplies(replies: ProfileReply[]): ProfileReply[] {
  return [...replies].sort(
    (a, b) =>
      new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * Load an actor's profile replies from
 * GET /api/users/[id]/posts?type=replies, following the API's `page` past
 * the first page like useActorPosts follows the cursor for posts. The route
 * already returns `total` (the full visible reply count) and validates
 * `page`/`limit`; the profile page used to fetch page 1 once and never
 * continue, so replies past the first 100 were unreachable on the profile
 * even though the header counts them all.
 */
export function useActorReplies(
  actorId: string | null,
  enabled = true
): UseActorRepliesResult {
  const { getAccessToken } = useAuth();
  const [replies, setReplies] = useState<ProfileReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loadFailed, setLoadFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const repliesRef = useRef<ProfileReply[]>([]);

  const fetchPage = useCallback(
    async (requestPage: number) => {
      const append = requestPage > 1;
      if (!actorId || !enabled || (append && request.current)) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const token = await getAccessToken();
        if (controller.signal.aborted) return;
        const headers: HeadersInit = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const params = new URLSearchParams({
          type: 'replies',
          page: String(requestPage),
          limit: String(PAGE_SIZE),
        });
        const response = await fetch(
          `/api/users/${encodeURIComponent(actorId)}/posts?${params}`,
          { headers, signal: controller.signal }
        );
        if (!response.ok) {
          // A failed continuation keeps its page, but the auto-load must
          // not retry it in a tight loop while the sentinel stays in view.
          // The observer clears this when the sentinel leaves the viewport.
          if (append) setLoadFailed(true);
          return;
        }
        const data = (await response.json()) as {
          data?: { items?: unknown; total?: unknown };
          items?: unknown;
          total?: unknown;
        };
        if (controller.signal.aborted) return;
        const payload = data?.data ?? data;
        const pageItems = Array.isArray(payload?.items)
          ? (payload.items as ProfileReply[])
          : [];
        const pageTotal =
          typeof payload?.total === 'number' ? payload.total : null;
        const combined = append
          ? [...repliesRef.current, ...pageItems]
          : pageItems;
        const deduped = sortReplies(
          Array.from(
            new Map(combined.map((reply) => [reply.id, reply])).values()
          )
        );
        repliesRef.current = deduped;
        setReplies(deduped);
        setTotal(pageTotal);
        setPage(requestPage);
        setHasMore(
          pageItems.length > 0 &&
            (pageTotal !== null
              ? deduped.length < pageTotal
              : pageItems.length === PAGE_SIZE)
        );
        setLoadFailed(false);
      } catch {
        // Keep the last successful page (and its page number) after a
        // failure, so the continuation stays retryable. An aborted request
        // (actor change or unmount) is not a failure.
        if (append && !controller.signal.aborted) setLoadFailed(true);
      } finally {
        if (request.current === controller) {
          request.current = null;
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [actorId, enabled, getAccessToken]
  );

  useEffect(() => {
    repliesRef.current = [];
    setReplies([]);
    setHasMore(false);
    setTotal(null);
    setPage(1);
    setLoadingMore(false);
    setLoadFailed(false);
    if (actorId && enabled) void fetchPage(1);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [actorId, enabled, fetchPage]);

  const loadMore = useCallback(async () => {
    if (hasMore && !loadFailed) await fetchPage(page + 1);
  }, [hasMore, page, fetchPage, loadFailed]);
  const clearLoadFailed = useCallback(() => setLoadFailed(false), []);
  const refresh = useCallback(() => fetchPage(1), [fetchPage]);

  return {
    replies,
    loading,
    loadingMore,
    hasMore,
    total,
    loadFailed,
    loadMore,
    clearLoadFailed,
    refresh,
  };
}
