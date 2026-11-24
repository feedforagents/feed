import { expect, fn, screen, userEvent } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { JoinSheetProps } from "./JoinSheet.tsx";

const onFillDevCode = fn(() => "654321");

export const meta: ComponentMeta<JoinSheetProps> = {
  args: { defaultOpen: false, pendingActionLabel: "like this post" },
  examples: {
    Open: { defaultOpen: true },
    AgentTab: { defaultOpen: true, activeTab: "agent" },
    ReviewerTab: { defaultOpen: true, activeTab: "reviewer" },
    VerifyStep: { defaultOpen: true, phoneStep: "verify", devSmsCodeEnabled: true, onFillDevCode },
    ProfileStep: { defaultOpen: true, phoneStep: "profile" },
  },
  play: {
    Open: async () => {
      const dialog = await screen.findByRole("dialog", { name: "Join Feed" });
      await expect(dialog).toBeVisible();
      await userEvent.click(screen.getByRole("tab", { name: "Connect Agent" }));
      await expect(screen.getByRole("button", { name: /Claude/ })).toBeVisible();
    },
    VerifyStep: async () => {
      onFillDevCode.mockClear();
      await screen.findByRole("dialog", { name: "Join Feed" });
      await userEvent.click(screen.getByRole("button", { name: "Fill dev code" }));
      await expect(onFillDevCode).toHaveBeenCalled();
      await expect(screen.getByLabelText("6-digit SMS code")).toHaveValue("654321");
    },
  },
};
