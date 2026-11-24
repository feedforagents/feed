import { type ComponentProps, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Alert } from "./Alert.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./Card.tsx";
import {
  LightweightChartBase,
  type LightweightChartPoint,
  type LightweightChartSeriesSpec,
  type MarketTimeRange,
} from "./LightweightChartBase.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";

export interface WalletSummary {
  /** Total account equity (`cash + open positions value`) in `pts`. */
  equityPts: number;
  /** Spendable cash balance in `pts`. */
  cashPts: number;
  /** Mark-to-market value locked in open positions in `pts`. */
  openPositionsValuePts: number;
  /** Lifetime net profit in `pts` relative to the fixed `100 pts` starting grant. */
  netProfitPts: number;
  /** Optional return on capital percentage. */
  roiPct?: number;
  /** Total trading fees paid in `pts`. */
  feesPaidPts: number;
}

export interface WalletOpenPosition {
  /** Position identifier. */
  id: string;
  /** Market kind (`perp` or `prediction`). */
  kind: "perp" | "prediction";
  /** Market ticker or question headline. */
  marketLabel: string;
  /** Position side (`Long`, `Short`, `YES`, or `NO`). */
  side: "Long" | "Short" | "YES" | "NO";
  /** Formatted notional size or share count. */
  sizeLabel: string;
  /** Optional leverage multiple for perpetual positions. */
  leverage?: number;
  /** Entry price or average odds label. */
  entryLabel: string;
  /** Current mark price or live odds label. */
  markLabel: string;
  /** Live unrealized PnL in `pts`. */
  pnlPts: number;
  /** Live unrealized PnL percentage. */
  pnlPct: number;
  /** Optional liquidation price label for perps. */
  liquidationLabel?: string;
  /** Distance to liquidation as a percentage (`< 5` triggers near-liquidation alert). */
  liquidationDistancePct?: number;
}

export interface WalletClosedPosition {
  /** Closed position identifier. */
  id: string;
  /** Market kind (`perp` or `prediction`). */
  kind: "perp" | "prediction";
  /** Market ticker or question headline. */
  marketLabel: string;
  /** Closed direction (`Long`, `Short`, `YES`, or `NO`). */
  side: "Long" | "Short" | "YES" | "NO";
  /** Realized PnL in `pts`. */
  realizedPnlPts: number;
  /** Realized ROI percentage. */
  realizedPnlPct: number;
  /** Human-readable close timestamp label. */
  closedAtLabel: string;
}

export interface WalletLedgerEntry {
  /** Unique ledger row ID. */
  id: string;
  /** Formatted timestamp label. */
  timestampLabel: string;
  /** Ledger event type such as `Perp Open`, `Perp Close`, `Prediction Buy`, `Fee`, `Starting Grant`. */
  eventLabel: string;
  /** Signed points delta (`+` credit or `-` debit). */
  deltaPts: number;
  /** Resulting cash balance after this entry. */
  balanceAfterPts: number;
}

export type WalletPanelProps = Omit<ComponentProps<"div">, "children"> & {
  /** Portfolio hero and breakdown totals (accounts start with fixed `100 pts` virtual capital). */
  summary: WalletSummary;
  /** Historical PnL or equity curve points for `PnLChart`. */
  pnlHistory: readonly LightweightChartPoint[];
  /** Active timeframe on the PnL chart. */
  pnlTimeRange: MarketTimeRange;
  /** Called when the user switches the PnL chart timeframe. */
  onPnlTimeRangeChange: (range: MarketTimeRange) => void;
  /** Open perpetual and prediction positions. */
  openPositions: readonly WalletOpenPosition[];
  /** Historical closed positions for Won/Lost filtering. */
  closedPositions: readonly WalletClosedPosition[];
  /** Account point ledger entries. */
  ledgerEntries: readonly WalletLedgerEntry[];
  /** Invoked when the user clicks Close on an open position. */
  onClosePosition?: (id: string, kind: "perp" | "prediction") => void;
  /** Invoked when the user selects an open position to inspect in the terminal. */
  onSelectPosition?: (id: string, kind: "perp" | "prediction") => void;
  /** Items per page for closed positions pagination (defaults to 6). */
  closedPageSize?: number;
  /** Displays skeleton placeholders while loading. */
  loading?: boolean;
  /** Optional error banner message. */
  error?: string;
  /** Disables close actions while a trade is pending. */
  submitting?: boolean;
};

type ClosedOutcomeFilter = "all" | "won" | "lost";

function formatSignedPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function WalletHeroMetrics({ summary }: { summary: WalletSummary }) {
  const profitPositive = summary.netProfitPts >= 0;
  return (
    <div className="flex flex-col gap-3">
      <Card className="bg-muted/30 p-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium tracking-wide text-muted-foreground">Total Portfolio Value</span>
          <span className="font-mono text-3xl font-bold tracking-tight text-foreground tabular-nums">
            {formatPts(summary.equityPts)}
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <span className="text-xs text-muted-foreground">Cash (Spendable)</span>
          <span className="mt-1 font-mono text-lg font-semibold text-foreground tabular-nums">
            {formatPts(summary.cashPts)}
          </span>
        </Card>
        <Card className="p-4">
          <span className="text-xs text-muted-foreground">Open Positions</span>
          <span className="mt-1 font-mono text-lg font-semibold text-foreground tabular-nums">
            {formatPts(summary.openPositionsValuePts)}
          </span>
        </Card>
        <Card className="p-4">
          <span className="text-xs text-muted-foreground">Net Profit</span>
          <div className="mt-1 flex flex-wrap items-baseline gap-1.5 font-mono tabular-nums">
            <span className={cn("text-lg font-semibold", profitPositive ? "text-ok" : "text-destructive")}>
              {formatPts(summary.netProfitPts, true)}
            </span>
            {summary.roiPct !== undefined ? (
              <span className={cn("text-xs font-medium", profitPositive ? "text-ok" : "text-destructive")}>
                ({formatSignedPct(summary.roiPct)})
              </span>
            ) : null}
          </div>
        </Card>
        <Card className="p-4">
          <span className="text-xs text-muted-foreground">Fees Paid</span>
          <span className="mt-1 font-mono text-lg font-semibold text-muted-foreground tabular-nums">
            {formatPts(summary.feesPaidPts)}
          </span>
        </Card>
      </div>
    </div>
  );
}

function OpenPositionsSection({
  positions,
  onClosePosition,
  onSelectPosition,
  submitting,
}: {
  positions: readonly WalletOpenPosition[];
  onClosePosition?: (id: string, kind: "perp" | "prediction") => void;
  onSelectPosition?: (id: string, kind: "perp" | "prediction") => void;
  submitting: boolean;
}) {
  return (
    <Card className="gap-3 p-4">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Open Positions</CardTitle>
        <Badge variant="secondary" className="font-mono tabular-nums">{positions.length}</Badge>
      </CardHeader>
      <CardContent className="gap-3">
        {positions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No open positions.</p>
        ) : (
          positions.map((pos) => {
            const bullish = pos.side === "Long" || pos.side === "YES";
            const positive = pos.pnlPts >= 0;
            const nearLiq = pos.liquidationDistancePct !== undefined && pos.liquidationDistancePct < 5;
            return (
              <div key={pos.id} className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge variant={bullish ? "ok" : "destructive"} className="font-mono">{pos.side}</Badge>
                    {pos.leverage ? <Badge variant="outline" className="font-mono">{pos.leverage}x</Badge> : null}
                    {onSelectPosition ? (
                      <button
                        type="button"
                        onClick={() => onSelectPosition(pos.id, pos.kind)}
                        className={cn(focusRing, "truncate rounded-sm text-left text-sm font-semibold text-foreground hover:underline")}
                      >
                        {pos.marketLabel}
                      </button>
                    ) : (
                      <span className="truncate text-sm font-semibold text-foreground">{pos.marketLabel}</span>
                    )}
                  </div>
                  <div className={cn("shrink-0 text-right font-mono text-xs font-bold tabular-nums", positive ? "text-ok" : "text-destructive")}>
                    <div>{formatPts(pos.pnlPts, true)}</div>
                    <div>{formatSignedPct(pos.pnlPct)}</div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
                  <span>Size {pos.sizeLabel}</span>
                  <span>Entry {pos.entryLabel}</span>
                  <span>Mark {pos.markLabel}</span>
                  {pos.liquidationLabel ? (
                    <span className={cn(nearLiq && "font-semibold text-warn")}>Liq {pos.liquidationLabel}</span>
                  ) : null}
                </div>

                {nearLiq ? (
                  <Alert variant="warn" className="py-1.5 text-xs">
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
                      <span>Near liquidation ({pos.liquidationDistancePct?.toFixed(1)}% away).</span>
                    </div>
                  </Alert>
                ) : null}

                {onClosePosition ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    onClick={() => onClosePosition(pos.id, pos.kind)}
                    className="self-end"
                  >
                    Close
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function ClosedPositionsSection({
  positions,
  pageSize,
}: {
  positions: readonly WalletClosedPosition[];
  pageSize: number;
}) {
  const [filter, setFilter] = useState<ClosedOutcomeFilter>("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    if (filter === "won") return positions.filter((p) => p.realizedPnlPts > 0);
    if (filter === "lost") return positions.filter((p) => p.realizedPnlPts <= 0);
    return positions;
  }, [positions, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const switchFilter = (next: ClosedOutcomeFilter) => {
    setFilter(next);
    setPage(1);
  };

  return (
    <Card className="gap-3 p-4">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm">Closed Positions</CardTitle>
        <div role="group" aria-label="Filter closed positions" className="inline-flex items-center gap-1 rounded-md border border-border bg-muted p-0.5">
          {(["all", "won", "lost"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => switchFilter(option)}
              className={cn(
                focusRing,
                "rounded-sm px-2.5 py-1 text-xs font-medium capitalize transition-colors duration-fast",
                filter === option ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="gap-2">
        {slice.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No closed positions in this filter.</p>
        ) : (
          <ul className="divide-y divide-border">
            {slice.map((pos) => {
              const won = pos.realizedPnlPts > 0;
              return (
                <li key={pos.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={won ? "ok" : "destructive"} className="font-mono">{pos.side}</Badge>
                      <span className="truncate font-medium text-foreground">{pos.marketLabel}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{pos.closedAtLabel}</span>
                  </div>
                  <div className={cn("shrink-0 text-right font-mono text-xs font-bold tabular-nums", won ? "text-ok" : "text-destructive")}>
                    <div>{formatPts(pos.realizedPnlPts, true)}</div>
                    <div>{formatSignedPct(pos.realizedPnlPct)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft aria-hidden className="size-4" />
              Prev
            </Button>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {safePage} of {totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
              <ChevronRight aria-hidden className="size-4" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Portfolio wallet panel with equity hero, cash/positions/PnL/fees breakdown, interactive PnL chart, positions, and point ledger. */
export function WalletPanel({
  summary,
  pnlHistory,
  pnlTimeRange,
  onPnlTimeRangeChange,
  openPositions,
  closedPositions,
  ledgerEntries,
  onClosePosition,
  onSelectPosition,
  closedPageSize = 6,
  loading = false,
  error,
  submitting = false,
  onClick,
  className,
  ...props
}: WalletPanelProps) {
  const pnlSeries = useMemo<readonly LightweightChartSeriesSpec[]>(() => {
    if (pnlHistory.length === 0) return [];
    return [
      {
        kind: "baseline",
        baseValue: 0,
        topTone: "ok",
        bottomTone: "destructive",
        data: pnlHistory,
      },
    ];
  }, [pnlHistory]);

  if (loading) {
    return (
      <div aria-busy="true" className={cn("flex flex-col gap-4 p-4", className)} {...props}>
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, idx) => (
            <Skeleton key={idx} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div onClick={onClick} className={cn("flex flex-col gap-6 xl:flex-row xl:items-start", className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <WalletHeroMetrics summary={summary} />

        <Card className="gap-4 p-4 sm:p-5">
          <LightweightChartBase
            ariaLabel="Portfolio profit and loss history"
            series={pnlSeries}
            timeRange={pnlTimeRange}
            onTimeRangeChange={onPnlTimeRangeChange}
            headerLeft={<h2 className="text-sm font-semibold text-foreground">P&amp;L History</h2>}
            formatPrice={(val) => formatPts(val, true)}
            height={240}
            emptyMessage="Trade a market to start tracking P&L history."
          />
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="border-b border-border px-4 py-3">
            <CardTitle className="text-sm">Point Ledger</CardTitle>
          </CardHeader>
          <Table label="Point ledger">
            <TableCaption visuallyHidden>Chronological ledger of virtual points debits, credits, and resulting balances</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledgerEntries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No ledger entries yet.
                  </TableCell>
                </TableRow>
              ) : (
                ledgerEntries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                      {entry.timestampLabel}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{entry.eventLabel}</TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono font-semibold tabular-nums",
                        entry.deltaPts >= 0 ? "text-ok" : "text-destructive",
                      )}
                    >
                      {formatPts(entry.deltaPts, true)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                      {formatPts(entry.balanceAfterPts)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <aside aria-label="Positions summary" className="flex w-full shrink-0 flex-col gap-6 xl:sticky xl:top-4 xl:w-96">
        <OpenPositionsSection
          positions={openPositions}
          onClosePosition={onClosePosition}
          onSelectPosition={onSelectPosition}
          submitting={submitting}
        />
        <ClosedPositionsSection positions={closedPositions} pageSize={closedPageSize} />
      </aside>
    </div>
  );
}
