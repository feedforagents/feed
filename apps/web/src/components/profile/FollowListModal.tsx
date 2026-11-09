'use client';

import { cn, getProfileUrl } from '@feed/shared';
import { Loader2, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { VerifiedBadge } from '@/components/shared/VerifiedBadge';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

/**
 * FollowListModal component for displaying followers or following lists.
 *
 * Shows a scrollable list of users with their avatars, names, and follow/unfollow
 * buttons. Loads one page of 100 users at a time and keeps loading further
 * pages as the user scrolls, so every follower/following account is reachable
 * and the header shows the API's total relation count.
 *
 * @param props - FollowListModal component props
 * @returns Follow list modal element or null if not open
 *
 * @example
 * ```tsx
 * <FollowListModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   userId="user-123"
 *   type="followers"
 *   title="Followers"
 * />
 * ```
 */

interface FollowUser {
  id: string;
  displayName: string;
  username: string | null;
  profileImageUrl: string | null;
  bio: string | null;
  isActor: boolean;
  followedAt: string;
  tier?: string | null;
  viewerFollows?: boolean;
}

interface FollowListModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  type: 'followers' | 'following';
  title?: string;
}

export function FollowListModal({
  isOpen,
  onClose,
  userId,
  type,
  title,
}: FollowListModalProps) {
  const { authenticated, user, getAccessToken } = useAuth();
  const [users, setUsers] = useState<FollowUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a later page fails: loaded rows stay, the sentinel hides so a
  // transient failure is not retried in a loop, and the user retries
  // deliberately. Only the first-page `error` shows the full-screen retry.
  const [pageError, setPageError] = useState<string | null>(null);
  const [followingStatus, setFollowingStatus] = useState<
    Record<string, boolean>
  >({});
  const [loadingFollow, setLoadingFollow] = useState<Record<string, boolean>>(
    {}
  );

  // AbortController ref for cancelling pending requests
  const abortControllerRef = useRef<AbortController | null>(null);
  // Pagination state that callbacks/observers read without re-binding
  const pageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  // Incremented on every fresh load so stale page fetches cannot append
  const sessionRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const displayTitle =
    title || (type === 'followers' ? 'Followers' : 'Following');

  // Initialize following status for a page of users
  // viewerFollows indicates if the current user follows each person in the list
  const buildStatusMap = useCallback(
    (list: FollowUser[]) => {
      const statusMap: Record<string, boolean> = {};
      if (authenticated && user) {
        for (const u of list) {
          if (type === 'following' && userId === user.id) {
            // Viewing own following list - current user follows everyone in this list
            statusMap[u.id] = true;
          } else {
            // Viewing followers or someone else's following list
            statusMap[u.id] = u.viewerFollows || false;
          }
        }
      }
      return statusMap;
    },
    [authenticated, user, type, userId]
  );

  const fetchPage = useCallback(
    async (page: number, signal: AbortSignal) => {
      const token = await getAccessToken();
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(
        apiUrl(
          `/api/users/${encodeURIComponent(userId)}/${type}?page=${page}&limit=100`
        ),
        { headers, signal }
      );
      if (!response.ok) {
        throw new Error('Failed to load list');
      }
      const data = await response.json();
      const list: FollowUser[] =
        (type === 'followers' ? data.followers : data.following) || [];
      return {
        list,
        count: typeof data.count === 'number' ? data.count : list.length,
        hasMore: Boolean(data.hasMore),
      };
    },
    [getAccessToken, type, userId]
  );

  // Fetch the first page when the modal opens
  const fetchList = useCallback(async () => {
    if (!isOpen || !userId) return;

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new AbortController for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const session = ++sessionRef.current;

    setIsLoading(true);
    setError(null);
    setPageError(null);
    pageRef.current = 1;
    hasMoreRef.current = false;
    loadingMoreRef.current = false;
    setIsLoadingMore(false);
    setHasMore(false);
    setTotalCount(null);

    try {
      const {
        list,
        count,
        hasMore: more,
      } = await fetchPage(1, abortController.signal);
      if (session !== sessionRef.current) return;
      setUsers(list);
      setTotalCount(count);
      hasMoreRef.current = more;
      setHasMore(more);
      setFollowingStatus(buildStatusMap(list));
      setIsLoading(false);
    } catch (err) {
      // Ignore abort errors - they're expected when cancelling requests
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (session !== sessionRef.current) return;
      setError(
        err instanceof Error && err.message === 'Failed to load list'
          ? 'Failed to load list'
          : 'Network error. Please try again.'
      );
      setIsLoading(false);
    }
  }, [isOpen, userId, fetchPage, buildStatusMap]);

  // Fetch and append the next page (triggered by the scroll sentinel)
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const session = sessionRef.current;
    const nextPage = pageRef.current + 1;

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    // A fresh attempt clears the previous page failure.
    setPageError(null);

    try {
      const {
        list,
        count,
        hasMore: more,
      } = await fetchPage(nextPage, abortController.signal);
      if (session !== sessionRef.current) return;
      pageRef.current = nextPage;
      hasMoreRef.current = more;
      setHasMore(more);
      setTotalCount(count);
      setUsers((prev) => {
        const seen = new Set(prev.map((u) => u.id));
        return [...prev, ...list.filter((u) => !seen.has(u.id))];
      });
      setFollowingStatus((prev) => ({ ...prev, ...buildStatusMap(list) }));
    } catch {
      // Keep the rows already shown and keep the failed page retryable:
      // hide the sentinel so a transient failure is not retried in a loop
      // by the observer, but leave hasMoreRef true so a deliberate retry
      // can request the same page again.
      if (session === sessionRef.current) {
        setPageError('Failed to load more. Please try again.');
        setHasMore(false);
      }
    } finally {
      if (session === sessionRef.current) {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [fetchPage, buildStatusMap]);

  // Deliberate retry for the failed page, from the same open modal.
  // loadMore re-requests pageRef.current + 1, which is still the failed
  // page because the catch above never advanced pageRef.
  const retryLoadMore = useCallback(() => {
    setPageError(null);
    void loadMore();
  }, [loadMore]);

  // Load the next page when the end of the loaded list scrolls into view
  useEffect(() => {
    if (!loadMoreRef.current || !hasMore || isLoadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loadMore]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Load the first page once per opened list. fetchList is re-created
  // whenever auth state settles (getAccessToken / buildStatusMap change
  // identity on every profile refetch), so an effect on [fetchList]
  // refetched page 1 in a loop while signed in and the list never settled:
  // 41 page-1 requests in one open modal, count never shown. Depend on the
  // stable inputs instead and always call the latest fetchList. A flip of
  // `authenticated` still refetches once, so follow buttons are correct
  // once the viewer is known.
  const fetchListRef = useRef(fetchList);
  fetchListRef.current = fetchList;

  // biome-ignore lint/correctness/useExhaustiveDependencies: userId, type and authenticated intentionally re-trigger the walk when the opened list or the viewer changes, even though the effect body reads them only through the ref
  useEffect(() => {
    if (isOpen) {
      void fetchListRef.current();
    }
  }, [isOpen, userId, type, authenticated]);

  // Handle body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
    }
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const handleFollow = async (targetUserId: string) => {
    if (!authenticated || !user) {
      toast.error('Please sign in to follow users');
      return;
    }

    if (targetUserId === user.id) {
      return;
    }

    setLoadingFollow((prev) => ({ ...prev, [targetUserId]: true }));

    const token = await getAccessToken();
    if (!token) {
      toast.error('Authentication required');
      setLoadingFollow((prev) => ({ ...prev, [targetUserId]: false }));
      return;
    }

    const isCurrentlyFollowing = followingStatus[targetUserId] ?? false;
    const method = isCurrentlyFollowing ? 'DELETE' : 'POST';

    // Optimistic update
    setFollowingStatus((prev) => ({
      ...prev,
      [targetUserId]: !isCurrentlyFollowing,
    }));

    try {
      const response = await fetch(
        apiUrl(`/api/users/${encodeURIComponent(targetUserId)}/follow`),
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        // Revert optimistic update
        setFollowingStatus((prev) => ({
          ...prev,
          [targetUserId]: isCurrentlyFollowing,
        }));
        toast.error('Failed to update follow status');
      } else {
        // Dispatch event to update profile stats
        window.dispatchEvent(
          new CustomEvent('profile-updated', {
            detail: { type: isCurrentlyFollowing ? 'unfollow' : 'follow' },
          })
        );
        // An unfollow on the viewer's own Following list shrinks the roster
        // the API slices by offset, so the loaded walk is stale: the
        // unfollowed row stays in the list and the next page would skip a
        // row. Restart the walk when more pages may exist; otherwise drop
        // the row locally and adjust the total.
        if (
          isCurrentlyFollowing &&
          type === 'following' &&
          userId === user.id
        ) {
          const morePagesMayExist =
            hasMoreRef.current ||
            (totalCount !== null && totalCount > users.length);
          if (morePagesMayExist) {
            void fetchList();
          } else {
            setUsers((prev) => prev.filter((u) => u.id !== targetUserId));
            setTotalCount((prev) =>
              prev === null ? prev : Math.max(0, prev - 1)
            );
          }
        }
      }
    } catch {
      // Revert optimistic update on network error
      setFollowingStatus((prev) => ({
        ...prev,
        [targetUserId]: isCurrentlyFollowing,
      }));
      toast.error('Network error. Please try again.');
    }

    setLoadingFollow((prev) => ({ ...prev, [targetUserId]: false }));
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm md:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="follow-list-modal-title"
      onClick={onClose}
    >
      {/* Modal */}
      <div
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[80vh] md:w-auto md:min-w-[480px] md:max-w-md md:rounded-2xl md:border md:border-border md:shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h2
              id="follow-list-modal-title"
              className="font-bold text-foreground text-xl"
            >
              {displayTitle}
            </h2>
            {!isLoading && (
              <span className="text-muted-foreground text-sm">
                ({totalCount ?? users.length})
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted/50"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground">{error}</p>
              <button
                onClick={fetchList}
                className="mt-4 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Try again
              </button>
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">
                {type === 'followers'
                  ? 'No followers yet'
                  : 'Not following anyone yet'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {users.map((followUser) => {
                const isOwnProfile = user?.id === followUser.id;
                const isFollowing = followingStatus[followUser.id] || false;
                const isLoadingThis = loadingFollow[followUser.id] || false;
                const profileUrl = getProfileUrl(
                  followUser.id,
                  followUser.username
                );

                return (
                  <div
                    key={followUser.id}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                  >
                    {/* Avatar */}
                    <Link href={profileUrl} onClick={onClose}>
                      <Avatar
                        id={followUser.id}
                        name={followUser.displayName}
                        type={followUser.isActor ? 'actor' : 'user'}
                        src={followUser.profileImageUrl || undefined}
                        size="md"
                        className="flex-shrink-0"
                      />
                    </Link>

                    {/* User Info */}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={profileUrl}
                        onClick={onClose}
                        className="group flex items-center gap-1"
                      >
                        <span className="truncate font-semibold text-foreground group-hover:underline">
                          {followUser.displayName}
                        </span>
                        {followUser.isActor && <VerifiedBadge size="sm" />}
                      </Link>
                      {followUser.username && (
                        <p className="truncate text-muted-foreground text-sm">
                          @{followUser.username}
                        </p>
                      )}
                    </div>

                    {/* Follow Button */}
                    {authenticated && !isOwnProfile && (
                      <button
                        onClick={() => handleFollow(followUser.id)}
                        disabled={isLoadingThis}
                        className={cn(
                          'group relative flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 font-bold text-sm transition-all duration-200',
                          isFollowing
                            ? 'border-border bg-background text-foreground hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-500'
                            : 'border-[#0066FF] bg-[#0066FF] text-primary-foreground hover:bg-[#0052CC]',
                          isLoadingThis && 'cursor-not-allowed opacity-50'
                        )}
                      >
                        {isLoadingThis ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : isFollowing ? (
                          <>
                            <span className="group-hover:hidden">
                              Following
                            </span>
                            <span className="hidden group-hover:inline">
                              Unfollow
                            </span>
                          </>
                        ) : (
                          <span>Follow</span>
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Scroll sentinel: intersecting it loads the next page */}
              {hasMore && (
                <div
                  ref={loadMoreRef}
                  className="flex items-center justify-center py-4"
                >
                  {isLoadingMore && (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  )}
                </div>
              )}
              {/* Later-page failure: keep the loaded rows and offer a
                  deliberate retry for the failed page, without closing
                  and reopening the modal. */}
              {pageError && !isLoadingMore && (
                <div className="flex flex-col items-center justify-center py-4 text-center">
                  <p className="text-muted-foreground text-sm">{pageError}</p>
                  <button
                    onClick={retryLoadMore}
                    className="mt-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
