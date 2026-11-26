import { type ComponentProps, useId } from "react";
import { cn } from "../lib/cn.ts";

export interface PriceChartPoint {
  /** X-axis timestamp or slot label. */
  label: string;
  /** Numeric price or odds value. */
  value: number;
}

export type PriceChartProps = Omit<ComponentProps<"figure">, "children"> & {
  /** Ordered time-series data points. */
  points: readonly PriceChartPoint[];
  /** Optional heading displayed above the chart. */
  title?: string;
  /** Accessible description of the chart series. */
  ariaLabel?: string;
  /** Semantic color token role carried through `currentColor`. */
  tone?: "primary" | "ok" | "destructive";
  /** Formats numeric min, max, and latest readouts. */
  formatValue?: (value: number) => string;
  /** SVG viewport height in pixels. */
  height?: number;
};

const toneClasses = {
  primary: "text-primary",
  ok: "text-ok",
  destructive: "text-destructive",
};

/** Accessible SVG line and area chart using semantic `currentColor` tokens. */
export function PriceChart({
  points,
  title,
  ariaLabel = "Price chart",
  tone,
  formatValue = (value) => value.toFixed(2),
  height = 160,
  className,
  ...props
}: PriceChartProps) {
  const gradientId = useId();
  if (points.length === 0) {
    return (
      <figure aria-label={ariaLabel} className={cn("flex flex-col gap-2 rounded-lg border border-border bg-background p-4 text-foreground", className)} {...props}>
        {title ? <figcaption className="text-sm font-semibold">{title}</figcaption> : null}
        <p className="py-8 text-center text-sm text-muted-foreground">No price history yet.</p>
      </figure>
    );
  }

  const width = 400;
  const padX = 8;
  const padY = 12;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  const resolvedTone = tone ?? (last > first ? "ok" : last < first ? "destructive" : "primary");

  const coords = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : padX + (index / (points.length - 1)) * (width - padX * 2);
    const y = padY + (1 - (point.value - min) / span) * (height - padY * 2);
    return { x, y };
  });

  const linePath = coords.map((pt, index) => `${index === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${height} L${coords[0].x.toFixed(1)},${height} Z`;

  return (
    <figure aria-label={ariaLabel} className={cn("flex flex-col gap-3 rounded-lg border border-border bg-background p-4 text-foreground", className)} {...props}>
      <div className="flex items-baseline justify-between gap-2">
        {title ? <figcaption className="text-sm font-semibold text-foreground">{title}</figcaption> : <span className="sr-only">{ariaLabel}</span>}
        <span className={cn("font-mono text-sm font-semibold tabular-nums", toneClasses[resolvedTone])}>{formatValue(last)}</span>
      </div>
      <svg
        role="img"
        aria-label={`${ariaLabel}: latest ${formatValue(last)}, low ${formatValue(min)}, high ${formatValue(max)}`}
        viewBox={`0 0 ${width} ${height}`}
        className={cn("w-full overflow-visible", toneClasses[resolvedTone])}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={padY} x2={width - padX} y2={padY} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
        <line x1={padX} y1={height / 2} x2={width - padX} y2={height / 2} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
        <line x1={padX} y1={height - padY} x2={width - padX} y2={height - padY} className="stroke-border" strokeDasharray="3 3" strokeWidth="1" />
        {coords.length > 1 ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}
        {coords.length > 1 ? <path d={linePath} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" /> : null}
        <circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r="3.5" fill="currentColor" />
      </svg>
      <div className="flex items-center justify-between font-mono text-xs text-muted-foreground tabular-nums">
        <span>{points[0].label} · Low {formatValue(min)}</span>
        <span>High {formatValue(max)} · {points[points.length - 1].label}</span>
      </div>
    </figure>
  );
}
