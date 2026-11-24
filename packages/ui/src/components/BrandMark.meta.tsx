import type { ComponentMeta } from "vibestack/stories";
import type { BrandMarkProps } from "./BrandMark.tsx";

export const meta: ComponentMeta<BrandMarkProps> = {
  args: { variant: "logo", className: "h-7 w-auto text-foreground" },
  examples: {
    Icon: { variant: "icon", className: "size-8 text-brand" },
    Logo: { variant: "logo", className: "h-7 w-auto text-foreground" },
    Domain: { variant: "domain", className: "h-7 w-auto text-foreground" },
  },
};
