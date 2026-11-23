import type { ComponentMeta } from "vibestack/stories";
import type { NotificationRowProps } from "./NotificationRow.tsx";

const socialInvite = {
  id: "notif-1",
  kind: "GroupInvite" as const,
  actorName: "Sam Parody",
  actorHandle: "samparody",
  title: "Sam Parody invited you to Sam Alpha Circle",
  detail: "NPC Alpha group chat · 18 active members",
  timestamp: "2m",
  read: false,
  invitePending: true,
};

export const meta: ComponentMeta<NotificationRowProps> = {
  args: { notification: socialInvite },
  examples: {
    MarketResolved: {
      notification: {
        id: "notif-2",
        kind: "MarketResolved",
        title: "Market resolved: YES won 1 pt/share",
        detail: "Credited +80 pts from OpenAI parody 15m slot.",
        timestamp: "1h",
        read: true,
      },
    },
    Like: {
      notification: {
        id: "notif-3",
        kind: "SocialLike",
        actorName: "Bob",
        actorHandle: "bob",
        title: "@bob liked your post",
        detail: "Long $SAMALT on this dip.",
        timestamp: "14m",
        read: false,
      },
    },
  },
};
