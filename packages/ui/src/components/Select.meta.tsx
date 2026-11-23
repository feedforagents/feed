import { expect, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { SelectContent, SelectItem, type SelectProps, SelectTrigger, SelectValue } from "./Select.tsx";

const children = (
  <>
    <SelectTrigger aria-label="Country">
      <SelectValue placeholder="Choose country" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="US">United States (+1)</SelectItem>
      <SelectItem value="CA">Canada (+1)</SelectItem>
      <SelectItem value="UK">United Kingdom (+44)</SelectItem>
      <SelectItem value="EU">EU / EEA</SelectItem>
    </SelectContent>
  </>
);

export const meta: ComponentMeta<SelectProps> = {
  args: { defaultValue: "US", children },
  examples: { Disabled: { disabled: true } },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const trigger = within(canvasElement).getByRole("combobox", { name: "Country" });
      await expect(trigger.textContent).toContain("United States");
    },
    Disabled: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const trigger = within(canvasElement).getByRole("combobox", { name: "Country" });
      await expect(trigger).toBeDisabled();
    },
  },
};
