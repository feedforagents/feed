import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const alertVariants = cva("flex items-center gap-3 rounded-md border-l-4 bg-muted px-4 py-3 text-sm text-foreground", {
  variants: { variant: { info: "border-info", ok: "border-ok", warn: "border-warn", destructive: "border-destructive" } },
  defaultVariants: { variant: "info" },
});

export type AlertProps = ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /** Optional action button placed at the trailing edge of the alert. */
    action?: ReactNode;
  };

/** A message about what just happened. `warn` and `destructive` interrupt a screen reader; the others wait their turn. */
export function Alert({ variant, action, className, children, ...props }: AlertProps) {
  const urgent = variant === "warn" || variant === "destructive";
  return (
    <div role={urgent ? "alert" : "status"} className={cn(alertVariants({ variant }), className)} {...props}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
