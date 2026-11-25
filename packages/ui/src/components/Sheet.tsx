import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";
import { description, heading, overlay } from "../lib/overlay.ts";
import { CardFooter } from "./Card.tsx";

export type SheetSide = "left" | "right" | "bottom";

const sideClasses: Record<SheetSide, string> = {
  left: "inset-y-0 left-0 h-full w-4/5 max-w-xs border-r",
  right: "inset-y-0 right-0 h-full w-4/5 max-w-sm border-l",
  bottom: "inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-xl border-t",
};

export type SheetProps = ComponentProps<typeof DialogPrimitive.Root>;

export type SheetContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** Edge of the viewport from which the drawer slides in. */
  side?: SheetSide;
  /** Accessible name of the close button. */
  closeLabel?: string;
};

export type SheetTitleProps = ComponentProps<typeof DialogPrimitive.Title>;
export type SheetDescriptionProps = ComponentProps<typeof DialogPrimitive.Description>;

/** Slide-over drawer built on Radix Dialog for mobile navigation and trading sheets. */
export function Sheet(props: SheetProps) {
  return <DialogPrimitive.Root {...props} />;
}

/** Opens the sheet; pass `asChild` to wrap a button or avatar. */
export const SheetTrigger = DialogPrimitive.Trigger;

/** Closes the sheet; pass `asChild` to wrap a button. */
export const SheetClose = DialogPrimitive.Close;

/** Action row pinned at the end of a `SheetContent`. */
export const SheetFooter = CardFooter;

/** Slide-over panel rendered over the modal scrim. */
export function SheetContent({ side = "right", closeLabel = "Close", className, children, ...props }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          "fixed z-50 flex flex-col gap-4 overflow-y-auto border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none",
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className={cn(focusRing, "absolute top-4 right-4 rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground")}
        >
          <X aria-hidden className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Accessible title of the sheet drawer. */
export function SheetTitle({ className, ...props }: SheetTitleProps) {
  return <DialogPrimitive.Title className={cn(heading, className)} {...props} />;
}

/** Supporting description text inside a sheet drawer. */
export function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return <DialogPrimitive.Description className={cn(description, className)} {...props} />;
}
