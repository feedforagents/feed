import { type ComponentProps, useMemo } from "react";
import { filterChartPointsByRange } from "../lib/chart.ts";
import { cn } from "../lib/cn.ts";
import {
  LightweightChartBase,
  type LightweightChartSeriesSpec,
  type MarketTimeRange,
} from "./LightweightChartBase.tsx";

export interface PredictionProbabilityPoint {
  /** Timestamp in milliseconds (or Unix seconds). */
  time: number;
  /** YES probability as a `0..1` ratio by default (or `0..100` when `unit="percent"`). */
  yesPrice: number;
  /** Optional NO probability using the same unit as `yesPrice`. */
  noPrice?: number;
  /** Optional volume for the interval. */
  volume?: number;
}

export type PredictionChartPalette = "classic" | "neutral";

export type PredictionProbabilityUnit = "ratio" | "percent";

export type PredictionProbabilityChartProps = Omit<ComponentProps<"div">, "children"> & {
  /** Optional market identifier attached as a data attribute. */
  marketId?: string;
  /** Historical YES/NO probability curve points. */
  data: readonly PredictionProbabilityPoint[];
  /** Active time range filter. */
  timeRange?: MarketTimeRange;
  /** Invoked when the user selects a timeframe pill. */
  onTimeRangeChange?: (range: MarketTimeRange) => void;
  /** Color palette: dual YES/NO shading (`classic`) or sleek single-line (`neutral`). */
  palette?: PredictionChartPalette;
  /** Input unit for `yesPrice`/`noPrice` (`ratio` for `0..1`, `percent` for `0..100`). */
  unit?: PredictionProbabilityUnit;
  /** Displays the YES/NO percentage header and timeframe pills. */
  showHeader?: boolean;
  /** Displays the YES/NO color legend beneath the chart. */
  showLegend?: boolean;
  /** Shows the right 0–100% axis scale when true. */
  showPriceScale?: boolean;
  /** Shows the bottom time axis labels when true. */
  showTimeScale?: boolean;
  /** Stretches the chart to fill its flex parent height. */
  fillHeight?: boolean;
  /** Fixed chart height in pixels when `fillHeight` is false. */
  height?: number;
  /** Shows loading state overlay while history loads. */
  loading?: boolean;
  /** Optional error state message. */
  error?: string;
};

function toPercent(raw: number, unit: PredictionProbabilityUnit): number {
  if (!Number.isFinite(raw)) return 50;
  const scaled = unit === "ratio" ? raw * 100 : raw;
  return Math.min(100, Math.max(0, scaled));
}

function formatProbability(value: number): string {
  if (!Number.isFinite(value) || value < -0.05 || value > 100.05) return "";
  return `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
}

const PROBABILITY_SCALE_MARGINS = { top: 0.08, bottom: 0.08 };

/** Interactive 0–100% prediction probability chart with dual YES/NO or neutral shading. */
export function PredictionProbabilityChart({
  marketId,
  data,
  timeRange = "ALL",
  onTimeRangeChange,
  palette = "classic",
  unit = "ratio",
  showHeader = true,
  showLegend = false,
  showPriceScale = true,
  showTimeScale = true,
  fillHeight = false,
  height = 340,
  loading = false,
  error,
  className,
  ...props
}: PredictionProbabilityChartProps) {
  const visible = useMemo(() => filterChartPointsByRange(data, timeRange), [data, timeRange]);

  const latest = visible[visible.length - 1];
  const yesPct = latest ? toPercent(latest.yesPrice, unit) : 50;
  const noPct = latest?.noPrice !== undefined ? toPercent(latest.noPrice, unit) : 100 - yesPct;

  const series = useMemo<readonly LightweightChartSeriesSpec[]>(() => {
    if (visible.length === 0) return [];
    const points = visible.map((pt) => ({ time: pt.time, value: toPercent(pt.yesPrice, unit) }));
    if (palette === "neutral") {
      return [{ kind: "area", tone: "neutral", data: points }];
    }
    return [
      { kind: "area", tone: "ok", data: points },
      { kind: "area", tone: "destructive", data: points, invertFilledArea: true, lineVisible: false },
    ];
  }, [visible, unit, palette]);

  const headerLeft = showHeader ? (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-ok" />
        <span className="font-mono text-sm font-semibold whitespace-nowrap text-foreground tabular-nums">YES {yesPct.toFixed(1)}%</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-destructive" />
        <span className="font-mono text-sm font-semibold whitespace-nowrap text-foreground tabular-nums">NO {noPct.toFixed(1)}%</span>
      </div>
    </div>
  ) : undefined;

  const footer = showLegend ? (
    <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2.5 w-4 rounded-sm bg-ok/40" />
        <span className="font-mono tabular-nums">YES {yesPct.toFixed(1)}%</span>
      </div>
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2.5 w-4 rounded-sm bg-destructive/40" />
        <span className="font-mono tabular-nums">NO {noPct.toFixed(1)}%</span>
      </div>
    </div>
  ) : undefined;

  return (
    <LightweightChartBase
      data-market-id={marketId}
      ariaLabel={`Prediction probability chart: YES ${yesPct.toFixed(1)}%, NO ${noPct.toFixed(1)}%`}
      series={series}
      timeRange={showHeader && onTimeRangeChange ? timeRange : undefined}
      onTimeRangeChange={showHeader ? onTimeRangeChange : undefined}
      headerLeft={headerLeft}
      footer={footer}
      showPriceScale={showPriceScale}
      showTimeScale={showTimeScale}
      minValue={0}
      maxValue={100}
      scaleMargins={PROBABILITY_SCALE_MARGINS}
      formatPrice={formatProbability}
      height={height}
      fillHeight={fillHeight}
      loading={loading}
      error={error}
      emptyMessage="No probability history yet."
      className={cn(className)}
      {...props}
    />
  );
}
