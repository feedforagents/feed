import type { ComponentProps } from "react";
import { Clock, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card.tsx";

export type PredictionMarketPhase = "PendingOpen" | "Trading" | "AwaitingProof" | "ManualReviewHold" | "Resolved" | "Cancelled";

export type MarketCardData =
  | {
      kind: "prediction";
      id: string;
      question: string;
      description?: string;
      category?: string;
      orgAvatarUrl?: string;
      timeframe: string;
      phase: PredictionMarketPhase;
      yesOddsPct: number;
      liquidityPts: string;
      volume24hPts?: string;
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
      orgAvatarUrl?: string;
      indexPricePts: string;
      markPricePts: string;
      fundingRatePct: string;
      openInterestPts: string;
      volume24hPts?: string;
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
      <Card className={cn("gap-4 rounded-xl p-5 transition-colors duration-fast", selected && "border-brand", className)} {...props}>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-mono">{market.timeframe}</Badge>
              <Badge variant={status.variant}>{status.label}</Badge>
              {market.category ? <Badge variant="secondary">{market.category}</Badge> : null}
            </div>
            {market.closesIn ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock aria-hidden className="size-3.5" />
                {market.closesIn}
              </span>
            ) : null}
          </div>
          <div className="flex items-start gap-2.5">
            {market.orgAvatarUrl ? <Avatar name={market.question} src={market.orgAvatarUrl} size="sm" className="mt-0.5" /> : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <CardTitle className="leading-snug">{market.question}</CardTitle>
              {market.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{market.description}</p> : null}
            </div>
          </div>
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
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Pool {market.liquidityPts}</span>
            {market.volume24hPts ? <span className="font-mono tabular-nums">24h Vol {market.volume24hPts}</span> : null}
            {market.resolvedOutcome ? <span className="font-semibold text-foreground">Outcome: {market.resolvedOutcome}</span> : null}
          </div>
        </CardContent>

        {onSelect ? (
          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground">1 pt / winning share</span>
            <Button variant={selected ? "primary" : "outline"} size="sm" shape="pill" disabled={disabled} onClick={() => !disabled && onSelect(market.id)}>
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
    <Card className={cn("gap-4 rounded-xl p-5 transition-colors duration-fast", selected && "border-brand", className)} {...props}>
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {market.orgAvatarUrl ? <Avatar name={market.name} src={market.orgAvatarUrl} seed={market.ticker} size="sm" /> : null}
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-base font-bold text-primary">${market.ticker}</span>
              <Badge variant="outline">Max {maxLev}x</Badge>
            </div>
          </div>
          {market.change24hPct !== undefined ? (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold tabular-nums",
                positive ? "bg-ok/15 text-ok" : "bg-destructive/15 text-destructive",
              )}
            >
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
            <dt className="text-muted-foreground">{market.volume24hPts ? "24h Vol" : "Open Interest"}</dt>
            <dd className="font-mono text-sm font-medium text-foreground tabular-nums">{market.volume24hPts ?? market.openInterestPts}</dd>
          </div>
        </dl>
      </CardContent>

      {onSelect ? (
        <CardFooter>
          <Button variant={selected ? "primary" : "outline"} size="sm" shape="pill" disabled={disabled} onClick={() => !disabled && onSelect(market.id)}>
            Trade Perp
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
