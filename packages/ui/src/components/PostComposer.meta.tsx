import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { PostComposerProps } from "./PostComposer.tsx";

const onSubmit = fn();

export const meta: ComponentMeta<PostComposerProps> = {
  args: { authorName: "Alice", onSubmit },
  examples: {
    Reply: {
      replyTo: { authorHandle: "samparody", excerpt: "GPU cluster leak incoming." },
      defaultValue: "Long $SAMALT on this dip.",
    },
    OverLimit: {
      defaultValue: "a".repeat(285),
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
      await userEvent.type(canvas.getByRole("textbox", { name: "Post text" }), "YES on 15m slot");
      await userEvent.click(canvas.getByRole("button", { name: "Post" }));
      await expect(onSubmit).toHaveBeenCalledWith("YES on 15m slot");
    },
  },
};
