import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ModeToggleProps } from "./ModeToggle.tsx";

const onModeChange = fn();

export const meta: ComponentMeta<ModeToggleProps> = {
  args: { mode: "GameMode", onModeChange },
  examples: {
    SocialMode: { mode: "SocialMode", hasAtRiskOpenPositions: false },
    AtRiskWarning: { mode: "SocialMode", hasAtRiskOpenPositions: true },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onModeChange.mockClear();
      await userEvent.click(within(canvasElement).getByRole("switch", { name: "Social mode" }));
      await expect(onModeChange).toHaveBeenCalledWith("SocialMode");
    },
    AtRiskWarning: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      await expect(within(canvasElement).getByRole("alert").textContent).toContain("open positions");
    },
  },
};
