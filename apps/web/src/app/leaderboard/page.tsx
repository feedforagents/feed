'use client';

export const dynamic = 'force-dynamic';

import {
  formatCurrency,
  formatNumberWithSeparators,
  getProfileUrl,
  type LeaderboardMetric,
} from '@feed/shared';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Trophy,
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { LeaderboardUser } from '@/app/leaderboard/fetchLeaderboardData';
import {
  useLeaderboardQuery,
  useMyLeaderboardPosition,
  usePrefetchNextPage,
} from '@/app/leaderboard/useLeaderboardQuery';
import { FollowButton } from '@/components/interactions/FollowButton';
import type { SelectedUser } from '@/components/leaderboard/LeaderboardWidgetSidebar';
import { OnChainBadge } from '@/components/profile/OnChainBadge';
import { Avatar } from '@/components/shared/Avatar';
import { LeaderboardToggle } from '@/components/shared/LeaderboardToggle';
import { PageContainer } from '@/components/shared/PageContainer';
import { RankNumber } from '@/components/shared/RankBadge';
import { LeaderboardSkeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';

const LeaderboardWidgetSidebar = nextDynamic(
  () =>
    import('@/components/leaderboard/LeaderboardWidgetSidebar').then((m) => ({
      default: m.LeaderboardWidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  }
);

export default function LeaderboardPage() {
  const { authenticated, getAccessToken, user } = useAuth();
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedMetric, setSelectedMetric] =
    useState<LeaderboardMetric>('reputation');
  const selectedScope = 'wallet';
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  // Token is bound to the account it was issued for, so an A->B switch never
  // sends A's token with B's userId while B's token is resolving.
  const [resolvedToken, setResolvedToken] = useState<{
    userId: string;
    token: string | null;
  } | null>(null);
  // Bumped on each "jump to my position" so re-jumping to the current page
  // still scrolls.
  const [scrollRequest, setScrollRequest] = useState<{
    page: number;
    nonce: number;
  } | null>(null);

  const pageSize = 100;
  const authenticatedUserId = authenticated ? user?.id : undefined;
  const authToken =
    resolvedToken && resolvedToken.userId === authenticatedUserId
      ? resolvedToken.token
      : null;

  useEffect(() => {
    if (!authenticatedUserId) {
      setResolvedToken(null);
      return;
    }
    let cancelled = false;
    getAccessToken()
      .then((token) => {
        if (!cancelled)
          setResolvedToken({ userId: authenticatedUserId, token });
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedToken({ userId: authenticatedUserId, token: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedUserId, getAccessToken]);

  // WI-L1: React Query for client-side cached leaderboard pages.
  // Returns stale data instantly on back-navigation, revalidates in background.
  const {
    data: leaderboardData,
    isLoading,
    isFetching,
    isPlaceholderData,
    error: queryError,
  } = useLeaderboardQuery({
    metric: selectedMetric,
    page: currentPage,
    pageSize,
    scope: selectedScope,
    userId: authenticatedUserId,
    authToken,
  });

  // WI-L3: Separate user position query — cached across page/tab changes.
  // "Jump to My Position" reads from this, so it's instant.
  const { data: myPosition } = useMyLeaderboardPosition({
    metric: selectedMetric,
    scope: selectedScope,
    pageSize,
    userId: authenticatedUserId,
    authToken,
  });

  // WI-L2: Prefetch next page in background for instant pagination
  usePrefetchNextPage({
    currentPage,
    totalPages: leaderboardData?.pagination.totalPages,
    metric: selectedMetric,
    pageSize,
    scope: selectedScope,
    userId: authenticatedUserId,
    authToken,
  });

  // Prefer the dedicated position query once it has resolved (including an
  // authoritative "unranked" null); fall back to the page bundle only when
  // that query hasn't produced data (disabled, pending or failed).
  const currentUserPosition =
    myPosition !== undefined
      ? myPosition
      : (leaderboardData?.currentUser ?? null);

  // isLoading = true only on first load (no cached data). isFetching = true during any fetch.
  const loading = isLoading;
  const error =
    queryError && !leaderboardData ? 'Failed to fetch leaderboard' : null;

  // Scroll once the requested page's real (non-placeholder) data is shown.
  useEffect(() => {
    if (!scrollRequest || !leaderboardData || isPlaceholderData) return;
    if (leaderboardData.pagination.page !== scrollRequest.page) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector('[data-current-user="true"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setScrollRequest(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollRequest, leaderboardData, isPlaceholderData]);

  const resetLeaderboardView = () => {
    setCurrentPage(1);
    setSelectedUser(null);
  };

  const handleMetricChange = (metric: LeaderboardMetric) => {
    if (metric === selectedMetric) return;
    setSelectedMetric(metric);
    resetLeaderboardView();
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleNextPage = () => {
    if (
      leaderboardData &&
      currentPage < leaderboardData.pagination.totalPages
    ) {
      setCurrentPage(currentPage + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleJumpToPosition = () => {
    if (currentUserPosition) {
      setCurrentPage(currentUserPosition.page);
      setScrollRequest((prev) => ({
        page: currentUserPosition.page,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    }
  };

  const handleUserClick = (player: LeaderboardUser) => {
    setSelectedUser({
      id: player.id,
      username: player.username,
      displayName: player.displayName,
      profileImageUrl: player.profileImageUrl,
      reputationPoints: player.reputationPoints,
      balance: player.balance,
      lifetimePnL: player.lifetimePnL,
      capitalBase: player.capitalBase,
      effectiveCapitalBase: player.effectiveCapitalBase,
      tradingReturn: player.tradingReturn,
      rank: player.rank,
      isAgent: player.isAgent,
      managedBy: player.managedBy,
      nftTokenId: player.nftTokenId,
    });
  };

  const currentUserRowId = authenticated && user ? user.id : null;
  const isCurrentUserOnPage = currentUserRowId
    ? leaderboardData?.leaderboard.some((p) => p.id === currentUserRowId)
    : false;
  const followedUserIds = new Set(leaderboardData?.followingUserIds ?? []);

  const leaderboardDescriptions: Record<LeaderboardMetric, string> = {
    reputation: 'Individual wallets ranked by reputation',
    trading:
      'Individual wallets ranked by realized trading return: lifetime P&L divided by capital base',
  };

  const formatRelativeTime = (iso: string): string => {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    );
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const formatTradingPnL = (value: number): string => {
    if (value > 0) {
      return `+${formatCurrency(value, {
        decimals: 0,
        useThousandsSeparator: true,
      })}`;
    }
    return formatCurrency(value, { decimals: 0, useThousandsSeparator: true });
  };

  const formatTradingReturn = (value: number): string => {
    const percent = value * 100;
    const formatted = `${Math.abs(percent).toFixed(1)}%`;
    if (percent > 0) return `+${formatted}`;
    if (percent < 0) return `-${formatted}`;
    return '0.0%';
  };

  const getTradingReturn = (player: LeaderboardUser): number =>
    player.tradingReturn ?? 0;

  const getTradingLifetimePnL = (player: LeaderboardUser): number =>
    player.lifetimePnL;

  const getDisplayValue = (player: LeaderboardUser): number => {
    if (selectedMetric === 'trading') {
      return getTradingReturn(player);
    }

    return player.reputationPoints;
  };

  const formatDisplayValue = (value: number): string => {
    if (selectedMetric === 'trading') {
      return formatTradingReturn(value);
    }
    return formatNumberWithSeparators(value);
  };

  const getDisplayLabel = (): string => {
    if (selectedMetric === 'trading') {
      return 'Trading Return';
    }
    return 'Reputation';
  };

  const renderPlayerRow = (
    player: LeaderboardUser,
    variant: 'list' | 'pinned'
  ) => {
    const isCurrentUser = currentUserRowId
      ? player.id === currentUserRowId
      : false;
    const displayValue = getDisplayValue(player);
    const formattedValue = formatDisplayValue(displayValue ?? 0);
    const secondaryTradingPnL =
      selectedMetric === 'trading'
        ? formatTradingPnL(getTradingLifetimePnL(player))
        : null;
    const isPinned = variant === 'pinned';
    // One row tree for every breakpoint: compact stats under the name below
    // xl, right-aligned stats on xl.
    return (
      <div className="flex items-center gap-2 sm:gap-4">
        <div className="shrink-0">
          <RankNumber rank={player.rank} size="md" />
        </div>
        <div className="relative shrink-0">
          <Avatar
            id={player.id}
            name={player.displayName || player.username || 'User'}
            size="md"
            src={player.profileImageUrl || undefined}
          />
          {authenticated && !isCurrentUser && !isPinned && (
            <div
              className="absolute -right-1 -bottom-0.5"
              onClick={(e) => {
                // Follow button lives inside the row link: stop navigation too.
                e.preventDefault();
                e.stopPropagation();
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <FollowButton
                userId={player.id}
                variant="circle"
                initialFollowing={
                  leaderboardData?.followingUserIdsResolved
                    ? followedUserIds.has(player.id)
                    : undefined
                }
              />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate font-semibold text-foreground text-sm sm:text-base">
              {player.displayName || player.username || 'Anonymous'}
            </h3>
            {player.isAgent ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-500 text-xs">
                <Bot className="h-3 w-3" />
                AI
              </span>
            ) : (
              <OnChainBadge nftTokenId={player.nftTokenId ?? null} size="sm" />
            )}
            {(isCurrentUser || isPinned) && (
              <span className="shrink-0 rounded bg-foreground px-2 py-0.5 font-semibold text-background text-xs">
                YOU
              </span>
            )}
          </div>
          {player.username && (
            <p
              className={`truncate text-muted-foreground text-sm ${isPinned ? '' : 'hidden xl:block'}`}
            >
              @{player.username}
            </p>
          )}
          {!isPinned && (
            <div className="space-y-0.5 text-xs sm:text-sm xl:hidden">
              <div className="flex items-center gap-2">
                <span className="font-bold text-foreground">
                  {formattedValue} {getDisplayLabel()}
                </span>
              </div>
              {secondaryTradingPnL && (
                <div className="text-muted-foreground text-xs">
                  Lifetime P&amp;L {secondaryTradingPnL}
                </div>
              )}
            </div>
          )}
        </div>
        <div
          className={`shrink-0 text-right ${isPinned ? '' : 'hidden xl:block'}`}
        >
          <div className="font-bold text-foreground text-lg">
            {formattedValue}
          </div>
          <div className="space-y-0.5 text-right text-muted-foreground text-xs">
            <div>{getDisplayLabel()}</div>
            {secondaryTradingPnL && (
              <div>Lifetime P&amp;L {secondaryTradingPnL}</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderEmptyState = () => {
    if (!leaderboardData) return null;
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center text-muted-foreground">
          <Trophy className="mx-auto mb-4 h-16 w-16 opacity-50" />
          <p className="mb-2 font-semibold text-foreground text-lg">
            No Results Yet
          </p>
          <p className="text-sm">
            {selectedMetric === 'trading'
              ? 'No wallets have realized trading return yet. Start trading to appear here!'
              : 'No wallets have reputation yet. Start playing to appear here!'}
          </p>
        </div>
      </div>
    );
  };

  const renderLeaderboardContent = () => {
    if (loading) {
      return (
        <div className="flex-1 overflow-y-auto p-4">
          <LeaderboardSkeleton count={15} />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-center">
            <p className="mb-2 font-semibold text-foreground text-lg">
              Failed to load leaderboard
            </p>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
        </div>
      );
    }

    if (!leaderboardData || leaderboardData.leaderboard.length === 0) {
      return renderEmptyState();
    }

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0">
          {leaderboardData.leaderboard.map((player) => {
            const isCurrentUser = currentUserRowId
              ? player.id === currentUserRowId
              : false;
            const isPlayerSelected = selectedUser?.id === player.id;

            return (
              <Link
                key={player.id}
                href={getProfileUrl(player.id, player.username) || '#'}
                aria-label={`View profile for ${player.displayName || player.username || 'Anonymous'}`}
                onClick={(e) => {
                  // On xl the row opens the profile summary in the sidebar
                  // instead of navigating.
                  if (window.matchMedia('(min-width: 1280px)').matches) {
                    e.preventDefault();
                    handleUserClick(player);
                  }
                }}
                data-current-user={isCurrentUser ? 'true' : undefined}
                className={`block border-l-4 px-4 py-1.5 transition-colors xl:py-3 ${
                  isPlayerSelected
                    ? 'border-l-foreground bg-muted/30'
                    : isCurrentUser
                      ? 'border-l-foreground bg-muted/20 hover:bg-muted/30'
                      : 'border-l-transparent hover:bg-muted/30'
                }`}
              >
                {renderPlayerRow(player, 'list')}
              </Link>
            );
          })}
        </div>

        {/* Pinned current user row (when not on current page) */}
        {authenticated && currentUserPosition && !isCurrentUserOnPage && (
          <div className="sticky bottom-14 border-border border-t bg-muted/40 px-4 py-3 backdrop-blur-sm">
            <div className="mb-1 text-muted-foreground text-xs">
              Your position
            </div>
            {renderPlayerRow(currentUserPosition.entry, 'pinned')}
          </div>
        )}

        {/* Pagination */}
        {leaderboardData.pagination.totalPages > 1 && (
          <div className="sticky bottom-0 bg-background/95 px-4 py-3 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <button
                onClick={handlePreviousPage}
                disabled={currentPage === 1}
                className="flex items-center gap-3 rounded-lg bg-sidebar-accent px-4 py-3 text-foreground transition-colors hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>

              <div className="text-muted-foreground text-sm">
                Page {currentPage} of {leaderboardData.pagination.totalPages}
              </div>

              <button
                onClick={handleNextPage}
                disabled={currentPage === leaderboardData.pagination.totalPages}
                className="flex items-center gap-3 rounded-lg bg-sidebar-accent px-4 py-3 text-foreground transition-colors hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <PageContainer noPadding className="overflow-visible! flex w-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border xl:border-r xl:border-l">
          {/* Header with tabs */}
          <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
            <LeaderboardToggle
              activeMetric={selectedMetric}
              onMetricChange={handleMetricChange}
            />
            <div className="flex items-center justify-between px-3 py-2 sm:px-4 xl:px-6 xl:py-3">
              <div className="flex items-center gap-1.5 xl:gap-2">
                <p className="text-muted-foreground text-xs sm:text-sm">
                  {leaderboardDescriptions[selectedMetric]}
                </p>
                {isFetching && !isLoading && (
                  <span className="h-1 w-1 animate-pulse rounded-full bg-primary/60 xl:h-1.5 xl:w-1.5" />
                )}
                {leaderboardData?.generatedAt && !isFetching && (
                  <span className="text-muted-foreground/60 text-xs">
                    {formatRelativeTime(leaderboardData.generatedAt)}
                  </span>
                )}
              </div>
              {authenticated && currentUserPosition && (
                <button
                  type="button"
                  onClick={handleJumpToPosition}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs transition-colors hover:bg-primary/20 xl:gap-1.5 xl:px-3 xl:py-1.5 xl:text-sm"
                >
                  <Crosshair className="h-3 w-3 xl:h-3.5 xl:w-3.5" />#
                  {currentUserPosition.rank.toLocaleString()}
                </button>
              )}
            </div>
          </div>

          {renderLeaderboardContent()}
        </div>

        {/* Widget Sidebar (xl only; hidden below via its own classes) */}
        <LeaderboardWidgetSidebar
          selectedUser={selectedUser}
          leaderboardMetric={selectedMetric}
        />
      </div>
    </PageContainer>
  );
}
