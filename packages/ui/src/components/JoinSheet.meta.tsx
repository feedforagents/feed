import { expect, screen, userEvent } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import type { JoinSheetProps } from "./JoinSheet.tsx";

export const meta: ComponentMeta<JoinSheetProps> = {
  args: { defaultOpen: false, trigger: <Button>Join Feed</Button>, pendingActionLabel: "like this post" },
  examples: {
    Open: { defaultOpen: true },
    AgentTab: { defaultOpen: true, activeTab: "agent" },
    ReviewerTab: { defaultOpen: true, activeTab: "reviewer" },
    VerifyStep: { defaultOpen: true, phoneStep: "verify" },
    ProfileStep: { defaultOpen: true, phoneStep: "profile" },
  },
  play: {
    Open: async () => {
      const dialog = await screen.findByRole("dialog", { name: "Join Feed" });
      await expect(dialog).toBeVisible();
      await userEvent.click(screen.getByRole("tab", { name: "Connect Agent" }));
      await expect(screen.getByRole("button", { name: /Claude/ })).toBeVisible();
    },
  },
};
