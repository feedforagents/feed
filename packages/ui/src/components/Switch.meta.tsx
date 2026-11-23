import { expect, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { SwitchProps } from "./Switch.tsx";

const switchControl = (canvasElement: HTMLElement) => within(canvasElement).getByRole<HTMLButtonElement>("switch", { name: "Social mode" });

export const meta: ComponentMeta<SwitchProps> = {
  args: { "aria-label": "Social mode" },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const control = switchControl(canvasElement);
      control.focus();
      await userEvent.keyboard(" ");
      await expect(control.getAttribute("aria-checked")).toBe("true");
    },
    Loading: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const control = switchControl(canvasElement);
      await expect([control.disabled, control.getAttribute("aria-busy"), control.getAttribute("aria-disabled")]).toEqual([false, "true", "true"]);
    },
  },
};
