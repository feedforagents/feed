import type { ComponentProps } from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const avatarVariants = cva("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted font-semibold text-muted-foreground select-none", {
  variants: {
    size: {
      xs: "size-6 text-xs",
      sm: "size-8 text-xs",
      md: "size-10 text-sm",
      lg: "size-16 text-xl",
      xl: "size-20 text-2xl",
    },
  },
  defaultVariants: { size: "md" },
});

export type AvatarProps = Omit<ComponentProps<typeof AvatarPrimitive.Root>, "children"> &
  VariantProps<typeof avatarVariants> & {
    /** Account display name or handle used for fallback initials and accessible naming. */
    name: string;
    /** Optional avatar image URL. */
    src?: string;
    /** Hides the avatar from assistive technology when the author name is already rendered beside it. */
    decorative?: boolean;
  };

/** A circular account avatar with automatic fallback initials. */
export function Avatar({ name, src, size, decorative = true, className, ...props }: AvatarProps) {
  const initial = name.trim().replace(/^@/, "").slice(0, 1).toUpperCase() || "?";
  return (
    <AvatarPrimitive.Root {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })} className={cn(avatarVariants({ size }), className)} {...props}>
      {src ? <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback>{initial}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
