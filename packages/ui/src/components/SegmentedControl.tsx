import type { ComponentProps } from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { controlState } from "../lib/control.ts";

export interface Segment {
  /** Machine value emitted when this segment is chosen. */
  value: string;
  /** Visible segment label. */
  label: string;
}

export type SegmentedControlProps = Omit<ComponentProps<typeof ToggleGroupPrimitive.Root>, "type" | "value" | "defaultValue" | "onValueChange" | "children"> & {
  /** Segments rendered left to right. */
  options: Segment[];
  /** Currently active segment value. */
  value: string;
  /** Called when a different segment is chosen. */
  onValueChange: (value: string) => void;
  /** Accessible name describing the choice group. */
  "aria-label": string;
};

/** Single-choice segmented control built on Radix ToggleGroup. */
export function SegmentedControl({ options, value, onValueChange, disabled = false, className, ...props }: SegmentedControlProps) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (!disabled && next) onValueChange(next);
      }}
      className={cn("inline-flex gap-1 rounded-md border border-border bg-muted p-1", className)}
      {...props}
      {...controlState(disabled)}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={disabled}
          className={cn(
            focusRing,
            inactive,
            "h-8 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:ring-1 data-[state=on]:ring-border",
          )}
        >
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
