import { type ComponentProps, useMemo } from "react";
import { filterChartPointsByRange } from "../lib/chart.ts";
import { cn } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
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
  formatPrice = formatPts,
  className,
  ...props
}: PerpPriceChartProps) {
  const safeFormatPrice = (value: number): string => {
    const formatted = formatPrice(value);
    return typeof formatted === "string" ? formatted : formatPts(value);
  };
  const visible = useMemo(() => filterChartPointsByRange(data, timeRange), [data, timeRange]);

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
        priceLine: Number.isFinite(currentPrice)
          ? { price: currentPrice, title: "Mark", tone: "brand", axisLabelVisible: false }
          : undefined,
      },
    ];
  }, [visible, positive, currentPrice]);

  const showDelta = !loading && visible.length > 0;
  const headerLeft = showHeader ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-mono text-2xl font-bold whitespace-nowrap text-foreground tabular-nums">{safeFormatPrice(currentPrice)}</span>
      {showDelta ? (
        <>
          <Badge variant={positive ? "ok" : "destructive"} className="shrink-0 font-mono whitespace-nowrap tabular-nums">
            {positive ? "+" : ""}
            {deltaPct.toFixed(2)}%
          </Badge>
          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {positive ? "+" : ""}
            {safeFormatPrice(delta)} ({timeRange})
          </span>
        </>
      ) : null}
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
