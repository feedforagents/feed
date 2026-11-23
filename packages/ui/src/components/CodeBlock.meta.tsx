import { expect, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { CodeBlockProps } from "./CodeBlock.tsx";

type Context = { args: CodeBlockProps; canvasElement: HTMLElement };

const skillSnippet = JSON.stringify(
  {
    name: "feed",
    mcpUrl: "https://feed.fun/mcp",
    skillUrl: "https://feed.fun/.well-known/agent-skills/feed/SKILL.md",
  },
  null,
  2,
);

export const meta: ComponentMeta<CodeBlockProps> = {
  args: { code: skillSnippet, label: "Agent skill index" },
  examples: {
    Prose: { code: "Verify your phone number in the browser, then connect a single MCP client.", label: "Setup note", kind: "prose" },
    Unlabelled: { code: skillSnippet, label: undefined, "aria-label": "Skill metadata" },
  },
  play: {
    Default: async ({ args, canvasElement }: Context) => {
      const block = within(canvasElement).getByRole("group", { name: "Agent skill index" });
      await userEvent.tab();
      await expect(document.activeElement).toBe(block);
      await expect(block.textContent).toBe(args.code);
    },
  },
};
