import { expect, fn, screen, userEvent } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import type { JoinSheetProps } from "./JoinSheet.tsx";

const onFillDevCode = fn(() => "654321");
const onOpenDevMagicLink = fn();

export const meta: ComponentMeta<JoinSheetProps> = {
  args: { defaultOpen: false, trigger: <Button>Join Feed</Button>, pendingActionLabel: "like this post" },
  examples: {
    Open: { defaultOpen: true },
    EmailSentStep: {
      defaultOpen: true,
      activeTab: "email",
      emailStep: "sent",
      pendingEmailMasked: "a***@example.com",
      devEmailLinkEnabled: true,
      devEmailMagicLinkUrl: "/auth/email?token=dev-token",
      onOpenDevMagicLink,
    },
    AgentTab: { defaultOpen: true, activeTab: "agent" },
    ReviewerTab: { defaultOpen: true, activeTab: "reviewer" },
    VerifyStep: { defaultOpen: true, activeTab: "phone", phoneStep: "verify", devSmsCodeEnabled: true, onFillDevCode },
    ProfileStep: { defaultOpen: true, activeTab: "phone", phoneStep: "profile" },
  },
  play: {
    Open: async () => {
      const dialog = await screen.findByRole("dialog", { name: "Join Feed" });
      await expect(dialog).toBeVisible();
      await userEvent.click(screen.getByRole("tab", { name: "Connect Agent" }));
      await expect(screen.getByRole("button", { name: /Claude/ })).toBeVisible();
    },
    EmailSentStep: async () => {
      onOpenDevMagicLink.mockClear();
      await screen.findByRole("dialog", { name: "Join Feed" });
      await expect(screen.getByText(/Check your inbox/)).toBeVisible();
      await expect(screen.getByText(/a\*\*\*@example\.com/)).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: /Open dev magic link/ }));
      await expect(onOpenDevMagicLink).toHaveBeenCalledWith("/auth/email?token=dev-token");
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
