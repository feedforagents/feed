// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { useState } from "react";
import {
  Button,
  EmptyState,
  NotificationRow,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  type UiMode,
} from "@repo/ui";
import { SettingsIcon } from "../icons.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppNotification } from "../types.ts";

type NotifFilter = "all" | "mentions" | "verified" | "markets";

export function NotificationsScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [filter, setFilter] = useState<NotifFilter>("all");
  const isSocial = mode === "SocialMode";
  const activeFilter: NotifFilter = isSocial && filter === "markets" ? "all" : filter;

  const modeFiltered = s.notifications.filter(
    (n) => !isSocial || (!n.isGameOnly && n.item.kind !== "MarketResolved" && n.item.kind !== "PnLDigest"),
  );

  const visible = modeFiltered.filter((n) => {
    if (activeFilter === "mentions") {
      return n.item.kind === "SocialMention" || n.item.kind === "SocialReply";
    }
    if (activeFilter === "verified") {
      return Boolean(n.item.actorHandle) && (n.item.kind === "GroupInvite" || n.item.kind === "SocialMention" || n.item.kind === "SocialReply");
    }
    if (activeFilter === "markets") {
      return n.isGameOnly || n.item.kind === "MarketResolved" || n.item.kind === "PnLDigest";
    }
    return true;
  });

  const resolveInviteId = (notif: AppNotification): string | null => {
    if (notif.inviteId) return notif.inviteId;
    if (notif.chatId) {
      const match = s.alphaInvites.find((inv) => inv.chatId === notif.chatId);
      if (match) return match.id;
    }
    return null;
  };

  const handleOpen = (notif: AppNotification) => {
    void storeActions.markNotificationRead(notif.item.id);
    if (notif.item.kind === "SocialFollow" && notif.item.actorHandle) {
      void storeActions.navigate(`/u/${encodeURIComponent(notif.item.actorHandle)}`);
      return;
    }
    if (notif.postId) {
      void storeActions.navigate(`/post/${encodeURIComponent(notif.postId)}`);
      return;
    }
    if (notif.isChatMessage) {
      void storeActions.navigate("/chats");
      return;
    }
    if (notif.item.kind === "GroupInvite" || notif.chatId) {
      const targetChatId = notif.chatId;
      void storeActions.navigate("/chats").then(() => {
        if (targetChatId) void storeActions.loadChatMessages(targetChatId);
      });
      return;
    }
    if (notif.marketId && !isSocial) {
      void storeActions.navigate(`/markets/predictions/${encodeURIComponent(notif.marketId)}`);
    }
  };

  const handleInviteDecision = (notif: AppNotification, accept: boolean) => {
    const inviteId = resolveInviteId(notif);
    void storeActions.markNotificationRead(notif.item.id);
    if (inviteId) {
      void storeActions.respondGroupInvite(inviteId, accept);
      return;
    }
    void storeActions.navigate("/chats");
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <div className="flex h-[53px] items-center justify-between gap-2 px-4">
          <h1 className="text-base font-bold text-foreground">Notifications</h1>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              disabled={modeFiltered.every((n) => n.item.read)}
              onClick={() => { void storeActions.markAllNotificationsRead(); }}
            >
              Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              disabled={s.notifications.length === 0}
              onClick={() => { void storeActions.clearNotifications(); }}
            >
              Clear all
            </Button>
            <Button
              variant="ghost"
              size="icon"
              shape="pill"
              aria-label="Notification settings"
              onClick={() => { void storeActions.navigate("/settings?tab=privacy"); }}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </div>
        </div>

        <Tabs
          value={activeFilter}
          onValueChange={(next) => {
            if (next === "all" || next === "mentions" || next === "verified" || next === "markets") {
              setFilter(next);
            }
          }}
        >
          <TabsList variant="underline" className="border-b-0">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="mentions">Mentions</TabsTrigger>
            <TabsTrigger value="verified">Verified</TabsTrigger>
            {!isSocial ? <TabsTrigger value="markets">Markets</TabsTrigger> : null}
          </TabsList>
        </Tabs>
      </div>

      {s.notificationsLoading && visible.length === 0 ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title={isSocial ? "No social notifications yet" : "No notifications yet"} />
      ) : (
        <div className="flex flex-col">
          {visible.map((notif) => (
            <NotificationRow
              key={notif.item.id}
              notification={notif.item}
              onOpen={() => handleOpen(notif)}
              onAcceptInvite={() => handleInviteDecision(notif, true)}
              onDeclineInvite={() => handleInviteDecision(notif, false)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
