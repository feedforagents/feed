import { type ComponentProps, type ReactNode, useCallback } from "react";
import {
  AreaSeries,
  BaselineSeries,
  ColorType,
  CrosshairMode,
  type DeepPartial,
  LineSeries,
  LineStyle,
  type Time,
  type UTCTimestamp,
  createChart,
  type ChartOptions,
} from "lightweight-charts";
import { cn, focusRing } from "../lib/cn.ts";

export type MarketTimeRange = "1H" | "4H" | "1D" | "1W" | "ALL";

export const MARKET_TIME_RANGES: readonly MarketTimeRange[] = ["1H", "4H", "1D", "1W", "ALL"];

export interface LightweightChartPoint {
  /** Unix timestamp in milliseconds or seconds. */
  time: number;
  /** Numeric series value at this timestamp. */
  value: number;
}

export type LightweightChartTone = "ok" | "destructive" | "brand" | "primary" | "info";

export interface LightweightChartPriceLine {
  /** Horizontal price level for the dashed reference line. */
  price: number;
  /** Optional axis badge label. */
  title?: string;
  /** Semantic color token role for the line. */
  tone?: LightweightChartTone;
}

export type LightweightChartSeriesSpec =
  | {
      kind: "area";
      data: readonly LightweightChartPoint[];
      tone: LightweightChartTone;
      invertFilledArea?: boolean;
      lineVisible?: boolean;
      priceLine?: LightweightChartPriceLine;
    }
  | {
      kind: "baseline";
      data: readonly LightweightChartPoint[];
      baseValue: number;
      topTone?: LightweightChartTone;
      bottomTone?: LightweightChartTone;
      priceLine?: LightweightChartPriceLine;
    }
  | {
      kind: "line";
      data: readonly LightweightChartPoint[];
      tone: LightweightChartTone;
      priceLine?: LightweightChartPriceLine;
    };

export type LightweightChartBaseProps = Omit<ComponentProps<"div">, "children"> & {
  /** One or more Lightweight Charts series definitions to render. */
  series: readonly LightweightChartSeriesSpec[];
  /** Accessible label describing the chart canvas region. */
  ariaLabel?: string;
  /** Fixed chart container height in pixels when `fillHeight` is false. */
  height?: number;
  /** Stretches the chart container to fill available vertical flex space. */
  fillHeight?: boolean;
  /** Active time range pill selection. */
  timeRange?: MarketTimeRange;
  /** Invoked when a time range pill is clicked. */
  onTimeRangeChange?: (range: MarketTimeRange) => void;
  /** Shows the right price axis labels when true. */
  showPriceScale?: boolean;
  /** Shows the bottom time axis labels when true. */
  showTimeScale?: boolean;
  /** Optional fixed lower bound for the price scale. */
  minValue?: number;
  /** Optional fixed upper bound for the price scale. */
  maxValue?: number;
  /** Formats axis and crosshair numeric values. */
  formatPrice?: (value: number) => string;
  /** Optional leading header content rendered alongside the time range selector. */
  headerLeft?: ReactNode;
  /** Optional footer slot rendered beneath the chart canvas. */
  footer?: ReactNode;
  /** Displays a loading overlay while history is being fetched. */
  loading?: boolean;
  /** Message rendered when all series are empty. */
  emptyMessage?: string;
  /** Optional error message displayed over the canvas. */
  error?: string;
  /** Optional callback receiving the hovered point or `null` when leaving the chart. */
  onCrosshairPoint?: (point: LightweightChartPoint | null) => void;
};

export interface TimeRangeSelectorProps {
  /** Currently active time range. */
  value: MarketTimeRange;
  /** Called when the user picks a time range. */
  onChange: (range: MarketTimeRange) => void;
  /** Disables all time range buttons. */
  disabled?: boolean;
  /** Additional classes for the selector container. */
  className?: string;
}

const TONE_VARS: Record<LightweightChartTone, string> = {
  ok: "--ok",
  destructive: "--destructive",
  brand: "--feed-brand",
  primary: "--primary",
  info: "--info",
};

interface ResolvedPalette {
  text: string;
  grid: string;
  crosshair: string;
  labelBg: string;
  surface: string;
  tones: Record<LightweightChartTone, { solid: string; top: string; bottom: string }>;
}

function canUseCanvas2d(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext?.("2d"));
  } catch {
    return false;
  }
}

function formatCanvasColor(r: number, g: number, b: number, alpha: number): string {
  const fnName = alpha < 1 ? "rgba" : "rgb";
  return alpha < 1 ? `${fnName}(${r}, ${g}, ${b}, ${alpha})` : `${fnName}(${r}, ${g}, ${b})`;
}

function readTokenChannels(root: HTMLElement, cssVar: string): [number, number, number] {
  const raw = getComputedStyle(root).getPropertyValue(cssVar).trim();
  if (!raw || typeof document === "undefined") return [128, 128, 128];
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const ctx = probe.getContext("2d");
  if (!ctx) return [128, 128, 128];
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return [data[0] ?? 128, data[1] ?? 128, data[2] ?? 128];
}

function resolvePalette(root: HTMLElement): ResolvedPalette {
  const textCh = readTokenChannels(root, "--muted-foreground");
  const borderCh = readTokenChannels(root, "--border");
  const cardCh = readTokenChannels(root, "--card");
  const bgCh = readTokenChannels(root, "--background");

  const toneEntry = (tone: LightweightChartTone) => {
    const ch = readTokenChannels(root, TONE_VARS[tone]);
    return {
      solid: formatCanvasColor(ch[0], ch[1], ch[2], 1),
      top: formatCanvasColor(ch[0], ch[1], ch[2], 0.28),
      bottom: formatCanvasColor(ch[0], ch[1], ch[2], 0.02),
    };
  };

  return {
    text: formatCanvasColor(textCh[0], textCh[1], textCh[2], 1),
    grid: formatCanvasColor(borderCh[0], borderCh[1], borderCh[2], 0.45),
    crosshair: formatCanvasColor(textCh[0], textCh[1], textCh[2], 0.55),
    labelBg: formatCanvasColor(cardCh[0], cardCh[1], cardCh[2], 1),
    surface: formatCanvasColor(bgCh[0], bgCh[1], bgCh[2], 1),
    tones: {
      ok: toneEntry("ok"),
      destructive: toneEntry("destructive"),
      brand: toneEntry("brand"),
      primary: toneEntry("primary"),
      info: toneEntry("info"),
    },
  };
}

function normalizePoints(points: readonly LightweightChartPoint[]): { time: Time; value: number }[] {
  const bySecond = new Map<number, number>();
  for (const pt of points) {
    if (!Number.isFinite(pt.time) || !Number.isFinite(pt.value)) continue;
    const sec = Math.floor(pt.time > 1e11 ? pt.time / 1000 : pt.time);
    bySecond.set(sec, pt.value);
  }
  return Array.from(bySecond.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([sec, value]) => ({ time: sec as UTCTimestamp, value }));
}

function buildChartOptions(
  palette: ResolvedPalette,
  width: number,
  height: number,
  showPriceScale: boolean,
  showTimeScale: boolean,
  formatPrice?: (value: number) => string,
): DeepPartial<ChartOptions> {
  return {
    width: Math.max(width, 1),
    height: Math.max(height, 1),
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: palette.text,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: palette.grid, style: LineStyle.Dotted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: palette.crosshair,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: palette.labelBg,
      },
      horzLine: {
        color: palette.crosshair,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: palette.labelBg,
      },
    },
    rightPriceScale: {
      visible: showPriceScale,
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0.1 },
      textColor: palette.text,
    },
    timeScale: {
      visible: showTimeScale,
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    localization: formatPrice
      ? {
          priceFormatter: (value: number) => {
            const formatted = formatPrice(value);
            return typeof formatted === "string" ? formatted : value.toFixed(2);
          },
        }
      : undefined,
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true },
  };
}

/** Compact `1H | 4H | 1D | 1W | ALL` timeframe pill strip for charts. */
export function TimeRangeSelector({ value, onChange, disabled = false, className }: TimeRangeSelectorProps) {
  return (
    <div role="group" aria-label="Chart time range" className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5 whitespace-nowrap", className)}>
      {MARKET_TIME_RANGES.map((range) => {
        const active = value === range;
        return (
          <button
            key={range}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(range)}
            className={cn(
              focusRing,
              "rounded-sm px-2 py-1 font-mono text-xs font-medium whitespace-nowrap transition-colors duration-fast",
              active ? "bg-feed-brand text-feed-brand-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              disabled && "pointer-events-none opacity-50",
            )}
          >
            {range}
          </button>
        );
      })}
    </div>
  );
}

/** TradingView Lightweight Charts v5 wrapper using React 19 ref cleanups and live semantic CSS token colors. */
export function LightweightChartBase({
  series,
  ariaLabel = "Interactive market chart",
  height = 320,
  fillHeight = false,
  timeRange,
  onTimeRangeChange,
  showPriceScale = true,
  showTimeScale = true,
  minValue,
  maxValue,
  formatPrice,
  headerLeft,
  footer,
  loading = false,
  emptyMessage = "No chart data available.",
  error,
  onCrosshairPoint,
  onClick,
  className,
  ...props
}: LightweightChartBaseProps) {
  const hasAnyPoints = series.some((item) => item.data.length > 0);

  const mountChart = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || !hasAnyPoints || !canUseCanvas2d()) return;

      const root = document.documentElement;
      const palette = resolvePalette(root);
      const initialWidth = container.clientWidth || 600;
      const initialHeight = fillHeight ? container.clientHeight || height : height;

      const chart = createChart(
        container,
        buildChartOptions(palette, initialWidth, initialHeight, showPriceScale, showTimeScale, formatPrice),
      );

      const autoscaleInfoProvider =
        minValue !== undefined && maxValue !== undefined
          ? () => ({ priceRange: { minValue, maxValue } })
          : undefined;

      const mountedSeries: {
        spec: LightweightChartSeriesSpec;
        api: ReturnType<typeof chart.addSeries>;
      }[] = [];

      for (const spec of series) {
        const normalized = normalizePoints(spec.data);
        let api: ReturnType<typeof chart.addSeries>;
        if (spec.kind === "area") {
          const colors = palette.tones[spec.tone];
          api = chart.addSeries(AreaSeries, {
            lineColor: colors.solid,
            topColor: spec.invertFilledArea ? colors.bottom : colors.top,
            bottomColor: spec.invertFilledArea ? colors.top : colors.bottom,
            lineWidth: 2,
            lineVisible: spec.lineVisible ?? true,
            invertFilledArea: spec.invertFilledArea ?? false,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: spec.lineVisible ?? true,
            crosshairMarkerRadius: 4,
            crosshairMarkerBackgroundColor: colors.solid,
            crosshairMarkerBorderColor: palette.surface,
            crosshairMarkerBorderWidth: 2,
            autoscaleInfoProvider,
          });
        } else if (spec.kind === "baseline") {
          const top = palette.tones[spec.topTone ?? "ok"];
          const bottom = palette.tones[spec.bottomTone ?? "destructive"];
          api = chart.addSeries(BaselineSeries, {
            baseValue: { type: "price", price: spec.baseValue },
            topLineColor: top.solid,
            topFillColor1: top.top,
            topFillColor2: top.bottom,
            bottomLineColor: bottom.solid,
            bottomFillColor1: bottom.bottom,
            bottomFillColor2: bottom.top,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            autoscaleInfoProvider,
          });
        } else {
          const colors = palette.tones[spec.tone];
          api = chart.addSeries(LineSeries, {
            color: colors.solid,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
            crosshairMarkerBackgroundColor: colors.solid,
            crosshairMarkerBorderColor: palette.surface,
            crosshairMarkerBorderWidth: 2,
            autoscaleInfoProvider,
          });
        }
        api.setData(normalized);
        if (spec.priceLine) {
          const lineTone = palette.tones[spec.priceLine.tone ?? "brand"];
          api.createPriceLine({
            price: spec.priceLine.price,
            color: lineTone.solid,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: spec.priceLine.title ?? "",
          });
        }
        mountedSeries.push({ spec, api });
      }

      chart.timeScale().fitContent();

      const primarySeries = mountedSeries[0]?.api;
      const handleCrosshair = (param: { time?: Time; seriesData: Map<unknown, unknown> }) => {
        if (!onCrosshairPoint || !primarySeries) return;
        if (!param.time || typeof param.time !== "number") {
          onCrosshairPoint(null);
          return;
        }
        const raw = param.seriesData.get(primarySeries);
        if (raw && typeof raw === "object" && "value" in raw && typeof raw.value === "number") {
          onCrosshairPoint({ time: param.time * 1000, value: raw.value });
        } else {
          onCrosshairPoint(null);
        }
      };

      if (onCrosshairPoint) {
        chart.subscribeCrosshairMove(handleCrosshair);
      }

      const resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver((entries) => {
              const entry = entries[0];
              if (!entry) return;
              const nextWidth = Math.floor(entry.contentRect.width);
              const nextHeight = fillHeight ? Math.floor(entry.contentRect.height) : height;
              if (nextWidth > 0 && nextHeight > 0) {
                chart.applyOptions({ width: nextWidth, height: nextHeight });
              }
            })
          : null;
      resizeObserver?.observe(container);

      const themeObserver =
        typeof MutationObserver !== "undefined"
          ? new MutationObserver(() => {
              const nextPalette = resolvePalette(root);
              const w = container.clientWidth || initialWidth;
              const h = fillHeight ? container.clientHeight || height : height;
              chart.applyOptions(buildChartOptions(nextPalette, w, h, showPriceScale, showTimeScale, formatPrice));
            })
          : null;
      themeObserver?.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });

      return () => {
        if (onCrosshairPoint) {
          chart.unsubscribeCrosshairMove(handleCrosshair);
        }
        resizeObserver?.disconnect();
        themeObserver?.disconnect();
        chart.remove();
        container.replaceChildren();
      };
    },
    [series, hasAnyPoints, fillHeight, height, showPriceScale, showTimeScale, minValue, maxValue, formatPrice, onCrosshairPoint],
  );

  const showToolbar = Boolean(headerLeft || (timeRange && onTimeRangeChange));

  return (
    <div
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
      className={cn("flex w-full flex-col gap-3", fillHeight && "h-full min-h-0", className)}
      {...props}
    >
      {showToolbar ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">{headerLeft}</div>
          {timeRange && onTimeRangeChange ? <TimeRangeSelector value={timeRange} onChange={onTimeRangeChange} disabled={loading} className="shrink-0" /> : null}
        </div>
      ) : null}

      <div
        role="img"
        aria-label={ariaLabel}
        className={cn(
          "relative w-full overflow-hidden rounded-lg border border-border bg-card/40",
          fillHeight ? "min-h-60 flex-1" : "shrink-0",
        )}
        style={fillHeight ? undefined : { height }}
      >
        <div ref={mountChart} className="size-full" />
        {error ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60 p-4">
            <div className="rounded-md border border-destructive/30 bg-card px-4 py-2 text-center text-sm text-destructive">{error}</div>
          </div>
        ) : loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40">
            <div className="rounded-md border border-border bg-card px-4 py-2 text-sm text-muted-foreground">Loading chart…</div>
          </div>
        ) : !hasAnyPoints ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-md border border-border bg-card px-4 py-2 text-sm text-muted-foreground">{emptyMessage}</div>
          </div>
        ) : null}
      </div>

      {footer ? <div className="shrink-0">{footer}</div> : null}
    </div>
  );
}
