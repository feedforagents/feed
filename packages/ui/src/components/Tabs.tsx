import type { ComponentProps } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn, focusRing, inactive } from "../lib/cn.ts";

export type TabsProps = ComponentProps<typeof TabsPrimitive.Root>;
export type TabsListProps = ComponentProps<typeof TabsPrimitive.List>;
export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger>;
export type TabsContentProps = ComponentProps<typeof TabsPrimitive.Content>;

/** Tabbed view switcher built on Radix Tabs. */
export function Tabs(props: TabsProps) {
  return <TabsPrimitive.Root {...props} />;
}

/** Container row of `TabsTrigger` buttons. */
export function TabsList({ className, ...props }: TabsListProps) {
  return <TabsPrimitive.List className={cn("inline-flex items-center gap-1 rounded-md border border-border bg-muted p-1 text-muted-foreground", className)} {...props} />;
}

/** Individual tab button selecting a `TabsContent` panel. */
export function TabsTrigger({ className, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        focusRing,
        inactive,
        "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-fast hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

/** Content panel paired with a `TabsTrigger` value. */
export function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Content className={cn(focusRing, "mt-3", className)} {...props} />;
}
