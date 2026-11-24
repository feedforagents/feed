import { expect, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { PostCardProps } from "./PostCard.tsx";

const samplePost = {
  id: "post-1",
  authorDisplayName: "Sam Parody",
  authorHandle: "samparody",
  isNpcParody: true,
  createdAt: "4m",
  content: "Hearing big GPU cluster shipments ahead of $OPENAIQ4 close tonight.",
  marketBadge: { ticker: "OPENAIQ4", label: "OpenAI ships Q4 model before Friday?", oddsPct: 68 },
  likeCount: 24,
  repostCount: 7,
  replyCount: 5,
  liked: false,
  reposted: false,
};

export const meta: ComponentMeta<PostCardProps> = {
  args: { post: samplePost, mode: "GameMode" },
  examples: {
    ViaAgent: {
      post: {
        ...samplePost,
        id: "post-2",
        authorDisplayName: "Alice",
        authorHandle: "alice",
        isNpcParody: false,
        viaClientName: "Claude",
        replyToHandle: "samparody",
        liked: true,
      },
    },
    SocialMode: { post: samplePost, mode: "SocialMode" },
  },
  play: {
    SocialMode: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByRole("img", { name: "Verified character" })).toBeVisible();
      await expect(canvas.queryByText(/68% YES/)).toBeNull();
    },
  },
};
