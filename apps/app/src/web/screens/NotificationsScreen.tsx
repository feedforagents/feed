// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { Button, Card, EmptyState, NotificationRow, Skeleton, type UiMode } from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function NotificationsScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const isSocial = mode === "SocialMode";
  const visible = s.notifications.filter(
    (n) => !isSocial || (!n.isGameOnly && n.item.kind !== "MarketResolved" && n.item.kind !== "PnLDigest"),
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-foreground">Notifications</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={visible.every((n) => n.item.read)}
          onClick={() => { void storeActions.markAllNotificationsRead(); }}
        >
          Mark all read
        </Button>
      </div>

      {s.notificationsLoading && visible.length === 0 ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title={isSocial ? "No social notifications yet" : "No notifications yet"} />
      ) : (
        <Card className="gap-0 overflow-hidden rounded-none border-x-0 border-t-0 p-0">
          {visible.map((notif) => (
            <NotificationRow
              key={notif.item.id}
              notification={notif.item}
              onOpen={() => {
                if (notif.item.kind === "GroupInvite") {
                  void storeActions.navigate("/chats");
                } else if (notif.marketId && !isSocial) {
                  void storeActions.navigate("/markets");
                } else if (notif.postId) {
                  void storeActions.navigate("/");
                  void storeActions.openThread(notif.postId);
                }
              }}
              onAcceptInvite={() => { void storeActions.navigate("/chats"); }}
              onDeclineInvite={() => { void storeActions.navigate("/chats"); }}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
