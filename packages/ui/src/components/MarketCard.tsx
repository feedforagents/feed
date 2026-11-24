import type { ComponentProps } from "react";
import { Clock, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card.tsx";

export type PredictionMarketPhase = "PendingOpen" | "Trading" | "AwaitingProof" | "ManualReviewHold" | "Resolved" | "Cancelled";

export type MarketCardData =
  | {
      kind: "prediction";
      id: string;
      question: string;
      timeframe: string;
      phase: PredictionMarketPhase;
      yesOddsPct: number;
      liquidityPts: string;
      yesShares?: number;
      noShares?: number;
      closesIn?: string;
      resolvedOutcome?: "YES" | "NO" | "CANCELLED";
    }
  | {
      kind: "perp";
      id: string;
      ticker: string;
      name: string;
      indexPricePts: string;
      markPricePts: string;
      fundingRatePct: string;
      openInterestPts: string;
      change24hPct?: number;
      maxLeverage?: number;
    };

export type MarketCardProps = Omit<ComponentProps<"div">, "children" | "onSelect"> & {
  /** Prediction market or NPC-driven perpetual market data. */
  market: MarketCardData;
  /** Highlights the card when currently selected in a market list. */
  selected?: boolean;
  /** Opens the market detail or ticket for trading. */
  onSelect?: (marketId: string) => void;
  /** Disables selection actions. */
  disabled?: boolean;
};

const phaseMeta: Record<PredictionMarketPhase, { label: string; variant: "ok" | "warn" | "info" | "destructive" | "outline" }> = {
  PendingOpen: { label: "Opening", variant: "outline" },
  Trading: { label: "Trading", variant: "ok" },
  AwaitingProof: { label: "Awaiting proof", variant: "info" },
  ManualReviewHold: { label: "Manual review", variant: "warn" },
  Resolved: { label: "Resolved", variant: "outline" },
  Cancelled: { label: "Cancelled", variant: "destructive" },
};

/** Displays either a YES/NO CPMM prediction market or an NPC-spot-indexed perpetual contract (up to 20x). */
export function MarketCard({ market, selected = false, onSelect, disabled = false, className, ...props }: MarketCardProps) {
  if (market.kind === "prediction") {
    const yesPct = Math.min(98, Math.max(2, Math.round(market.yesOddsPct)));
    const noPct = 100 - yesPct;
    const status = phaseMeta[market.phase];

    return (
      <Card className={cn("gap-4 p-5", selected && "border-primary", className)} {...props}>
        <CardHeader className="gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="font-mono">{market.timeframe}</Badge>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            {market.closesIn ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock aria-hidden className="size-3.5" />
                {market.closesIn}
              </span>
            ) : null}
          </div>
          <CardTitle className="leading-snug">{market.question}</CardTitle>
        </CardHeader>

        <CardContent className="gap-2">
          <div className="flex items-center justify-between font-mono text-sm font-semibold tabular-nums">
            <span className="text-ok">YES {yesPct}%</span>
            <span className="text-destructive">NO {noPct}%</span>
          </div>
          <div role="img" aria-label={`YES ${yesPct} percent, NO ${noPct} percent`} className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-ok" style={{ width: `${yesPct}%` }} />
            <div className="h-full bg-destructive" style={{ width: `${noPct}%` }} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Pool liquidity {market.liquidityPts}</span>
            {market.resolvedOutcome ? <span className="font-semibold text-foreground">Outcome: {market.resolvedOutcome}</span> : null}
          </div>
        </CardContent>

        {onSelect ? (
          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground">1 pt / winning share</span>
            <Button variant={selected ? "primary" : "outline"} size="sm" disabled={disabled} onClick={() => !disabled && onSelect(market.id)}>
              Trade YES / NO
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    );
  }

  const maxLev = market.maxLeverage ?? 20;
  const positive = (market.change24hPct ?? 0) >= 0;

  return (
    <Card className={cn("gap-4 p-5", selected && "border-primary", className)} {...props}>
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-bold text-primary">${market.ticker}</span>
            <Badge variant="outline">Max {maxLev}x</Badge>
          </div>
          {market.change24hPct !== undefined ? (
            <span className={cn("inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums", positive ? "text-ok" : "text-destructive")}>
              {positive ? <TrendingUp aria-hidden className="size-3.5" /> : <TrendingDown aria-hidden className="size-3.5" />}
              {positive ? "+" : ""}
              {market.change24hPct}%
            </span>
          ) : null}
        </div>
        <CardTitle className="text-sm font-medium text-muted-foreground">{market.name}</CardTitle>
      </CardHeader>

      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Spot Index</dt>
            <dd className="font-mono text-sm font-semibold text-foreground tabular-nums">{market.indexPricePts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Mark Price</dt>
            <dd className="font-mono text-sm font-semibold text-foreground tabular-nums">{market.markPricePts}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">8h Funding</dt>
            <dd className="font-mono text-sm font-medium text-foreground tabular-nums">{market.fundingRatePct}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Open Interest</dt>
            <dd className="font-mono text-sm font-medium text-foreground tabular-nums">{market.openInterestPts}</dd>
          </div>
        </dl>
      </CardContent>

      {onSelect ? (
        <CardFooter>
          <Button variant={selected ? "primary" : "outline"} size="sm" disabled={disabled} onClick={() => !disabled && onSelect(market.id)}>
            Trade Perp
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
