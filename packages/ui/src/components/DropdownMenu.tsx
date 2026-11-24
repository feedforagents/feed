import type { ComponentProps } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, Circle } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { popover } from "../lib/overlay.ts";

export type DropdownMenuProps = ComponentProps<typeof DropdownMenuPrimitive.Root>;
export type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuPrimitive.Content>;
export type DropdownMenuItemProps = ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  /** Emphasizes a destructive item such as block or revoke. */
  destructive?: boolean;
};
export type DropdownMenuLabelProps = ComponentProps<typeof DropdownMenuPrimitive.Label>;
export type DropdownMenuSeparatorProps = ComponentProps<typeof DropdownMenuPrimitive.Separator>;
export type DropdownMenuCheckboxItemProps = ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>;
export type DropdownMenuRadioItemProps = ComponentProps<typeof DropdownMenuPrimitive.RadioItem>;

const itemBase =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50";

/** Menu of contextual actions anchored to a trigger control. */
export function DropdownMenu({ modal = false, ...props }: DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />;
}

/** Opens the dropdown menu; pass `asChild` to wrap a `Button`. */
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/** Groups related items inside a dropdown menu. */
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

/** Radio group inside a dropdown menu. */
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/** Floating menu surface rendered in a portal. */
export function DropdownMenuContent({ sideOffset = 6, className, ...props }: DropdownMenuContentProps) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content sideOffset={sideOffset} className={cn(popover, "min-w-44 p-1", className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

/** Selectable menu action item. */
export function DropdownMenuItem({ destructive = false, className, ...props }: DropdownMenuItemProps) {
  return <DropdownMenuPrimitive.Item className={cn(itemBase, destructive && "text-destructive data-highlighted:text-destructive", className)} {...props} />;
}

/** Toggleable checkbox item inside a dropdown menu. */
export function DropdownMenuCheckboxItem({ children, checked, className, ...props }: DropdownMenuCheckboxItemProps) {
  return (
    <DropdownMenuPrimitive.CheckboxItem checked={checked} className={cn(itemBase, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/** Radio option item inside a dropdown menu. */
export function DropdownMenuRadioItem({ children, className, ...props }: DropdownMenuRadioItemProps) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(itemBase, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle aria-hidden className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

/** Non-interactive section label inside a dropdown menu. */
export function DropdownMenuLabel({ className, ...props }: DropdownMenuLabelProps) {
  return <DropdownMenuPrimitive.Label className={cn("px-2.5 py-1.5 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}

/** Horizontal divider inside a dropdown menu. */
export function DropdownMenuSeparator({ className, ...props }: DropdownMenuSeparatorProps) {
  return <DropdownMenuPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
