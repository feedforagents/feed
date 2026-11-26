import { AlertTriangle, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Alert } from "./Alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./AlertDialog.tsx";
import { Badge } from "./Badge.tsx";
import { buttonVariants } from "./Button.tsx";

export type TradeConfirmationDetails =
  | {
      kind: "open-perp";
      ticker: string;
      side: "long" | "short";
      marginPts: number;
      notionalPts: number;
      leverage: number;
      entryPrice: number;
      estimatedFeePts: number;
      totalRequiredPts: number;
      liquidationPrice: number;
      liquidationDistancePct: number;
    }
  | {
      kind: "close-perp";
      ticker: string;
      side: "long" | "short";
      notionalPts: number;
      leverage: number;
      entryPrice: number;
      markPrice: number;
      estimatedFeePts: number;
      unrealizedPnlPts: number;
      unrealizedPnlPct: number;
    }
  | {
      kind: "rebalance-perp";
      action: "add" | "reduce" | "flip";
      ticker: string;
      currentSide: "long" | "short";
      nextSide: "long" | "short";
      currentNotionalPts: number;
      deltaNotionalPts: number;
      resultingNotionalPts: number;
      leverage: number;
      entryPrice: number;
      estimatedFeePts: number;
      totalRequiredPts: number;
      liquidationPrice?: number;
      liquidationDistancePct?: number;
    }
  | {
      kind: "buy-prediction";
      question: string;
      side: "YES" | "NO";
      amountPts: number;
      estimatedShares: number;
      avgPricePct: number;
      priceImpactPct: number;
      estimatedFeePts: number;
      estimatedPayoutPts: number;
      estimatedRoiPct: number;
    }
  | {
      kind: "sell-prediction";
      question: string;
      side: "YES" | "NO";
      shares: number;
      avgPricePct: number;
      grossProceedsPts: number;
      estimatedFeePts: number;
      netProceedsPts: number;
      unrealizedPnlPts?: number;
    };

export interface TradeConfirmationDialogProps {
  /** Controls whether the confirmation modal is visible. */
  open: boolean;
  /** Called when the modal open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Invoked when the user confirms execution of the trade. */
  onConfirm: () => void;
  /** Structured trade details to review before submission. */
  details: TradeConfirmationDetails | null;
  /** Disables confirmation controls while submitting. */
  submitting?: boolean;
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "destructive" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-mono font-semibold tabular-nums",
          tone === "ok"
            ? "text-ok"
            : tone === "destructive"
              ? "text-destructive"
              : tone === "warn"
                ? "text-warn"
                : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function renderHeading(details: TradeConfirmationDetails): { title: string; description: string; destructive: boolean } {
  switch (details.kind) {
    case "open-perp":
      return {
        title: `Confirm ${details.side === "long" ? "Long" : "Short"} $${details.ticker}`,
        description: `Open a ${details.leverage}x ${details.side} perpetual position on $${details.ticker}.`,
        destructive: details.side === "short",
      };
    case "close-perp":
      return {
        title: `Confirm Close $${details.ticker}`,
        description: `Close your ${details.leverage}x ${details.side} perpetual position on $${details.ticker}.`,
        destructive: details.unrealizedPnlPts < 0,
      };
    case "rebalance-perp": {
      const verb = details.action === "add" ? "Add to" : details.action === "reduce" ? "Reduce" : "Flip";
      return {
        title: `Confirm ${verb} $${details.ticker}`,
        description:
          details.action === "flip"
            ? `Close ${details.currentSide.toUpperCase()} and open ${details.nextSide.toUpperCase()} at ${details.leverage}x on $${details.ticker}.`
            : `${verb} your ${details.currentSide.toUpperCase()} position on $${details.ticker}.`,
        destructive: details.action === "flip" && details.nextSide === "short",
      };
    }
    case "buy-prediction":
      return {
        title: `Confirm Buy ${details.side}`,
        description: details.question,
        destructive: details.side === "NO",
      };
    case "sell-prediction":
      return {
        title: `Confirm Sell ${details.side}`,
        description: details.question,
        destructive: false,
      };
  }
}

function collectWarnings(details: TradeConfirmationDetails): string[] {
  const warnings: string[] = [];
  if (details.kind === "open-perp") {
    if (details.leverage >= 10) {
      warnings.push(`High leverage (${details.leverage}x) increases liquidation risk on sharp moves.`);
    }
    if (details.liquidationDistancePct < 10) {
      warnings.push(`Liquidation price is only ${details.liquidationDistancePct.toFixed(1)}% from entry.`);
    }
  } else if (details.kind === "rebalance-perp") {
    if (details.leverage >= 10) {
      warnings.push(`High leverage (${details.leverage}x) magnifies volatility on the rebalanced position.`);
    }
    if (details.liquidationDistancePct !== undefined && details.liquidationDistancePct < 10) {
      warnings.push(`Resulting liquidation distance is tight (${details.liquidationDistancePct.toFixed(1)}%).`);
    }
  } else if (details.kind === "buy-prediction" && details.priceImpactPct >= 5) {
    warnings.push(`High CPMM price impact (${details.priceImpactPct.toFixed(2)}%) on this order size.`);
  }
  return warnings;
}

function DetailsSummary({ details }: { details: TradeConfirmationDetails }) {
  switch (details.kind) {
    case "open-perp":
      return (
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3.5">
          <SummaryRow label="Direction" value={`${details.side.toUpperCase()} · ${details.leverage}x`} tone={details.side === "long" ? "ok" : "destructive"} />
          <SummaryRow label="Margin" value={formatPts(details.marginPts)} />
          <SummaryRow label="Notional Size" value={formatPts(details.notionalPts)} />
          <SummaryRow label="Est. Entry" value={formatPts(details.entryPrice)} />
          <SummaryRow
            label="Est. Liquidation"
            value={`${formatPts(details.liquidationPrice)} (${details.liquidationDistancePct.toFixed(1)}%)`}
            tone={details.liquidationDistancePct < 10 ? "warn" : undefined}
          />
          <SummaryRow label="Fee" value={formatPts(details.estimatedFeePts)} />
          <SummaryRow label="Total Required" value={formatPts(details.totalRequiredPts)} />
        </dl>
      );
    case "close-perp":
      return (
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3.5">
          <SummaryRow label="Position" value={`${details.side.toUpperCase()} ${details.leverage}x · ${formatPts(details.notionalPts)}`} />
          <SummaryRow label="Entry / Mark" value={`${formatPts(details.entryPrice)} / ${formatPts(details.markPrice)}`} />
          <SummaryRow label="Est. Fee" value={formatPts(details.estimatedFeePts)} />
          <SummaryRow
            label="Est. Realized PnL"
            value={`${formatPts(details.unrealizedPnlPts, true)} (${details.unrealizedPnlPct >= 0 ? "+" : ""}${details.unrealizedPnlPct.toFixed(1)}%)`}
            tone={details.unrealizedPnlPts >= 0 ? "ok" : "destructive"}
          />
        </dl>
      );
    case "rebalance-perp":
      return (
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3.5">
          <SummaryRow label="Action" value={`${details.action.toUpperCase()} → ${details.nextSide.toUpperCase()} ${details.leverage}x`} />
          <SummaryRow label="Current Size" value={formatPts(details.currentNotionalPts)} />
          <SummaryRow label="Order Delta" value={formatPts(details.deltaNotionalPts)} />
          <SummaryRow label="Resulting Size" value={formatPts(details.resultingNotionalPts)} />
          <SummaryRow label="Est. Price" value={formatPts(details.entryPrice)} />
          {details.liquidationPrice !== undefined ? (
            <SummaryRow
              label="Est. Liquidation"
              value={formatPts(details.liquidationPrice)}
              tone={details.liquidationDistancePct !== undefined && details.liquidationDistancePct < 10 ? "warn" : undefined}
            />
          ) : null}
          <SummaryRow label="Est. Fee" value={formatPts(details.estimatedFeePts)} />
          <SummaryRow label="Additional Required" value={formatPts(details.totalRequiredPts)} />
        </dl>
      );
    case "buy-prediction":
      return (
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3.5">
          <SummaryRow label="Side" value={details.side} tone={details.side === "YES" ? "ok" : "destructive"} />
          <SummaryRow label="Spend" value={formatPts(details.amountPts)} />
          <SummaryRow label="Est. Shares" value={details.estimatedShares.toFixed(2)} />
          <SummaryRow label="Avg Price" value={`${details.avgPricePct.toFixed(1)}%`} />
          <SummaryRow
            label="Price Impact"
            value={`${details.priceImpactPct.toFixed(2)}%`}
            tone={details.priceImpactPct >= 5 ? "warn" : undefined}
          />
          <SummaryRow label="Fee" value={formatPts(details.estimatedFeePts)} />
          <SummaryRow
            label="Est. Payout (ROI)"
            value={`${formatPts(details.estimatedPayoutPts)} (+${details.estimatedRoiPct.toFixed(1)}%)`}
            tone="ok"
          />
        </dl>
      );
    case "sell-prediction":
      return (
        <dl className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3.5">
          <SummaryRow label="Side" value={details.side} tone={details.side === "YES" ? "ok" : "destructive"} />
          <SummaryRow label="Shares" value={details.shares.toFixed(2)} />
          <SummaryRow label="Avg Price" value={`${details.avgPricePct.toFixed(1)}%`} />
          <SummaryRow label="Gross Proceeds" value={formatPts(details.grossProceedsPts)} />
          <SummaryRow label="Fee" value={formatPts(details.estimatedFeePts)} />
          <SummaryRow label="Net Proceeds" value={formatPts(details.netProceedsPts)} tone="ok" />
          {details.unrealizedPnlPts !== undefined ? (
            <SummaryRow
              label="Est. PnL"
              value={formatPts(details.unrealizedPnlPts, true)}
              tone={details.unrealizedPnlPts >= 0 ? "ok" : "destructive"}
            />
          ) : null}
        </dl>
      );
  }
}

/** Pre-execution trade confirmation dialog with liquidation, leverage, and CPMM price-impact warnings. */
export function TradeConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  details,
  submitting = false,
}: TradeConfirmationDialogProps) {
  if (!details) return null;

  const { title, description, destructive } = renderHeading(details);
  const warnings = collectWarnings(details);
  const Icon =
    details.kind === "rebalance-perp"
      ? RefreshCw
      : details.kind === "open-perp" || details.kind === "close-perp"
        ? details.side === "long"
          ? TrendingUp
          : TrendingDown
        : details.side === "YES"
          ? TrendingUp
          : TrendingDown;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant={destructive ? "destructive" : "ok"} className="size-7 justify-center p-0">
              <Icon aria-hidden className="size-4" />
            </Badge>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </div>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <DetailsSummary details={details} />

        {warnings.length > 0 ? (
          <div className="flex flex-col gap-2">
            {warnings.map((warning) => (
              <Alert key={warning} variant="warn">
                <div className="flex items-start gap-2">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{warning}</span>
                </div>
              </Alert>
            ))}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              if (!submitting) onConfirm();
            }}
            className={cn(buttonVariants({ variant: destructive ? "destructive" : "primary" }))}
          >
            {submitting ? "Submitting…" : "Confirm Trade"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
