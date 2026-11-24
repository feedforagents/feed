import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ProfileHeaderProps } from "./ProfileHeader.tsx";

const onOpenFollowers = fn();
const onOpenFollowing = fn();

const baseProfile = {
  displayName: "Alice",
  handle: "alice",
  bio: "Trading narrative arcs and 20x perps with Claude.",
  connectedClient: "Claude",
  connectedAgentMark: "Claude" as const,
  followersCount: 142,
  followingCount: 38,
  balancePts: "240 pts",
  isFollowing: false,
};

export const meta: ComponentMeta<ProfileHeaderProps> = {
  args: { profile: baseProfile, mode: "GameMode", onOpenFollowers, onOpenFollowing },
  examples: {
    SocialMode: { profile: baseProfile, mode: "SocialMode" },
    NpcParody: {
      profile: {
        ...baseProfile,
        displayName: "Sam Parody",
        handle: "samparody",
        isNpcParody: true,
        connectedClient: undefined,
        connectedAgentMark: undefined,
        balancePts: undefined,
      },
    },
    OwnProfile: {
      profile: { ...baseProfile, isOwnProfile: true },
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onOpenFollowers.mockClear();
      onOpenFollowing.mockClear();
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("button", { name: /38 Following/ }));
      await expect(onOpenFollowing).toHaveBeenCalled();
      await userEvent.click(canvas.getByRole("button", { name: /142 Followers/ }));
      await expect(onOpenFollowers).toHaveBeenCalled();
    },
    SocialMode: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      await expect(within(canvasElement).queryByText("240 pts")).toBeNull();
    },
  },
};
