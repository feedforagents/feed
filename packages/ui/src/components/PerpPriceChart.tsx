import { type ComponentProps, useMemo } from "react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./Badge.tsx";
import {
  LightweightChartBase,
  type LightweightChartSeriesSpec,
  type MarketTimeRange,
} from "./LightweightChartBase.tsx";

export interface PerpPricePoint {
  /** Timestamp in milliseconds (or Unix seconds). */
  time: number;
  /** Mark price in virtual points (`pts`). */
  price: number;
}

export type PerpPriceChartProps = Omit<ComponentProps<"div">, "children"> & {
  /** Perpetual ticker symbol such as `SAMALT`. */
  ticker: string;
  /** Historical price series points. */
  data: readonly PerpPricePoint[];
  /** Live current mark price. */
  currentPrice: number;
  /** Active time range filter. */
  timeRange: MarketTimeRange;
  /** Invoked when the user selects a timeframe pill. */
  onTimeRangeChange: (range: MarketTimeRange) => void;
  /** Displays the live price + delta header alongside timeframe controls. */
  showHeader?: boolean;
  /** Stretches the chart to fill its flex parent height. */
  fillHeight?: boolean;
  /** Fixed chart height in pixels when `fillHeight` is false. */
  height?: number;
  /** Shows loading state overlay while history loads. */
  loading?: boolean;
  /** Optional error state message. */
  error?: string;
  /** Formats price values on the header and axis. */
  formatPrice?: (price: number) => string;
};

const RANGE_MS: Record<Exclude<MarketTimeRange, "ALL">, number> = {
  "1H": 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
};

function defaultFormatPrice(price: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price)} pts`;
}

function toMs(time: number): number {
  return time > 1e11 ? time : time * 1000;
}

function filterByRange(points: readonly PerpPricePoint[], timeRange: MarketTimeRange): PerpPricePoint[] {
  if (points.length === 0 || timeRange === "ALL") return [...points];
  const latestMs = points.reduce((max, pt) => Math.max(max, toMs(pt.time)), 0);
  const cutoff = latestMs - RANGE_MS[timeRange];
  const filtered = points.filter((pt) => toMs(pt.time) >= cutoff);
  return filtered.length >= 2 ? filtered : [...points];
}

/** Interactive perpetual mark-price area chart colored by period direction with a dashed live price line. */
export function PerpPriceChart({
  ticker,
  data,
  currentPrice,
  timeRange,
  onTimeRangeChange,
  showHeader = true,
  fillHeight = false,
  height = 340,
  loading = false,
  error,
  formatPrice = defaultFormatPrice,
  className,
  ...props
}: PerpPriceChartProps) {
  const visible = useMemo(() => filterByRange(data, timeRange), [data, timeRange]);

  const firstPrice = visible[0]?.price ?? currentPrice;
  const delta = currentPrice - firstPrice;
  const deltaPct = firstPrice > 0 ? (delta / firstPrice) * 100 : 0;
  const positive = delta >= 0;

  const series = useMemo<readonly LightweightChartSeriesSpec[]>(() => {
    if (visible.length === 0) return [];
    return [
      {
        kind: "area",
        tone: positive ? "ok" : "destructive",
        data: visible.map((pt) => ({ time: pt.time, value: pt.price })),
        priceLine: Number.isFinite(currentPrice) ? { price: currentPrice, title: "Mark", tone: "brand" } : undefined,
      },
    ];
  }, [visible, positive, currentPrice]);

  const headerLeft = showHeader ? (
    <div className="flex flex-wrap items-baseline gap-2.5">
      <span className="font-mono text-2xl font-bold text-foreground tabular-nums">{formatPrice(currentPrice)}</span>
      <Badge variant={positive ? "ok" : "destructive"} className="font-mono tabular-nums">
        {positive ? "+" : ""}
        {deltaPct.toFixed(2)}%
      </Badge>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {positive ? "+" : ""}
        {formatPrice(delta)} ({timeRange})
      </span>
    </div>
  ) : undefined;

  return (
    <LightweightChartBase
      ariaLabel={`$${ticker} perpetual price chart`}
      series={series}
      timeRange={showHeader ? timeRange : undefined}
      onTimeRangeChange={showHeader ? onTimeRangeChange : undefined}
      headerLeft={headerLeft}
      formatPrice={formatPrice}
      height={height}
      fillHeight={fillHeight}
      loading={loading}
      error={error}
      emptyMessage={`No price history for $${ticker} yet.`}
      className={cn(className)}
      {...props}
    />
  );
}
