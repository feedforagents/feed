import type { ComponentProps } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "../lib/cn.ts";
import { popover } from "../lib/overlay.ts";

export type PopoverProps = ComponentProps<typeof PopoverPrimitive.Root>;
export type PopoverContentProps = ComponentProps<typeof PopoverPrimitive.Content>;

/** Floating content panel anchored to a trigger element. */
export function Popover(props: PopoverProps) {
  return <PopoverPrimitive.Root {...props} />;
}

/** Trigger that toggles the popover. */
export const PopoverTrigger = PopoverPrimitive.Trigger;

/** Optional virtual or custom positioning anchor. */
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** Control that closes the popover. */
export const PopoverClose = PopoverPrimitive.Close;

/** Floating card rendered inside a portal. */
export function PopoverContent({ align = "center", sideOffset = 6, className, ...props }: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content align={align} sideOffset={sideOffset} className={cn(popover, "w-72 p-4 outline-none", className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}
