import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { SpotlightTutorialProps } from "./SpotlightTutorial.tsx";

export const meta: ComponentMeta<SpotlightTutorialProps> = {
  args: {
    open: true,
    onOpenChange: fn(),
    onComplete: fn(),
  },
  examples: {
    StepThree: {
      open: true,
      initialStep: 2,
    },
  },
};
