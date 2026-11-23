import type { ComponentProps } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { cn } from "../lib/cn.ts";
import { description, heading, overlay, panel } from "../lib/overlay.ts";
import { buttonVariants } from "./Button.tsx";
import { CardFooter } from "./Card.tsx";

export type AlertDialogProps = ComponentProps<typeof AlertDialogPrimitive.Root>;
export type AlertDialogContentProps = ComponentProps<typeof AlertDialogPrimitive.Content>;
export type AlertDialogTitleProps = ComponentProps<typeof AlertDialogPrimitive.Title>;
export type AlertDialogDescriptionProps = ComponentProps<typeof AlertDialogPrimitive.Description>;
export type AlertDialogActionProps = ComponentProps<typeof AlertDialogPrimitive.Action>;
export type AlertDialogCancelProps = ComponentProps<typeof AlertDialogPrimitive.Cancel>;

/** A confirmation modal that demands an explicit decision before continuing. */
export function AlertDialog(props: AlertDialogProps) {
  return <AlertDialogPrimitive.Root {...props} />;
}

/** Opens the alert dialog; pass `asChild` to wrap a `Button`. */
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

/** Header container for `AlertDialogTitle` and `AlertDialogDescription`. */
export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

/** Footer action row for `AlertDialogCancel` and `AlertDialogAction`. */
export const AlertDialogFooter = CardFooter;

/** Modal dialog surface rendered over a dimmed backdrop. */
export function AlertDialogContent({ className, ...props }: AlertDialogContentProps) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={overlay} />
      <AlertDialogPrimitive.Content className={cn(panel, className)} {...props} />
    </AlertDialogPrimitive.Portal>
  );
}

/** Accessible heading of the alert dialog. */
export function AlertDialogTitle({ className, ...props }: AlertDialogTitleProps) {
  return <AlertDialogPrimitive.Title className={cn(heading, className)} {...props} />;
}

/** Concise explanation of the consequence of confirming. */
export function AlertDialogDescription({ className, ...props }: AlertDialogDescriptionProps) {
  return <AlertDialogPrimitive.Description className={cn(description, className)} {...props} />;
}

/** Primary confirmation button inside an alert dialog. */
export function AlertDialogAction({ className, ...props }: AlertDialogActionProps) {
  return <AlertDialogPrimitive.Action className={cn(buttonVariants({ variant: "destructive" }), className)} {...props} />;
}

/** Secondary dismissal button inside an alert dialog. */
export function AlertDialogCancel({ className, ...props }: AlertDialogCancelProps) {
  return <AlertDialogPrimitive.Cancel className={cn(buttonVariants({ variant: "outline" }), className)} {...props} />;
}
