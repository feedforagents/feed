import type { ComponentProps } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../lib/cn.ts";
import { popover } from "../lib/overlay.ts";

export type TooltipProviderProps = ComponentProps<typeof TooltipPrimitive.Provider>;
export type TooltipProps = ComponentProps<typeof TooltipPrimitive.Root>;
export type TooltipContentProps = ComponentProps<typeof TooltipPrimitive.Content>;

/** Provider managing hover delay and shared tooltip timing. */
export function TooltipProvider({ delayDuration = 250, ...props }: TooltipProviderProps) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

/** Accessible hover/focus hint built on Radix Tooltip. */
export function Tooltip(props: TooltipProps) {
  return <TooltipPrimitive.Root {...props} />;
}

/** Element that displays the tooltip on hover or keyboard focus. */
export const TooltipTrigger = TooltipPrimitive.Trigger;

/** Floating tooltip label rendered in a portal. */
export function TooltipContent({ sideOffset = 6, className, ...props }: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content sideOffset={sideOffset} className={cn(popover, "px-2.5 py-1 text-xs font-medium", className)} {...props} />
    </TooltipPrimitive.Portal>
  );
}
