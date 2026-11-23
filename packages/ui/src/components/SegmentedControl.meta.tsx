import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { SegmentedControlProps } from "./SegmentedControl.tsx";

const onChoose = fn();

export const meta: ComponentMeta<SegmentedControlProps> = {
  args: {
    "aria-label": "Feed tab",
    value: "Latest",
    options: [
      { value: "ForYou", label: "For You" },
      { value: "Following", label: "Following" },
      { value: "Latest", label: "Latest" },
    ],
  },
  examples: { Choose: { onValueChange: onChoose } },
  play: {
    Choose: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onChoose.mockClear();
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("radio", { name: "Latest" }));
      await userEvent.click(canvas.getByRole("radio", { name: "Following" }));
      await expect(onChoose.mock.calls).toEqual([["Following"]]);
    },
  },
};
