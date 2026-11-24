import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";

export type ToastTone = "default" | "ok" | "warn" | "destructive" | "info";

const toneStyles: Record<ToastTone, { border: string; icon: string }> = {
  default: { border: "border-border", icon: "text-foreground" },
  ok: { border: "border-ok/30", icon: "text-ok" },
  warn: { border: "border-warn/30", icon: "text-warn" },
  destructive: { border: "border-destructive/40", icon: "text-destructive" },
  info: { border: "border-brand/30", icon: "text-primary" },
};

export type ToastBannerProps = Omit<ComponentProps<"div">, "children"> & {
  /** Primary status message shown in the toast. */
  message: string;
  /** Optional secondary detail line. */
  description?: string;
  /** Semantic tone of the toast notification. */
  tone?: ToastTone;
  /** Optional inline action button label. */
  actionLabel?: string;
  /** Invoked when the optional action button is clicked. */
  onAction?: () => void;
  /** Invoked when the dismiss button is clicked. */
  onDismiss?: () => void;
};

export type ToastProps = ToastBannerProps;

function ToastIcon({ tone }: { tone: ToastTone }) {
  const cls = cn("mt-0.5 size-4 shrink-0", toneStyles[tone].icon);
  switch (tone) {
    case "ok":
      return <CheckCircle2 aria-hidden className={cls} />;
    case "warn":
      return <AlertTriangle aria-hidden className={cls} />;
    case "destructive":
      return <XCircle aria-hidden className={cls} />;
    case "info":
    case "default":
      return <Info aria-hidden className={cls} />;
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

/** Floating status banner styled with design tokens to report results without layout shift. */
export function ToastBanner({
  message,
  description,
  tone = "default",
  actionLabel,
  onAction,
  onDismiss,
  className,
  ...props
}: ToastBannerProps) {
  return (
    <div
      role={tone === "destructive" ? "alert" : "status"}
      aria-live={tone === "destructive" ? "assertive" : "polite"}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg",
        toneStyles[tone].border,
        className,
      )}
      {...props}
    >
      <ToastIcon tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{message}</p>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className={cn(focusRing, "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold text-primary hover:bg-accent")}
        >
          {actionLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
          className={cn(focusRing, "-mr-1 shrink-0 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground")}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Floating toast notification banner. */
export const Toast = ToastBanner;

export type ToastViewportProps = {
  /** Stacked `ToastBanner` elements to position over the viewport. */
  children?: ReactNode;
  /** Additional classes for viewport positioning. */
  className?: string;
};

/** Fixed bottom-corner stack that positions floating toasts without shifting page layout. */
export function ToastViewport({ children, className }: ToastViewportProps) {
  if (!children) return null;
  return (
    <div
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed right-4 bottom-20 left-4 z-50 mx-auto flex max-w-sm flex-col gap-2 sm:bottom-6 sm:left-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
