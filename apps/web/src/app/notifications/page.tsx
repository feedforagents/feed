'use client';

export const dynamic = 'force-dynamic';

import { cn, logger } from '@feed/shared';
import { Bell, Settings } from 'lucide-react';
import nextDynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GroupInviteCard } from '@/components/groups/GroupInviteCard';
import { Avatar } from '@/components/shared/Avatar';
import { PageContainer } from '@/components/shared/PageContainer';
import { PullToRefreshIndicator } from '@/components/shared/PullToRefreshIndicator';
import { useAuth } from '@/hooks/useAuth';
import { useLoginModal } from '@/hooks/useLoginModal';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import {
  getNotificationHref,
  getNotificationPresentation,
} from '@/lib/notifications/presentation';

const WidgetSidebar = nextDynamic(
  () =>
    import('@/components/shared/WidgetSidebar').then((m) => ({
      default: m.WidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  }
);

interface Notification {
  id: string;
  type: string;
  title: string;
  actorId: string | null;
  actor: {
    id: string;
    displayName: string;
    username: string | null;
    profileImageUrl: string | null;
  } | null;
  postId: string | null;
  commentId: string | null;
  chatId: string | null;
  groupId: string | null;
  inviteId: string | null;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

interface GroupInvite {
  inviteId: string;
  groupId: string;
  groupName: string;
  groupDescription: string | null;
  memberCount: number;
  invitedAt: string;
}

export default function NotificationsPage() {
  const { ready, authenticated, user, getAccessToken } = useAuth();
  const queueLoginModal = useLoginModal((state) => state.queueLoginModal);
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [groupInvites, setGroupInvites] = useState<GroupInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const pendingReadIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!ready || authenticated) return;
    queueLoginModal();
    router.replace('/feed');
  }, [ready, authenticated, router, queueLoginModal]);

  const fetchNotifications = useCallback(
    async (showLoading = true, silent = false) => {
      if (showLoading) {
        setLoading(true);
      }
      const token = await getAccessToken();

      if (!token) {
        if (showLoading) {
          setLoading(false);
        }
        return;
      }

      const headers = { Authorization: `Bearer ${token}` };

      // Load independently so a failing invites request can't hide
      // notifications (and vice versa).
      const loadNotifications = async () => {
        const response = await fetch('/api/notifications?limit=100', {
          headers,
        });
        if (!response.ok) {
          throw new Error(response.statusText || `HTTP ${response.status}`);
        }
        const data = (await response.json()) as {
          notifications?: Notification[];
          unreadCount?: number;
        };
        setNotifications(data.notifications ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      };

      const loadInvites = async () => {
        const response = await fetch('/api/groups/invites', { headers });
        if (!response.ok) {
          throw new Error(response.statusText || `HTTP ${response.status}`);
        }
        const data = (await response.json()) as { invites?: GroupInvite[] };
        setGroupInvites(data.invites ?? []);
      };

      const [notifResult, invitesResult] = await Promise.allSettled([
        loadNotifications(),
        loadInvites(),
      ]);

      if (notifResult.status === 'rejected') {
        logger.error(
          'Failed to fetch notifications',
          { error: String(notifResult.reason) },
          'NotificationsPage'
        );
        if (!silent) {
          toast.error('Failed to refresh notifications');
        }
      }
      if (invitesResult.status === 'rejected') {
        logger.warn(
          'Failed to fetch group invites',
          { error: String(invitesResult.reason) },
          'NotificationsPage'
        );
      }

      if (showLoading) {
        setLoading(false);
      }
    },
    [getAccessToken]
  );

  const handleRefresh = useCallback(async () => {
    await fetchNotifications(false, false); // Show loading via pull-to-refresh indicator, show toast on complete
  }, [fetchNotifications]);

  // Pull-to-refresh hook
  const { pullDistance, isRefreshing, containerRef } = usePullToRefresh({
    onRefresh: handleRefresh,
  });

  useEffect(() => {
    if (!authenticated || !user) {
      setLoading(false);
      return;
    }

    fetchNotifications(true, true); // Initial load: show loading, but silent (no toast)

    // Poll for new notifications every 1 minute when page is visible
    // Use silent refresh (no loading indicator) for polling
    const interval = setInterval(() => {
      // Only refresh if page is visible (not in background tab)
      if (document.visibilityState === 'visible') {
        fetchNotifications(false, true); // Silent refresh, no loading indicator, no toast
      }
    }, 60000); // 60 seconds = 1 minute

    return () => clearInterval(interval);
  }, [authenticated, user, fetchNotifications]);

  const markAsRead = useCallback(
    async (notificationId: string) => {
      // Read current state (not a render-time snapshot) and dedupe in-flight
      // requests so concurrent clicks/observer timers decrement only once.
      const current = notificationsRef.current.find(
        (n) => n.id === notificationId
      );
      if (
        !current ||
        current.read ||
        pendingReadIdsRef.current.has(notificationId)
      ) {
        return;
      }
      pendingReadIdsRef.current.add(notificationId);

      const revert = () => {
        // Only revert if the item is still in the list and still marked read
        // by us; a refetch in the meantime is authoritative.
        const stillPresent = notificationsRef.current.some(
          (n) => n.id === notificationId && n.read
        );
        if (!stillPresent) return;
        setNotifications((prev) =>
          prev.map((n) => (n.id === notificationId ? { ...n, read: false } : n))
        );
        setUnreadCount((prev) => prev + 1);
      };

      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        const token = await getAccessToken();
        if (!token) {
          revert();
          return;
        }
        const response = await fetch('/api/notifications', {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ notificationIds: [notificationId] }),
        });
        if (!response.ok) {
          logger.error(
            'Failed to mark notification as read',
            { statusText: response.statusText },
            'NotificationsPage'
          );
          revert();
        }
      } catch (error) {
        logger.error(
          'Failed to mark notification as read',
          { error: String(error) },
          'NotificationsPage'
        );
        revert();
      } finally {
        pendingReadIdsRef.current.delete(notificationId);
      }
    },
    [getAccessToken]
  );

  // Rebuild the observer only when the set of rendered items changes, not on
  // every read-state flip (which would reset all pending 3s timers).
  const notificationIdsKey = notifications.map((n) => n.id).join(',');

  // Intersection Observer - marks notifications as read after viewing for 3 seconds
  useEffect(() => {
    if (!authenticated || !notificationIdsKey) return;

    const timers = new Map<string, NodeJS.Timeout>();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const notificationId = entry.target.getAttribute(
            'data-notification-id'
          );
          if (!notificationId) return;

          const notification = notificationsRef.current.find(
            (n) => n.id === notificationId
          );
          if (!notification || notification.read) return;

          if (entry.isIntersecting) {
            // Clear any existing timer first (in case notification re-enters viewport)
            const existingTimer = timers.get(notificationId);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            // Start a timer when notification becomes visible
            const timer = setTimeout(() => {
              timers.delete(notificationId);
              // Don't mark items read while the tab is in the background.
              if (document.visibilityState !== 'visible') return;
              void markAsRead(notificationId);
            }, 3000); // 3 seconds delay

            timers.set(notificationId, timer);
          } else {
            // Cancel timer if notification leaves viewport before 3 seconds
            const timer = timers.get(notificationId);
            if (timer) {
              clearTimeout(timer);
              timers.delete(notificationId);
            }
          }
        });
      },
      {
        threshold: 0.5, // At least 50% of notification must be visible
        rootMargin: '-50px', // Adds margin to trigger when fully in view
      }
    );

    // Observe all notification elements
    const notificationElements = document.querySelectorAll(
      '[data-notification-id]'
    );
    notificationElements.forEach((el) => observer.observe(el));

    // Cleanup
    return () => {
      observer.disconnect();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, [notificationIdsKey, authenticated, markAsRead]);

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  if (!authenticated) {
    return null;
  }

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div ref={containerRef} className="relative flex flex-1">
        {/* Notifications area */}
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          {/* Header */}
          <div className="sticky top-0 z-10 flex-shrink-0 bg-background shadow-sm">
            <div className="w-full px-4 py-3 lg:mx-auto lg:max-w-[700px] lg:px-6">
              <div className="flex items-center justify-between">
                <h1 className="font-bold text-xl">Notifications</h1>
                <Link
                  href="/settings?tab=notifications"
                  aria-label="Notification settings"
                  className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <Settings className="h-5 w-5" />
                </Link>
              </div>
              {unreadCount > 0 && (
                <p className="text-muted-foreground text-sm">
                  {unreadCount} unread
                </p>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <PullToRefreshIndicator
                pullDistance={pullDistance}
                isRefreshing={isRefreshing}
              />
              {/* Group Invites: shown even when there are no notifications */}
              {!loading && groupInvites.length > 0 && (
                <div className="space-y-3 sm:px-4 sm:py-4 lg:px-6">
                  <h3 className="font-semibold text-muted-foreground text-sm">
                    Pending Group Invites
                  </h3>
                  {groupInvites.map((invite) => (
                    <GroupInviteCard
                      key={invite.inviteId}
                      inviteId={invite.inviteId}
                      groupId={invite.groupId}
                      groupName={invite.groupName}
                      groupDescription={invite.groupDescription}
                      memberCount={invite.memberCount}
                      invitedAt={invite.invitedAt}
                      onAccepted={(_groupId, chatId) => {
                        fetchNotifications(false, true);
                        if (chatId) {
                          router.push(
                            `/chats?chat=${encodeURIComponent(chatId)}`
                          );
                        }
                      }}
                      onDeclined={() => {
                        fetchNotifications(false, true);
                      }}
                    />
                  ))}
                </div>
              )}
              {loading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="text-muted-foreground">
                    Loading notifications...
                  </div>
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Bell className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
                  <h2 className="mb-2 font-semibold text-xl">
                    No notifications yet
                  </h2>
                  <p className="px-4 text-center text-muted-foreground">
                    When you get comments, reactions, follows, or mentions,
                    they&apos;ll show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-0">
                  {/* Regular Notifications */}
                  {notifications.map((notification) => {
                    const presentation =
                      getNotificationPresentation(notification);

                    return (
                      <Link
                        key={notification.id}
                        href={getNotificationHref(notification)}
                        onClick={() => void markAsRead(notification.id)}
                        data-notification-id={notification.id}
                        className={cn(
                          'block border-border border-b px-4 py-4 lg:px-6',
                          'transition-colors hover:bg-muted/30',
                          !notification.read && 'bg-primary/5'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {/* Unread Indicator */}
                          {!notification.read && (
                            <div className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                          )}

                          {/* Actor Avatar */}
                          {notification.actor && !presentation.isSystemStyle ? (
                            <Avatar
                              id={notification.actor.id}
                              name={notification.actor.displayName}
                              imageUrl={
                                notification.actor.profileImageUrl ?? undefined
                              }
                              size="md"
                              className="shrink-0"
                            />
                          ) : (
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                              {notification.type === 'system' ? (
                                <span className="text-xl" aria-hidden="true">
                                  ✨
                                </span>
                              ) : (
                                <Bell className="h-5 w-5 text-muted-foreground" />
                              )}
                            </div>
                          )}

                          {/* Content */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start gap-3">
                              <div className="flex-1">
                                {presentation.isSystemStyle ? (
                                  <div className="space-y-1">
                                    {presentation.title ? (
                                      <p className="font-semibold text-foreground leading-snug">
                                        {presentation.title}
                                      </p>
                                    ) : null}
                                    <p className="text-muted-foreground leading-relaxed">
                                      {presentation.message}{' '}
                                      <time
                                        dateTime={notification.createdAt}
                                        className="text-muted-foreground/70 text-xs"
                                      >
                                        {formatTimeAgo(notification.createdAt)}
                                      </time>
                                    </p>
                                  </div>
                                ) : (
                                  <p className="text-foreground leading-relaxed">
                                    <span className="block font-semibold md:inline">
                                      {notification.actor?.displayName ||
                                        'Someone'}
                                    </span>{' '}
                                    <span className="text-muted-foreground">
                                      {stripLeadingActorName(
                                        notification.message,
                                        notification.actor?.displayName
                                      )}
                                    </span>{' '}
                                    <time
                                      dateTime={notification.createdAt}
                                      className="text-muted-foreground/70 text-xs"
                                    >
                                      {formatTimeAgo(notification.createdAt)}
                                    </time>
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Widget sidebar - lazy loaded, desktop only */}
        <WidgetSidebar />
      </div>
    </PageContainer>
  );
}

/** Remove the actor's name only when the message starts with it. */
function stripLeadingActorName(message: string, actorName?: string): string {
  if (actorName && message.startsWith(actorName)) {
    return message.slice(actorName.length).replace(/^:?\s*/, '');
  }
  return message;
}
