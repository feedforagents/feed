import { type ComponentProps, useId } from "react";
import { cn } from "../lib/cn.ts";
import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";
import { Label } from "./Label.tsx";
import { Switch } from "./Switch.tsx";

export type UiMode = "GameMode" | "SocialMode";

export type ModeToggleProps = Omit<ComponentProps<"div">, "children"> & {
  /** Active presentation mode (`GameMode` shows markets; `SocialMode` hides financial surfaces). */
  mode: UiMode;
  /** Called with the toggled mode when switched. */
  onModeChange: (nextMode: UiMode) => void;
  /** Displays a warning notice in `SocialMode` when the user still holds open positions. */
  hasAtRiskOpenPositions?: boolean;
  /** Optional quick button on the warning notice to switch back to `GameMode`. */
  onReturnToGame?: () => void;
  /** Disables the mode toggle while saving. */
  loading?: boolean;
  /** Disables the mode toggle. */
  disabled?: boolean;
};

/**
 * Switches between `GameMode` and `SocialMode` and warns in `SocialMode` when open positions remain at risk.
 * @model spec/app/navigation.md
 */
export function ModeToggle({
  mode,
  onModeChange,
  hasAtRiskOpenPositions = false,
  onReturnToGame,
  loading = false,
  disabled = false,
  className,
  ...props
}: ModeToggleProps) {
  const id = useId();
  const isSocial = mode === "SocialMode";
  const blocked = disabled || loading;

  return (
    <div className={cn("flex flex-col gap-3", className)} {...props}>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={id}>Social mode</Label>
          <span className="text-xs text-muted-foreground">
            {isSocial ? "Markets, balances, P&L, and cashtags hidden." : "Full game mode with prediction and perp markets."}
          </span>
        </div>
        <Switch
          id={id}
          checked={isSocial}
          loading={loading}
          disabled={disabled}
          onCheckedChange={(checked) => {
            if (!blocked) onModeChange(checked ? "SocialMode" : "GameMode");
          }}
        />
      </div>
      {isSocial && hasAtRiskOpenPositions ? (
        <Alert
          variant="warn"
          action={
            onReturnToGame ? (
              <Button
                variant="outline"
                size="sm"
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
