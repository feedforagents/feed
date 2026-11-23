import type { ComponentProps } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { popover } from "../lib/overlay.ts";

export type SelectProps = ComponentProps<typeof SelectPrimitive.Root>;
export type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger> & {
  /** Marks the selection invalid via `aria-invalid` and destructive border. */
  invalid?: boolean;
};
export type SelectContentProps = ComponentProps<typeof SelectPrimitive.Content>;
export type SelectItemProps = ComponentProps<typeof SelectPrimitive.Item>;
export type SelectLabelProps = ComponentProps<typeof SelectPrimitive.Label>;
export type SelectSeparatorProps = ComponentProps<typeof SelectPrimitive.Separator>;

/** Accessible dropdown select built on Radix Select primitives. */
export function Select(props: SelectProps) {
  return <SelectPrimitive.Root {...props} />;
}

/** Groups related select options. */
export const SelectGroup = SelectPrimitive.Group;

/** Displays the currently selected value inside `SelectTrigger`. */
export const SelectValue = SelectPrimitive.Value;

/** Button that opens the select listbox. */
export function SelectTrigger({ invalid = false, className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      aria-invalid={invalid || undefined}
      className={cn(
        focusRing,
        inactive,
        "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive data-placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Portal popover containing the selectable options. */
export function SelectContent({ position = "popper", className, children, ...props }: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(popover, "max-h-72 min-w-36 overflow-hidden", position === "popper" && "translate-y-1", className)}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1 text-muted-foreground">
          <ChevronUp aria-hidden className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className={cn("p-1", position === "popper" && "w-full min-w-(--radix-select-trigger-width)")}>
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1 text-muted-foreground">
          <ChevronDown aria-hidden className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** Group heading inside `SelectContent`. */
export function SelectLabel({ className, ...props }: SelectLabelProps) {
  return <SelectPrimitive.Label className={cn("px-2.5 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}

/** Selectable option row inside `SelectContent`. */
export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-8 pl-2.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** Visual divider between option groups inside `SelectContent`. */
export function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return <SelectPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
