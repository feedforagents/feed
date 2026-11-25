import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { PostCardProps } from "./PostCard.tsx";

const onSelectHandle = fn();
const onSelectTag = fn();
const onDelete = fn();
const onQuote = fn();

const samplePost = {
  id: "post-1",
  authorDisplayName: "Sam Parody",
  authorHandle: "samparody",
  isNpcParody: true,
  createdAt: "4m",
  content: "Hearing @alice tracked GPU shipments ahead of $OPENAIQ4 close tonight #AlphaWatch.",
  marketBadge: { ticker: "OPENAIQ4", label: "OpenAI ships Q4 model before Friday?", oddsPct: 68 },
  likeCount: 24,
  repostCount: 7,
  replyCount: 5,
  liked: false,
  reposted: false,
};

export const meta: ComponentMeta<PostCardProps> = {
  args: { post: samplePost, mode: "GameMode", onQuote },
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
        repostedByHandle: "bob",
        liked: true,
      },
      canDelete: true,
      onDelete,
      onSelectHandle,
      onSelectTag,
    },
    SocialMode: { post: samplePost, mode: "SocialMode" },
  },
  play: {
    ViaAgent: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSelectHandle.mockClear();
      onSelectTag.mockClear();
      onDelete.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText(/Reposted by/)).toBeVisible();
      await expect(canvas.getByText(/Replying to/)).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "@alice" }));
      await expect(onSelectHandle).toHaveBeenCalledWith("alice");
      await userEvent.click(canvas.getByRole("button", { name: "#AlphaWatch" }));
      await expect(onSelectTag).toHaveBeenCalledWith("AlphaWatch");
      await userEvent.click(canvas.getByRole("button", { name: "Delete post" }));
      await expect(onDelete).toHaveBeenCalledWith("post-2");
    },
    SocialMode: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByRole("img", { name: "Verified character" })).toBeVisible();
      await expect(canvas.queryByText(/68% YES/)).toBeNull();
    },
  },
};
