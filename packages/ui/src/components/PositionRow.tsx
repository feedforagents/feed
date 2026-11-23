import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";

export interface PositionRowData {
  /** Position identifier. */
  id: string;
  /** Prediction market or leveraged perp contract. */
  kind: "prediction" | "perp";
  /** Market question or ticker name. */
  marketLabel: string;
  /** Position direction. */
  side: "YES" | "NO" | "Long" | "Short";
  /** Formatted share count or notional size. */
  quantityLabel: string;
  /** Leverage multiple for perp positions (`1..20`). */
  leverage?: number;
  /** Entry price or average share price. */
  entryLabel: string;
  /** Current mark price or live implied probability. */
  markLabel: string;
  /** Unrealized P&L in points (`pts`). */
  pnlPts: number;
  /** Estimated liquidation mark price for perp positions. */
  liquidationLabel?: string;
}

export type PositionRowProps = Omit<ComponentProps<"div">, "children"> & {
  /** Open position summary to render. */
  position: PositionRowData;
  /** Closes or sells the position. */
  onClose?: (id: string) => void;
  /** True while closing is in flight. */
  loading?: boolean;
  /** Disables closing. */
  disabled?: boolean;
};

/** Displays an open prediction or perpetual position with mark-to-market P&L, liquidation level, and close control. */
export function PositionRow({ position, onClose, loading = false, disabled = false, className, ...props }: PositionRowProps) {
  const bullish = position.side === "YES" || position.side === "Long";
  const positivePnl = position.pnlPts >= 0;
  const blocked = disabled || loading;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border bg-card px-4 py-3.5 text-card-foreground sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={bullish ? "ok" : "destructive"}>{position.side}</Badge>
          {position.leverage ? <Badge variant="outline" className="font-mono">{position.leverage}x</Badge> : null}
          <span className="truncate text-sm font-semibold text-foreground">{position.marketLabel}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
          <span>Size {position.quantityLabel}</span>
          <span>Entry {position.entryLabel}</span>
          <span>Mark {position.markLabel}</span>
          {position.liquidationLabel ? <span className="text-warn">Liq {position.liquidationLabel}</span> : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <span className={cn("font-mono text-sm font-semibold tabular-nums", positivePnl ? "text-ok" : "text-destructive")}>
          {formatPts(position.pnlPts, true)}
        </span>
        {onClose ? (
          <Button
            variant="outline"
            size="sm"
            loading={loading}
            disabled={blocked}
            onClick={() => {
              if (!blocked) onClose(position.id);
            }}
          >
            Close
          </Button>
        ) : null}
      </div>
    </div>
  );
}
