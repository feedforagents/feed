import { type ComponentProps, createContext, use } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn, focusRing, inactive } from "../lib/cn.ts";

export type TabsVariant = "pills" | "underline";

const TabsVariantContext = createContext<TabsVariant>("pills");

export type TabsProps = ComponentProps<typeof TabsPrimitive.Root>;

export type TabsListProps = ComponentProps<typeof TabsPrimitive.List> & {
  /** Visual style of the tab bar (`pills` segmented track or X-style `underline` bar). */
  variant?: TabsVariant;
};

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger> & {
  /** Visual style override for an individual tab trigger. */
  variant?: TabsVariant;
};

export type TabsContentProps = ComponentProps<typeof TabsPrimitive.Content>;

/** Tabbed view switcher built on Radix Tabs. */
export function Tabs(props: TabsProps) {
  return <TabsPrimitive.Root {...props} />;
}

/** Container row of `TabsTrigger` buttons. */
export function TabsList({ variant = "pills", className, ...props }: TabsListProps) {
  return (
    <TabsVariantContext value={variant}>
      <TabsPrimitive.List
        className={cn(
          variant === "underline"
            ? "flex w-full items-stretch border-b border-border bg-transparent p-0 text-muted-foreground"
            : "inline-flex items-center gap-1 rounded-md border border-border bg-muted p-1 text-muted-foreground",
          className,
        )}
        {...props}
      />
    </TabsVariantContext>
  );
}

/** Individual tab button selecting a `TabsContent` panel. */
export function TabsTrigger({ variant, className, ...props }: TabsTriggerProps) {
  const inheritedVariant = use(TabsVariantContext);
  const resolvedVariant = variant ?? inheritedVariant;
  return (
    <TabsPrimitive.Trigger
      className={cn(
        focusRing,
        inactive,
        resolvedVariant === "underline"
          ? "relative inline-flex flex-1 items-center justify-center px-4 py-3 text-sm font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-fast after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-[3px] after:rounded-full after:bg-transparent hover:bg-accent/50 hover:text-foreground data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=active]:after:bg-brand"
          : "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-fast hover:text-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
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
