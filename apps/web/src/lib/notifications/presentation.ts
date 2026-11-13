import { safeReturnTo } from '../auth/safe-return-to';

const SYSTEM_NOTIFICATION_TYPES = new Set([
  'system',
  'market_resolved',
  'hourly_summary',
  'daily_summary',
  'weekly_summary',
  'monthly_summary',
  'achievement_unlocked',
  'challenge_completed',
]);

export interface NotificationPresentationInput {
  type: string;
  title: string;
  message: string;
  actor: {
    displayName: string;
  } | null;
}

export interface NotificationPresentation {
  isSystemStyle: boolean;
  title: string | null;
  message: string;
}

export function getNotificationPresentation(
  notification: NotificationPresentationInput
): NotificationPresentation {
  const isSystemStyle =
    notification.actor === null ||
    SYSTEM_NOTIFICATION_TYPES.has(notification.type);
  const title = notification.title.trim();
  const message = notification.message.trim();

  if (!isSystemStyle) {
    return {
      isSystemStyle: false,
      title: null,
      message,
    };
  }

  return {
    isSystemStyle: true,
    title: title !== message ? title : null,
    message,
  };
}

export interface NotificationHrefInput {
  type: string;
  message: string;
  actorId: string | null;
  postId: string | null;
  commentId: string | null;
  chatId: string | null;
  data: Record<string, unknown> | null;
}

/**
 * The destination a notification item navigates to. A notification that
 * records a comment (a comment on your post, a reply to your comment, a
 * mention in a comment, a reaction to your comment) arrives at that comment:
 * /comment/[id] is the same destination every other comment click in the app
 * uses, while the post page has no way to focus a specific comment.
 */
export function getNotificationHref(
  notification: NotificationHrefInput
): string {
  if (
    notification.type === 'market_resolved' &&
    typeof notification.data?.deepLink === 'string'
  ) {
    // Only follow same-origin paths; reject absolute/scheme URLs.
    const deepLink = safeReturnTo(notification.data.deepLink);
    if (deepLink !== '/') return deepLink;
  }

  if (
    notification.type === 'hourly_summary' ||
    notification.type === 'daily_summary' ||
    notification.type === 'weekly_summary'
  ) {
    return '/notifications';
  }

  // DM or group chat message - go to the specific chat if chatId is available
  if (notification.chatId) {
    return `/chats?chat=${encodeURIComponent(notification.chatId)}`;
  }

  // Group chat invite - go to chat
  if (
    notification.type === 'system' &&
    notification.message.includes('invited you to')
  ) {
    // Extract chat ID from the message or notification data
    // For now, go to chats page where they can see their invitations
    return '/chats';
  }

  // DM or group chat message without chatId (legacy notifications) - go to chats page
  if (
    notification.type === 'system' &&
    (notification.message.includes('Message') ||
      notification.message.includes('message'))
  ) {
    return '/chats';
  }

  // Profile completion - go to settings
  if (
    notification.type === 'system' &&
    notification.message.includes('profile')
  ) {
    return '/settings';
  }

  // Follow notification - go to the follower's profile
  if (notification.type === 'follow' && notification.actorId) {
    return `/profile/${encodeURIComponent(notification.actorId)}`;
  }

  // The notification is about one specific comment - go to that comment.
  // For a reply, the recorded comment is the parent comment the reply hangs
  // under, whose page renders the reply thread.
  if (
    (notification.type === 'comment' ||
      notification.type === 'reaction' ||
      notification.type === 'reply' ||
      notification.type === 'mention') &&
    notification.commentId
  ) {
    return `/comment/${encodeURIComponent(notification.commentId)}`;
  }

  // Comment or reaction on post - go to the post detail page
  if (
    (notification.type === 'comment' ||
      notification.type === 'reaction' ||
      notification.type === 'reply') &&
    notification.postId
  ) {
    return `/post/${encodeURIComponent(notification.postId)}`;
  }

  // Share notification - go to the post
  if (notification.type === 'share' && notification.postId) {
    return `/post/${encodeURIComponent(notification.postId)}`;
  }

  // Mention - go to the post if available
  if (notification.type === 'mention' && notification.postId) {
    return `/post/${encodeURIComponent(notification.postId)}`;
  }

  // Default: go to feed
  return '/feed';
}
