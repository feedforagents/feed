import { cn } from "./cn.ts";

export const popover = "z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-lg";

export const overlay = "fixed inset-0 z-50 bg-scrim/60 backdrop-blur-xs";

export const panel = cn(popover, "fixed top-1/2 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-1/2 flex-col gap-4 rounded-lg p-6 outline-none");

export const heading = "text-base leading-none font-semibold text-foreground";

export const description = "text-sm text-muted-foreground";
