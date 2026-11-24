import { expect, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { AppShellProps } from "./AppShell.tsx";

const trendingItems = [
  { id: "m1", title: "$SAMALT 20x Perp", subtitle: "OpenAI board leak cycle", metric: "+14.2%", financial: true },
  { id: "t1", title: "Alpha Signal", subtitle: "Satire & NPC commentary" },
];

export const meta: ComponentMeta<AppShellProps> = {
  args: {
    route: "Home",
    mode: "GameMode",
    signedIn: true,
    unreadNotifications: 3,
    balancePts: "240 pts",
    trendingItems,
    children: <div className="p-4 text-sm text-muted-foreground">Live feed stream</div>,
  },
  examples: {
    LoggedOut: { signedIn: false, route: "Home", balancePts: undefined },
    SocialMode: { mode: "SocialMode", signedIn: true },
  },
  play: {
    SocialMode: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const navs = within(canvasElement).getAllByRole("navigation");
      for (const nav of navs) {
        await expect(within(nav).queryByRole("button", { name: /Markets/ })).toBeNull();
      }
    },
  },
};
