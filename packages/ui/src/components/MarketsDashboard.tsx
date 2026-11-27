import { type ComponentProps, useMemo, useState } from "react";
import { Search, Star } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Alert } from "./Alert.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.tsx";

export interface PerpMarketRow {
  /** Contract ticker symbol such as `SAMALT`. */
  ticker: string;
  /** Organization or contract display name. */
  name: string;
  /** Optional organization avatar URL. */
  avatarUrl?: string;
  /** Current mark price in virtual points (`pts`). */
  currentPrice: number;
  /** 24-hour percentage change. */
  changePercent24h: number;
  /** 24-hour trading volume in `pts`. */
  volume24h: number;
  /** Current open interest in `pts`. */
  openInterest: number;
  /** Hourly or annualized funding rate percentage. */
  fundingRatePct: number;
  /** Maximum allowed leverage multiplier. */
  maxLeverage?: number;
  /** True when starred in the trader's watchlist. */
  isFavorite?: boolean;
}

export interface PredictionMarketRow {
  /** Prediction market identifier. */
  id: string;
  /** Market question headline. */
  question: string;
  /** Optional category tag such as `AI` or `Tech`. */
  category?: string;
  /** Current YES implied probability (`0..100`). */
  yesOddsPct: number;
  /** Total CPMM pool liquidity in `pts`. */
  liquidityPts: number;
  /** Human-readable time remaining label such as `2d 4h`. */
  endsAtLabel: string;
  /** Optional numeric resolution timestamp in ms for sorting. */
  endsAtMs?: number;
  /** Lifecycle status of the prediction market (`active`, `expired`, `resolved`, or `cancelled`). */
  status?: "active" | "expired" | "resolved" | "cancelled";
  /** Settled outcome when `status` is `resolved`. */
  resolvedOutcome?: "yes" | "no" | null;
  /** True when starred in the trader's watchlist. */
  isFavorite?: boolean;
}

export type MarketsDashboardSelection =
  | { kind: "perp"; ticker: string }
  | { kind: "prediction"; id: string };

export type MarketsDashboardProps = Omit<ComponentProps<"div">, "children"> & {
  /** Perpetual markets shown under the Perps tab. */
  perpMarkets: readonly PerpMarketRow[];
  /** Active prediction markets shown under the Predictions tab. */
  predictionMarkets: readonly PredictionMarketRow[];
  /** Initial active tab (`perps` or `predictions`). */
  defaultTab?: "perps" | "predictions";
  /** Invoked when a trader clicks a market row to open the terminal. */
  onSelectMarket: (selection: MarketsDashboardSelection) => void;
  /** Invoked when a trader stars or unstars a market row. */
  onToggleFavorite?: (selection: MarketsDashboardSelection) => void;
  /** Displays table skeleton rows while initial markets load. */
  loading?: boolean;
  /** Optional error banner message when markets fail to load. */
  error?: string;
  /** Disables row clicks, sorting, and favorite toggles. */
  disabled?: boolean;
};

type PerpSortColumn = "ticker" | "price" | "change" | "volume" | "openInterest" | "funding";
type PredictionSortColumn = "question" | "yesOdds" | "liquidity" | "timeLeft";

function formatCompactPts(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M pts`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K pts`;
  return formatPts(value);
}

function FavoriteButton({
  active,
  label,
  disabled,
  onToggle,
}: {
  active: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onToggle();
      }}
      className={cn(
        focusRing,
        inactive,
        "inline-flex size-7 items-center justify-center rounded-sm transition-colors duration-fast",
        active ? "text-warn" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Star aria-hidden className={cn("size-4", active && "fill-current")} />
    </button>
  );
}

function PerpsMarketsTable({
  rows,
  sortBy,
  sortDir,
  onSort,
  onSelect,
  onToggleFavorite,
  disabled,
}: {
  rows: readonly PerpMarketRow[];
  sortBy: PerpSortColumn;
  sortDir: "ascending" | "descending";
  onSort: (col: PerpSortColumn) => void;
  onSelect: (ticker: string) => void;
  onToggleFavorite?: (ticker: string) => void;
  disabled: boolean;
}) {
  const dirFor = (col: PerpSortColumn) => (sortBy === col ? sortDir : "none");
  const colSpan = onToggleFavorite ? 7 : 6;

  return (
    <Table label="Perpetual markets">
      <TableCaption visuallyHidden>Sortable list of perpetual markets with live prices, 24h change, volume, open interest, and funding rates</TableCaption>
      <TableHeader>
        <TableRow>
          {onToggleFavorite ? <TableHead className="w-10"><span className="sr-only">Watchlist</span></TableHead> : null}
          <TableHead sort={dirFor("ticker")} onSort={disabled ? undefined : () => onSort("ticker")}>Market</TableHead>
          <TableHead className="text-right" sort={dirFor("price")} onSort={disabled ? undefined : () => onSort("price")}>Price</TableHead>
          <TableHead className="text-right" sort={dirFor("change")} onSort={disabled ? undefined : () => onSort("change")}>24h %</TableHead>
          <TableHead className="text-right" sort={dirFor("volume")} onSort={disabled ? undefined : () => onSort("volume")}>24h Vol</TableHead>
          <TableHead className="text-right" sort={dirFor("openInterest")} onSort={disabled ? undefined : () => onSort("openInterest")}>Open Interest</TableHead>
          <TableHead className="text-right" sort={dirFor("funding")} onSort={disabled ? undefined : () => onSort("funding")}>Funding</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={colSpan} className="py-10 text-center text-muted-foreground">
              No perpetual markets match your filter.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((market) => {
            const positive = market.changePercent24h >= 0;
            const fundingPos = market.fundingRatePct >= 0;
            return (
              <TableRow
                key={market.ticker}
                className={cn(!disabled && "cursor-pointer")}
                onClick={() => !disabled && onSelect(market.ticker)}
              >
                {onToggleFavorite ? (
                  <TableCell>
                    <FavoriteButton
                      active={Boolean(market.isFavorite)}
                      label={market.isFavorite ? `Remove $${market.ticker} from watchlist` : `Add $${market.ticker} to watchlist`}
                      disabled={disabled}
                      onToggle={() => onToggleFavorite(market.ticker)}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!disabled) onSelect(market.ticker);
                    }}
                    className={cn(focusRing, inactive, "flex items-center gap-2.5 rounded-sm text-left")}
                  >
                    <Avatar name={market.name} src={market.avatarUrl} seed={market.ticker} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-foreground">${market.ticker}</span>
                        {market.maxLeverage ? <Badge variant="outline" className="font-mono">{market.maxLeverage}x</Badge> : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{market.name}</span>
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-right font-mono font-semibold text-foreground tabular-nums">
                  {formatPts(market.currentPrice)}
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant={positive ? "ok" : "destructive"} className="font-mono tabular-nums">
                    {positive ? "+" : ""}
                    {market.changePercent24h.toFixed(2)}%
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                  {formatCompactPts(market.volume24h)}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                  {formatCompactPts(market.openInterest)}
                </TableCell>
                <TableCell className={cn("text-right font-mono text-xs tabular-nums", fundingPos ? "text-ok" : "text-destructive")}>
                  {fundingPos ? "+" : ""}
                  {market.fundingRatePct.toFixed(4)}%
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function PredictionsMarketsTable({
  rows,
  sortBy,
  sortDir,
  onSort,
  onSelect,
  onToggleFavorite,
  disabled,
}: {
  rows: readonly PredictionMarketRow[];
  sortBy: PredictionSortColumn;
  sortDir: "ascending" | "descending";
  onSort: (col: PredictionSortColumn) => void;
  onSelect: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  disabled: boolean;
}) {
  const dirFor = (col: PredictionSortColumn) => (sortBy === col ? sortDir : "none");
  const colSpan = onToggleFavorite ? 5 : 4;

  return (
    <Table label="Prediction markets">
      <TableCaption visuallyHidden>Sortable list of active prediction markets with YES probability, liquidity, and time remaining</TableCaption>
      <TableHeader>
        <TableRow>
          {onToggleFavorite ? <TableHead className="w-10"><span className="sr-only">Watchlist</span></TableHead> : null}
          <TableHead sort={dirFor("question")} onSort={disabled ? undefined : () => onSort("question")}>Question</TableHead>
          <TableHead className="w-44 text-right" sort={dirFor("yesOdds")} onSort={disabled ? undefined : () => onSort("yesOdds")}>Yes %</TableHead>
          <TableHead className="text-right" sort={dirFor("liquidity")} onSort={disabled ? undefined : () => onSort("liquidity")}>Liquidity</TableHead>
          <TableHead className="text-right" sort={dirFor("timeLeft")} onSort={disabled ? undefined : () => onSort("timeLeft")}>Time Left</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={colSpan} className="py-10 text-center text-muted-foreground">
              No prediction markets match your filter.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((market) => {
            const clampedYes = Math.min(100, Math.max(0, market.yesOddsPct));
            return (
              <TableRow
                key={market.id}
                className={cn(!disabled && "cursor-pointer")}
                onClick={() => !disabled && onSelect(market.id)}
              >
                {onToggleFavorite ? (
                  <TableCell>
                    <FavoriteButton
                      active={Boolean(market.isFavorite)}
                      label={market.isFavorite ? `Remove ${market.question} from watchlist` : `Add ${market.question} to watchlist`}
                      disabled={disabled}
                      onToggle={() => onToggleFavorite(market.id)}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="max-w-md">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!disabled) onSelect(market.id);
                    }}
                    className={cn(focusRing, inactive, "flex flex-col items-start gap-1 rounded-sm text-left")}
                  >
                    <span className="font-medium text-foreground">{market.question}</span>
                    {market.category ? <Badge variant="secondary">{market.category}</Badge> : null}
                  </button>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="font-mono text-sm font-semibold text-ok tabular-nums">{clampedYes.toFixed(1)}%</span>
                    <div aria-hidden className="flex h-1.5 w-28 overflow-hidden rounded-full bg-destructive/25">
                      <div className="h-full bg-ok" style={{ width: `${clampedYes}%` }} />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                  {formatCompactPts(market.liquidityPts)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                  {market.status === "resolved" ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-transparent font-semibold",
                        market.resolvedOutcome === "yes"
                          ? "bg-ok-solid text-ok-solid-foreground"
                          : "bg-danger-solid text-danger-solid-foreground",
                      )}
                    >
                      Resolved {market.resolvedOutcome === "yes" ? "YES" : "NO"}
                    </Badge>
                  ) : market.status === "cancelled" ? (
                    <Badge variant="secondary">Cancelled</Badge>
                  ) : market.status === "expired" ? (
                    <Badge variant="secondary">Expired</Badge>
                  ) : (
                    market.endsAtLabel
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

const PRED_STATUS_FILTER_LABELS: Record<"active" | "resolved", string> = {
  active: "Active",
  resolved: "Closed",
};

/** High-density sortable markets dashboard with search, watchlist filter, and Perps / Predictions underline tabs. */
export function MarketsDashboard({
  perpMarkets,
  predictionMarkets,
  defaultTab = "perps",
  onSelectMarket,
  onToggleFavorite,
  loading = false,
  error,
  disabled = false,
  onClick,
  className,
  ...props
}: MarketsDashboardProps) {
  const blocked = disabled || loading;
  const [tab, setTab] = useState<"perps" | "predictions">(defaultTab);
  const [predStatusFilter, setPredStatusFilter] = useState<"active" | "resolved">("active");
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [perpSort, setPerpSort] = useState<PerpSortColumn>("volume");
  const [perpSortDir, setPerpSortDir] = useState<"ascending" | "descending">("descending");
  const [predSort, setPredSort] = useState<PredictionSortColumn>("liquidity");
  const [predSortDir, setPredSortDir] = useState<"ascending" | "descending">("descending");

  const handlePerpSort = (col: PerpSortColumn) => {
    if (perpSort === col) {
      setPerpSortDir((d) => (d === "descending" ? "ascending" : "descending"));
    } else {
      setPerpSort(col);
      setPerpSortDir("descending");
    }
  };

  const handlePredSort = (col: PredictionSortColumn) => {
    if (predSort === col) {
      setPredSortDir((d) => (d === "descending" ? "ascending" : "descending"));
    } else {
      setPredSort(col);
      setPredSortDir("descending");
    }
  };

  const normalizedQuery = query.trim().toLowerCase();

  const visiblePerps = useMemo(() => {
    const filtered = perpMarkets.filter((m) => {
      if (favoritesOnly && !m.isFavorite) return false;
      if (!normalizedQuery) return true;
      return m.ticker.toLowerCase().includes(normalizedQuery) || m.name.toLowerCase().includes(normalizedQuery);
    });
    const mult = perpSortDir === "ascending" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (perpSort) {
        case "ticker":
          return mult * a.ticker.localeCompare(b.ticker);
        case "price":
          return mult * (a.currentPrice - b.currentPrice);
        case "change":
          return mult * (a.changePercent24h - b.changePercent24h);
        case "volume":
          return mult * (a.volume24h - b.volume24h);
        case "openInterest":
          return mult * (a.openInterest - b.openInterest);
        case "funding":
          return mult * (a.fundingRatePct - b.fundingRatePct);
      }
    });
  }, [perpMarkets, favoritesOnly, normalizedQuery, perpSort, perpSortDir]);

  const hasClosedPredictions = useMemo(
    () => predictionMarkets.some((m) => m.status === "resolved" || m.status === "cancelled" || m.status === "expired"),
    [predictionMarkets],
  );

  const visiblePredictions = useMemo(() => {
    const filtered = predictionMarkets.filter((m) => {
      if (hasClosedPredictions) {
        const isClosed = m.status === "resolved" || m.status === "cancelled" || m.status === "expired";
        if (predStatusFilter === "active" && isClosed) return false;
        if (predStatusFilter === "resolved" && !isClosed) return false;
      }
      if (favoritesOnly && !m.isFavorite) return false;
      if (!normalizedQuery) return true;
      return (
        m.question.toLowerCase().includes(normalizedQuery) ||
        (m.category?.toLowerCase().includes(normalizedQuery) ?? false)
      );
    });
    const mult = predSortDir === "ascending" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (predSort) {
        case "question":
          return mult * a.question.localeCompare(b.question);
        case "yesOdds":
          return mult * (a.yesOddsPct - b.yesOddsPct);
        case "liquidity":
          return mult * (a.liquidityPts - b.liquidityPts);
        case "timeLeft":
          return mult * ((a.endsAtMs ?? 0) - (b.endsAtMs ?? 0));
      }
    });
  }, [predictionMarkets, hasClosedPredictions, predStatusFilter, favoritesOnly, normalizedQuery, predSort, predSortDir]);

  const statusView = error ? (
    <div className="p-4">
      <Alert variant="destructive">{error}</Alert>
    </div>
  ) : loading ? (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 6 }, (_, idx) => (
        <Skeleton key={idx} className="h-11 w-full" />
      ))}
    </div>
  ) : null;

  return (
    <div
      aria-busy={loading || undefined}
      aria-disabled={blocked || undefined}
      onClick={blocked ? undefined : onClick}
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground", className)}
      {...props}
    >
      <Tabs
        value={tab}
        onValueChange={(next) => !blocked && setTab(next === "predictions" ? "predictions" : "perps")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-col border-b border-border px-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList variant="underline" className="border-b-0">
              <TabsTrigger value="perps" disabled={blocked} className="flex-none gap-2">
                Perps
                <Badge variant="secondary" className="font-mono tabular-nums">{visiblePerps.length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="predictions" disabled={blocked} className="flex-none gap-2">
                Predictions
                <Badge variant="secondary" className="font-mono tabular-nums">{visiblePredictions.length}</Badge>
              </TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-2 pb-2">
              {tab === "predictions" && hasClosedPredictions ? (
                <div role="group" aria-label="Prediction status filter" className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
                  {(["active", "resolved"] as const).map((statusOption) => (
                    <button
                      key={statusOption}
                      type="button"
                      disabled={blocked}
                      aria-pressed={predStatusFilter === statusOption}
                      onClick={() => setPredStatusFilter(statusOption)}
                      className={cn(
                        focusRing,
                        "rounded-sm px-2.5 py-1 text-xs font-medium capitalize transition-colors duration-fast",
                        predStatusFilter === statusOption
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {PRED_STATUS_FILTER_LABELS[statusOption]}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="relative w-56 sm:w-64">
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label="Search markets"
                  placeholder="Search markets…"
                  value={query}
                  disabled={blocked}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-8"
                />
              </div>
              <Button
                variant={favoritesOnly ? "primary" : "outline"}
                size="sm"
                disabled={blocked}
                aria-pressed={favoritesOnly}
                onClick={() => setFavoritesOnly((prev) => !prev)}
              >
                <Star aria-hidden className={cn("size-3.5", favoritesOnly && "fill-current")} />
                Watchlist
              </Button>
            </div>
          </div>
        </div>

        <TabsContent value="perps" className="mt-0 min-h-0 flex-1 overflow-auto">
          {statusView ?? (
            <PerpsMarketsTable
              rows={visiblePerps}
              sortBy={perpSort}
              sortDir={perpSortDir}
              onSort={handlePerpSort}
              onSelect={(ticker) => onSelectMarket({ kind: "perp", ticker })}
              onToggleFavorite={onToggleFavorite ? (ticker) => onToggleFavorite({ kind: "perp", ticker }) : undefined}
              disabled={disabled}
            />
          )}
        </TabsContent>

        <TabsContent value="predictions" className="mt-0 min-h-0 flex-1 overflow-auto">
          {statusView ?? (
            <PredictionsMarketsTable
              rows={visiblePredictions}
              sortBy={predSort}
              sortDir={predSortDir}
              onSort={handlePredSort}
              onSelect={(id) => onSelectMarket({ kind: "prediction", id })}
              onToggleFavorite={onToggleFavorite ? (id) => onToggleFavorite({ kind: "prediction", id }) : undefined}
              disabled={disabled}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
