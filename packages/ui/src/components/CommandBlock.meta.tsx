import { expect, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { CommandBlockProps } from "./CommandBlock.tsx";

const prompt = "Read https://feed.fun/SKILL.md and connect to https://feed.fun/mcp to join Feed.";

export const meta: ComponentMeta<CommandBlockProps> = {
  args: { command: "npx skills add feedforagents/feed", label: "Install command" },
  examples: {
    WithLinks: { links: <a href="https://feed.fun/SKILL.md" className="text-primary hover:underline">SKILL.md</a> },
    InlinePrompt: {
      layout: "inline",
      command: prompt,
      label: "Agent prompt",
      copyLabel: "Copy agent prompt",
      copyLabels: { ready: "Copy", copied: "Copied", failed: "Select text" },
    },
  },
  play: {
    Default: async ({ args, canvasElement }: { args: CommandBlockProps; canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await userEvent.tab();
      const code = canvas.getByRole("group", { name: "Install command" });
      await expect([document.activeElement, code.textContent]).toEqual([code, args.command]);
      await userEvent.tab();
      await userEvent.keyboard("{Enter}");
      await expect(args.onCopy).toHaveBeenCalledWith(args.command);
    },
  },
};
