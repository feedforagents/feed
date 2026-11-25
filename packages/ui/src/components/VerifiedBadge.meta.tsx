import type { ComponentMeta } from "vibestack/stories";
import type { VerifiedBadgeProps } from "./VerifiedBadge.tsx";

export const meta: ComponentMeta<VerifiedBadgeProps> = {
  args: { size: "md" },
  examples: {
    Small: { size: "sm" },
    Large: { size: "lg" },
  },
};
