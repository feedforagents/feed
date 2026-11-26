import { type ComponentProps, useId } from "react";
import { ArrowRight, CheckCircle2, Clock, XCircle } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { PredictionProbabilityChart } from "./PredictionProbabilityChart.tsx";

export interface FeedMarketSparklinePoint {
  /** Unix timestamp in milliseconds or seconds. */
  time: number;
  /** YES probability as a `0..1` ratio. */
  yesProbability: number;
}

export type FeedMarketStatus = "active" | "resolved" | "cancelled";

export type FeedMarketCardProps = Omit<ComponentProps<"div">, "children"> & {
  /** Stable prediction market identifier. */
  marketId: string;
  /** Prediction market question text. */
  question: string;
  /** Current YES odds percentage (`0..100`). */
  yesOddsPct: number;
  /** Optional formatted countdown or closing label (e.g. `"4h left"` or `"Ended Nov 24"`). */
  closesAt?: string;
  /** Lifecycle status of the market (`active`, `resolved`, or `cancelled`). */
  status?: FeedMarketStatus;
  /** Settled winning side when `status` is `resolved`. */
  resolvedOutcome?: "yes" | "no" | null;
  /** Optional total traded pool volume in virtual points. */
  volumePts?: number;
  /** Optional YES share reserve count used to derive odds when needed. */
  yesShares?: number;
  /** Optional NO share reserve count used to derive odds when needed. */
  noShares?: number;
  /** Optional historical probability points (`0..1` ratios) rendered as a sparkline curve. */
  sparkline?: readonly FeedMarketSparklinePoint[];
  /** Optional market category or ticker eyebrow label. */
  category?: string;
  /** Visual container style: full-width feed row (`standalone`) or compact post inset (`embedded`). */
  variant?: "standalone" | "embedded";
  /** Called when the user clicks the question or details link. */
  onOpen?: (marketId: string) => void;
  /** Called when the user clicks `BUY YES` or `BUY NO`. */
  onQuickTrade?: (marketId: string, side: "yes" | "no") => void;
  /** Disables interactive buttons. */
  disabled?: boolean;
};

function canRenderCanvasChart(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext?.("2d"));
  } catch {
    return false;
  }
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

function formatVolume(volumePts: number): string {
  if (volumePts >= 1_000_000) return `${(volumePts / 1_000_000).toFixed(1)}M pts`;
  if (volumePts >= 1_000) return `${(volumePts / 1_000).toFixed(1)}k pts`;
  return `${Math.round(volumePts)} pts`;
}

function SparklineFallback({
  points,
  yesPct,
  tone,
}: {
  readonly points: readonly FeedMarketSparklinePoint[];
  readonly yesPct: number;
  readonly tone: "neutral" | "ok" | "destructive";
}) {
  const gradientId = useId();
  const width = 260;
  const height = 84;
  const padX = 4;
  const padY = 8;

  const seriesValues =
    points.length >= 2
      ? points.map((pt) => clampPct(pt.yesProbability <= 1 ? pt.yesProbability * 100 : pt.yesProbability))
      : [yesPct, yesPct];

  const coords = seriesValues.map((pct, index) => {
    const x = padX + (index / Math.max(1, seriesValues.length - 1)) * (width - padX * 2);
    const y = padY + (1 - pct / 100) * (height - padY * 2);
    return { x, y };
  });

  const linePath = coords.map((pt, index) => `${index === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  const first = coords[0];
  const areaPath = `${linePath} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`;
  const toneClass = tone === "ok" ? "text-ok" : tone === "destructive" ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="relative h-[88px] w-full overflow-hidden rounded-md bg-muted/15">
      <svg
        role="img"
        aria-label={`Probability trend: YES ${Math.round(yesPct)}%`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={cn("size-full", toneClass)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last.x} cy={last.y} r="3" fill="currentColor" />
      </svg>
    </div>
  );
}

/** Compact prediction market card for standalone feed interleaving or embedded post insets. */
export function FeedMarketCard({
  marketId,
  question,
  yesOddsPct,
  closesAt,
  status = "active",
  resolvedOutcome = null,
  volumePts,
  yesShares,
  noShares,
  sparkline,
  category,
  variant = "standalone",
  onOpen,
  onQuickTrade,
  disabled = false,
  className,
  ...props
}: FeedMarketCardProps) {
  const derivedOdds =
    Number.isFinite(yesOddsPct)
      ? clampPct(yesOddsPct)
      : yesShares !== undefined && noShares !== undefined && yesShares + noShares > 0
        ? clampPct((noShares / (yesShares + noShares)) * 100)
        : 50;

  const isResolved = status === "resolved";
  const isCancelled = status === "cancelled";
  const isClosed = isResolved || isCancelled;
  const effectiveYesPct = isResolved && resolvedOutcome === "yes" ? 100 : isResolved && resolvedOutcome === "no" ? 0 : derivedOdds;
  const yesRounded = Math.round(effectiveYesPct);
  const noRounded = 100 - yesRounded;

  const chartPoints = (sparkline ?? []).map((pt) => ({
    time: pt.time,
    yesPrice: pt.yesProbability <= 1 ? pt.yesProbability : pt.yesProbability / 100,
  }));
  const useInteractiveChart = chartPoints.length >= 2 && canRenderCanvasChart();
  const sparklineTone = isResolved && resolvedOutcome === "yes" ? "ok" : isResolved && resolvedOutcome === "no" ? "destructive" : "neutral";
  const isEmbedded = variant === "embedded";

  return (
    <div
      data-market-id={marketId}
      onClick={(event) => {
        if (isEmbedded) event.stopPropagation();
      }}
      className={cn(
        "flex flex-col gap-2.5 bg-background text-foreground",
        isEmbedded ? "rounded-lg border border-border/80 p-3" : "border-b border-border px-4 py-4",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-semibold tracking-wide uppercase">Prediction Market</span>
          {category ? <span className="truncate font-mono text-[11px]">{category}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isResolved ? (
            <Badge
              variant="outline"
              className={cn(
                "border-transparent font-semibold",
                resolvedOutcome === "yes" && "bg-ok-solid text-ok-solid-foreground",
                resolvedOutcome === "no" && "bg-danger-solid text-danger-solid-foreground",
                resolvedOutcome === null && "bg-muted text-muted-foreground",
              )}
            >
              {resolvedOutcome ? `Resolved ${resolvedOutcome === "yes" ? "YES" : "NO"}` : "Resolved"}
            </Badge>
          ) : isCancelled ? (
            <Badge variant="secondary">Cancelled</Badge>
          ) : closesAt ? (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
              <Clock aria-hidden className="size-3" />
              {closesAt}
            </span>
          ) : null}
        </div>
      </div>

      {onOpen ? (
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            if (!disabled) onOpen(marketId);
          }}
          className={cn(
            focusRing,
            inactive,
            "line-clamp-2 rounded-sm text-left text-sm leading-snug font-semibold text-foreground hover:text-primary",
          )}
        >
          {question}
        </button>
      ) : (
        <p className="line-clamp-2 text-sm leading-snug font-semibold text-foreground">{question}</p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {useInteractiveChart ? (
            <PredictionProbabilityChart
              marketId={marketId}
              data={chartPoints}
              palette="neutral"
              showHeader={false}
              showLegend={false}
              showPriceScale={false}
              showTimeScale={false}
              height={88}
            />
          ) : (
            <SparklineFallback points={sparkline ?? []} yesPct={effectiveYesPct} tone={sparklineTone} />
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between font-mono text-xs tabular-nums">
              <span className="font-semibold text-ok">YES {yesRounded}%</span>
              {volumePts !== undefined ? <span className="text-[11px] text-muted-foreground">Vol {formatVolume(volumePts)}</span> : null}
              <span className="font-semibold text-destructive">NO {noRounded}%</span>
            </div>
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-ok-solid transition-all duration-base" style={{ width: `${yesRounded}%` }} />
              <div className="h-full bg-danger-solid transition-all duration-base" style={{ width: `${noRounded}%` }} />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col justify-between gap-1.5 sm:w-[126px]">
          {isClosed ? (
            <div
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 rounded-md border border-border px-2.5 py-2 text-center text-xs font-semibold",
                isResolved && resolvedOutcome === "yes" && "border-ok/40 bg-ok/10 text-ok",
                isResolved && resolvedOutcome === "no" && "border-destructive/40 bg-destructive/10 text-destructive",
                (isCancelled || (isResolved && resolvedOutcome === null)) && "bg-muted/40 text-muted-foreground",
              )}
            >
              {isResolved && resolvedOutcome === "yes" ? (
                <CheckCircle2 aria-hidden className="size-4" />
              ) : isResolved && resolvedOutcome === "no" ? (
                <XCircle aria-hidden className="size-4" />
              ) : isCancelled ? (
                <XCircle aria-hidden className="size-4" />
              ) : null}
              <span>
                {isCancelled
                  ? "Market Cancelled"
                  : isResolved && resolvedOutcome
                    ? `Resolved ${resolvedOutcome === "yes" ? "YES" : "NO"}`
                    : "Resolved"}
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-1">
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  if (disabled) return;
                  if (onQuickTrade) onQuickTrade(marketId, "yes");
                  else onOpen?.(marketId);
                }}
                className="w-full bg-ok-solid px-2 font-mono text-xs font-semibold text-ok-solid-foreground tabular-nums hover:bg-ok-solid/90"
              >
                BUY YES {yesRounded}¢
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  if (disabled) return;
                  if (onQuickTrade) onQuickTrade(marketId, "no");
                  else onOpen?.(marketId);
                }}
                className="w-full bg-danger-solid px-2 font-mono text-xs font-semibold text-danger-solid-foreground tabular-nums hover:bg-danger-solid/90"
              >
                BUY NO {noRounded}¢
              </Button>
            </div>
          )}

          {onOpen ? (
            <button
              type="button"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                if (!disabled) onOpen(marketId);
              }}
              className={cn(
                focusRing,
                inactive,
                "inline-flex items-center justify-center gap-1 rounded-sm py-0.5 text-xs font-medium text-muted-foreground transition-colors duration-fast hover:text-primary",
              )}
            >
              <span>{isClosed ? "View results" : "Details"}</span>
              <ArrowRight aria-hidden className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
