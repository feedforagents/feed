import type { ComponentProps } from "react";
import { cn, focusRing } from "../lib/cn.ts";
import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";

export type UiMode = "GameMode" | "SocialMode";

export type ModeToggleProps = Omit<ComponentProps<"div">, "children"> & {
  /** Active presentation mode (`GameMode` shows markets; `SocialMode` hides financial surfaces). */
  mode: UiMode;
  /** Called with the toggled mode when switched. */
  onModeChange?: (nextMode: UiMode) => void;
  /** Optional alias for `onModeChange` when toggled. */
  onToggle?: (nextMode: UiMode) => void;
  /** Displays a warning notice in `SocialMode` when the user still holds open positions. */
  hasAtRiskOpenPositions?: boolean;
  /** Optional quick button on the warning notice to switch back to `GameMode`. */
  onReturnToGame?: () => void;
  /** Render only the compact segmented pill control without surrounding card copy. */
  compact?: boolean;
  /** Disables the mode toggle while saving. */
  loading?: boolean;
  /** Disables the mode toggle. */
  disabled?: boolean;
};

/**
 * Unified `Game | Social` pill toggle switching between `GameMode` and `SocialMode` and warning when open positions remain at risk.
 * @model spec/app/navigation.md
 */
export function ModeToggle({
  mode,
  onModeChange,
  onToggle,
  hasAtRiskOpenPositions = false,
  onReturnToGame,
  compact = false,
  loading = false,
  disabled = false,
  className,
  ...props
}: ModeToggleProps) {
  const isSocial = mode === "SocialMode";
  const blocked = disabled || loading;

  const triggerToggle = () => {
    if (blocked) return;
    const next: UiMode = isSocial ? "GameMode" : "SocialMode";
    onModeChange?.(next);
    onToggle?.(next);
  };

  const pillControl = (
    <button
      type="button"
      role="switch"
      aria-checked={isSocial}
      aria-label="Social mode"
      aria-busy={loading || undefined}
      disabled={blocked}
      onClick={triggerToggle}
      className={cn(
        focusRing,
        "inline-flex shrink-0 items-center rounded-full border border-border bg-muted p-0.5 text-xs font-semibold transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          "rounded-full px-3 py-1 transition-colors duration-fast",
          !isSocial ? "bg-feed-brand text-feed-brand-foreground shadow-sm" : "text-muted-foreground",
        )}
      >
        Game
      </span>
      <span
        className={cn(
          "rounded-full px-3 py-1 transition-colors duration-fast",
          isSocial ? "bg-feed-brand text-feed-brand-foreground shadow-sm" : "text-muted-foreground",
        )}
      >
        Social
      </span>
    </button>
  );

  if (compact) {
    return (
      <div className={cn("inline-flex items-center", className)} {...props}>
        {pillControl}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} {...props}>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">Presentation mode</span>
          <span className="text-xs text-muted-foreground">
            {isSocial ? "Markets, balances, P&L, and cashtags hidden." : "Full game mode with prediction and perp markets."}
          </span>
        </div>
        {pillControl}
      </div>
      {isSocial && hasAtRiskOpenPositions ? (
        <Alert
          variant="warn"
          action={
            onReturnToGame ? (
              <Button
                variant="outline"
                size="sm"
                shape="pill"
                disabled={blocked}
                onClick={() => {
                  if (!blocked) onReturnToGame();
                }}
              >
                View markets
              </Button>
            ) : undefined
          }
        >
          You still hold open positions that can settle or liquidate while financial surfaces are hidden.
        </Alert>
      ) : null}
    </div>
  );
}
