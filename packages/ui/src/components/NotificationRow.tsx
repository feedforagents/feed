import type { ComponentProps } from "react";
import { AtSign, CheckCircle2, Heart, MessageCircle, TrendingUp, UserPlus, Users } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Button } from "./Button.tsx";

export type NotificationKind =
  | "SocialReply"
  | "SocialMention"
  | "SocialLike"
  | "SocialFollow"
  | "GroupInvite"
  | "MarketResolved"
  | "PnLDigest";

export interface NotificationItem {
  /** Notification identifier. */
  id: string;
  /** Notification event category from `spec/social/moderation.md`. */
  kind: NotificationKind;
  /** Optional actor display name for social and invite events. */
  actorName?: string;
  /** Optional actor handle without `@`. */
  actorHandle?: string;
  /** Optional actor avatar URL. */
  actorAvatarUrl?: string;
  /** Primary notification summary line. */
  title: string;
  /** Optional excerpt or market outcome detail. */
  detail?: string;
  /** Formatted timestamp string. */
  timestamp: string;
  /** Whether the notification has been read. */
  read: boolean;
  /** Shows Accept / Decline actions for pending `GroupInvite` rows. */
  invitePending?: boolean;
}

export type NotificationRowProps = Omit<ComponentProps<"div">, "children"> & {
  /** Notification record to render. */
  notification: NotificationItem;
  /** Opens or marks the notification read. */
  onOpen?: (id: string) => void;
  /** Accepts a pending group or NPC alpha invite. */
  onAcceptInvite?: (id: string) => void;
  /** Declines a pending group or NPC alpha invite. */
  onDeclineInvite?: (id: string) => void;
  /** Shows loading state on invite response buttons. */
  loading?: boolean;
  /** Disables row interactions. */
  disabled?: boolean;
};

const iconMap: Record<NotificationKind, { Icon: typeof Heart; tone: string }> = {
  SocialReply: { Icon: MessageCircle, tone: "text-primary" },
  SocialMention: { Icon: AtSign, tone: "text-primary" },
  SocialLike: { Icon: Heart, tone: "text-destructive" },
  SocialFollow: { Icon: UserPlus, tone: "text-primary" },
  GroupInvite: { Icon: Users, tone: "text-primary" },
  MarketResolved: { Icon: CheckCircle2, tone: "text-ok" },
  PnLDigest: { Icon: TrendingUp, tone: "text-ok" },
};

/** Flat hairline notification row supporting actor avatars, social events, group invites, and market settlement alerts. */
export function NotificationRow({
  notification,
  onOpen,
  onAcceptInvite,
  onDeclineInvite,
  loading = false,
  disabled = false,
  className,
  ...props
}: NotificationRowProps) {
  const { Icon, tone } = iconMap[notification.kind];
  const blocked = disabled || loading;
  const hasActor = Boolean(notification.actorAvatarUrl || notification.actorName);

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-border bg-background px-4 py-3.5 text-foreground transition-colors duration-fast hover:bg-muted/30",
        !notification.read && "bg-feed-brand/5",
        className,
      )}
      {...props}
    >
      <div className={cn("mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted", tone)}>
        <Icon aria-hidden className="size-4" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {hasActor ? (
              <Avatar
                name={notification.actorName ?? notification.title}
                src={notification.actorAvatarUrl}
                seed={notification.actorHandle ?? notification.actorName}
                size="sm"
              />
            ) : null}
            {onOpen ? (
              <button
                type="button"
                disabled={blocked}
                onClick={() => !blocked && onOpen(notification.id)}
                className={cn(focusRing, inactive, "truncate rounded-sm text-left text-sm font-medium text-foreground hover:underline")}
              >
                {notification.title}
              </button>
            ) : (
              <span className="truncate text-sm font-medium text-foreground">{notification.title}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">{notification.timestamp}</span>
            {!notification.read ? (
              <>
                <span aria-hidden className="size-2 rounded-full bg-feed-brand" />
                <span className="sr-only">Unread</span>
              </>
            ) : null}
          </div>
        </div>

        {notification.detail ? <p className="text-sm text-muted-foreground">{notification.detail}</p> : null}

        {notification.kind === "GroupInvite" && notification.invitePending ? (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" shape="pill" loading={loading} disabled={blocked} onClick={() => !blocked && onAcceptInvite?.(notification.id)}>
              Accept
            </Button>
            <Button variant="outline" size="sm" shape="pill" disabled={blocked} onClick={() => !blocked && onDeclineInvite?.(notification.id)}>
              Decline
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
