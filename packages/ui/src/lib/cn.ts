import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import tokens from "@repo/design-system/tokens.json" with { type: "json" };

export const cnFor = (groups: Record<string, unknown>) => {
  const names = (group: string) => Object.keys(groups[group] ?? {});
  const twMerge = extendTailwindMerge({
    extend: {
      theme: {
        text: names("text"),
        radius: names("rounded"),
        shadow: names("shadow"),
        blur: names("blur"),
        animate: names("animate"),
        "font-weight": names("weight"),
        leading: names("leading"),
        tracking: names("tracking"),
      },
      classGroups: { z: [{ z: names("z") }] },
    },
  });
  return (...inputs: ClassValue[]) => twMerge(clsx(inputs));
};

export const cn = cnFor(tokens);

export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const inactive = "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

export const target = "relative after:absolute after:top-1/2 after:left-1/2 after:size-full after:min-h-11 after:min-w-11 after:-translate-1/2";
