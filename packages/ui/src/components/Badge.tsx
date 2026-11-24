import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

export const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap transition-colors duration-fast", {
  variants: {
    variant: {
      default: "bg-feed-brand text-feed-brand-foreground",
      secondary: "bg-secondary text-secondary-foreground",
      outline: "border border-border bg-background text-foreground",
      ok: "border border-transparent bg-ok/15 text-ok",
      warn: "border border-transparent bg-warn/15 text-warn",
      info: "border border-transparent bg-feed-brand/15 text-primary",
      destructive: "border border-transparent bg-destructive/15 text-destructive",
    },
  },
  defaultVariants: { variant: "secondary" },
});

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Renders the single child element with the badge styles. */
    asChild?: boolean;
  };

/** Compact label for status, client attribution, or NPC parody disclosure. */
export function Badge({ variant, asChild = false, className, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />;
}
