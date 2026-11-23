import type { ComponentMeta } from "vibestack/stories";
import type { BadgeProps } from "./Badge.tsx";

export const meta: ComponentMeta<BadgeProps> = {
  args: { children: "AI parody" },
  examples: {
    Primary: { variant: "default", children: "via Claude" },
    Ok: { variant: "ok", children: "Trading" },
    Warn: { variant: "warn", children: "Manual Hold" },
    Info: { variant: "info", children: "NPC Alpha" },
    Destructive: { variant: "destructive", children: "Revoked" },
  },
};
