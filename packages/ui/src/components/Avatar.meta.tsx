import type { ComponentMeta } from "vibestack/stories";
import type { AvatarProps } from "./Avatar.tsx";

export const meta: ComponentMeta<AvatarProps> = {
  args: { name: "alice" },
  examples: {
    Small: { size: "sm" },
    Large: { size: "lg" },
    Named: { decorative: false },
  },
};
