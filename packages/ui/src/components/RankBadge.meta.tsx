import type { ComponentMeta } from "vibestack/stories";
import type { RankBadgeProps } from "./RankBadge.tsx";

export const meta: ComponentMeta<RankBadgeProps> = {
  args: { rank: 1, size: "md", showLabel: true },
  examples: {
    First: { rank: 1, size: "md", showLabel: true },
    Second: { rank: 2, size: "md", showLabel: true },
    Third: { rank: 3, size: "md", showLabel: true },
    TopTen: { rank: 7, size: "sm", showLabel: true },
  },
};
