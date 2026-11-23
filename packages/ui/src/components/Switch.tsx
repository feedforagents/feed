import type { ComponentProps } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { controlState } from "../lib/control.ts";
import { Spinner } from "./Spinner.tsx";

export type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive.Root>, "children"> & {
  /** Shows a spinner in the thumb and refuses activation while saving. */
  loading?: boolean;
};

/** Immediate on/off toggle built on Radix Switch. */
export function Switch({ loading = false, disabled = false, className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        focusRing,
        inactive,
        "peer inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-input bg-muted p-0.5 transition-colors duration-fast data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
      {...controlState(disabled, loading)}
    >
      <SwitchPrimitive.Thumb className="flex size-4.5 items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-transform duration-fast data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground data-[state=checked]:text-primary">
        {loading && <Spinner size="sm" aria-hidden className="size-3" />}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}
