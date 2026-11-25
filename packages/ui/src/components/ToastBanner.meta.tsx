import type { ComponentMeta } from "vibestack/stories";
import type { ToastBannerProps } from "./ToastBanner.tsx";

export const meta: ComponentMeta<ToastBannerProps> = {
  args: {
    message: "Link copied to clipboard",
    tone: "ok",
  },
  examples: {
    Destructive: {
      message: "Trade rejected",
      description: "Insufficient balance for 500 pts order.",
      tone: "destructive",
    },
    Warning: {
      message: "Connection reconnecting",
      tone: "warn",
    },
  },
};
