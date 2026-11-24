import type { ComponentProps } from "react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";

export type LeaderboardScope = "players" | "characters";

export type LeaderboardMetric = "net_profit" | "return_pct" | "win_rate" | "volume";

export type LeaderboardSortColumn = "rank" | "netProfit" | "returnPct" | "winRate" | "volume";

export interface LeaderboardEntry {
  /** Leaderboard position (`1`-indexed). */
  rank: number;
  /** Account identifier. */
  accountId: string;
  /** Trader display name. */
  displayName: string;
  /** Trader handle without `@`. */
  handle: string;
  /** Optional avatar URL. */
  avatarUrl?: string;
  /** Marks satirical NPC accounts. */
  isNpc?: boolean;
  /** Net profit in virtual points (`equity - startingGrant`). */
  netProfitPts: number;
  /** Return on fixed starting capital percentage (e.g. `12.5` for `+12.5%`). */
  returnPct?: number;
  /** Win rate percentage (`0..100`). */
  winRatePct: number;
  /** Total traded volume in `pts`. */
  volumePts: number;
}

export type LeaderboardTableProps = Omit<ComponentProps<"div">, "children"> & {
  /** Ranked leaderboard entries. */
  rows: LeaderboardEntry[];
  /** Active standings board (`players` or `characters`). */
  scope?: LeaderboardScope;
  /** Invoked when switching between Players and Characters boards. */
  onScopeChange?: (scope: LeaderboardScope) => void;
  /** Active server-side ranking metric (`net_profit`, `return_pct`, `win_rate`, or `volume`). */
  metric?: LeaderboardMetric;
  /** Invoked when a server-side metric sort column is selected. */
  onMetricChange?: (metric: LeaderboardMetric) => void;
  /** Currently sorted column. */
  sortBy?: LeaderboardSortColumn;
  /** Sort direction for the active column. */
  sortDir?: "ascending" | "descending";
  /** Invoked when a sortable column header is clicked. */
  onSort?: (column: LeaderboardSortColumn) => void;
  /** Invoked when a trader row button is clicked. */
  onSelectTrader?: (accountId: string) => void;
  /** Account ID of the signed-in user to highlight in the standings. */
  currentUserId?: string;
  /** Signed-in user's standing shown in a pinned bar when outside the current page. */
  currentUserRow?: LeaderboardEntry | null;
  /** Navigates to the page containing the signed-in user's rank. */
  onJumpToCurrentUser?: () => void;
  /** Current 1-indexed page number. */
  page?: number;
  /** Total available pages. */
  totalPages?: number;
  /** Total ranked entries across all pages. */
  totalCount?: number;
  /** Invoked when navigating to another page. */
  onPageChange?: (page: number) => void;
  /** Disables row, board, sort, and pagination interactions. */
  disabled?: boolean;
};

const metricToColumn: Record<LeaderboardMetric, LeaderboardSortColumn> = {
  net_profit: "netProfit",
  return_pct: "returnPct",
  win_rate: "winRate",
  volume: "volume",
};

const columnToMetric: Partial<Record<LeaderboardSortColumn, LeaderboardMetric>> = {
  netProfit: "net_profit",
  returnPct: "return_pct",
  winRate: "win_rate",
  volume: "volume",
};

const formatReturnPct = (value: number): string => {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = normalized > 0 ? "+" : "";
  return `${prefix}${normalized.toFixed(1)}%`;
};

/** Net-profit and ROI standings table with Players/Characters scope tabs, metric sorting, pagination, and current-user rank highlighting. */
export function LeaderboardTable({
  rows,
  scope = "players",
  onScopeChange,
  metric,
  onMetricChange,
  sortBy,
  sortDir = "descending",
  onSort,
  onSelectTrader,
  currentUserId,
  currentUserRow,
  onJumpToCurrentUser,
  page = 1,
  totalPages,
  totalCount,
  onPageChange,
  onClick,
  disabled = false,
  className,
  ...props
}: LeaderboardTableProps) {
  const activeSortBy = sortBy ?? (metric ? metricToColumn[metric] : undefined);
  const canSortColumn = (col: LeaderboardSortColumn) => Boolean(onSort || (onMetricChange && columnToMetric[col]));
  const dirFor = (col: LeaderboardSortColumn) => (canSortColumn(col) ? (activeSortBy === col ? sortDir : "none") : undefined);
  const handleSort = (col: LeaderboardSortColumn) => {
    if (disabled) return;
    const nextMetric = columnToMetric[col];
    if (nextMetric) onMetricChange?.(nextMetric);
    onSort?.(col);
  };

  const highlightId = currentUserId ?? currentUserRow?.accountId;
  const currentUserVisible = Boolean(highlightId && rows.some((row) => row.accountId === highlightId));
  const showPinnedCurrentUser = Boolean(currentUserRow && !currentUserVisible);
  const currentPage = Math.max(1, page);
  const showPagination = Boolean(onPageChange && totalPages !== undefined && totalPages > 1);

  return (
    <div
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn("overflow-hidden rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    >
      {onScopeChange ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <SegmentedControl
            aria-label="Leaderboard board"
            value={scope}
            disabled={disabled}
            onValueChange={(next) => {
              if (!disabled) onScopeChange(next === "characters" ? "characters" : "players");
            }}
            options={[
              { value: "players", label: "Players" },
              { value: "characters", label: "Characters" },
            ]}
          />
          {totalCount !== undefined ? (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {totalCount} {scope === "characters" ? "characters" : "players"}
            </span>
          ) : null}
        </div>
      ) : null}

      {showPinnedCurrentUser && currentUserRow ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-accent/40 px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-foreground tabular-nums">#{currentUserRow.rank}</span>
            <span className="font-medium text-foreground">{currentUserRow.displayName}</span>
            <span className="text-muted-foreground">@{currentUserRow.handle}</span>
            <Badge variant="secondary">You</Badge>
            <span className={cn("font-mono font-semibold tabular-nums", currentUserRow.netProfitPts >= 0 ? "text-ok" : "text-destructive")}>
              {formatPts(currentUserRow.netProfitPts, true)}
            </span>
            {currentUserRow.returnPct !== undefined ? (
              <span className={cn("font-mono tabular-nums", currentUserRow.returnPct >= 0 ? "text-ok" : "text-destructive")}>
                {formatReturnPct(currentUserRow.returnPct)}
              </span>
            ) : null}
          </div>
          {onJumpToCurrentUser ? (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => !disabled && onJumpToCurrentUser()}>
              Jump to my rank
            </Button>
          ) : null}
        </div>
      ) : null}

      <Table label="Net profit leaderboard">
        <TableCaption visuallyHidden>Standings ranked by net trading profit and return on fixed virtual starting capital</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 text-right" sort={dirFor("rank")} onSort={canSortColumn("rank") && !disabled ? () => handleSort("rank") : undefined}>
              Rank
            </TableHead>
            <TableHead>Trader</TableHead>
            <TableHead className="text-right" sort={dirFor("netProfit")} onSort={canSortColumn("netProfit") && !disabled ? () => handleSort("netProfit") : undefined}>
              Net Profit
            </TableHead>
            <TableHead className="text-right" sort={dirFor("returnPct")} onSort={canSortColumn("returnPct") && !disabled ? () => handleSort("returnPct") : undefined}>
              ROI %
            </TableHead>
            <TableHead className="text-right" sort={dirFor("winRate")} onSort={canSortColumn("winRate") && !disabled ? () => handleSort("winRate") : undefined}>
              Win Rate
            </TableHead>
            <TableHead className="text-right" sort={dirFor("volume")} onSort={canSortColumn("volume") && !disabled ? () => handleSort("volume") : undefined}>
              Volume
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                No ranked traders yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const positive = row.netProfitPts >= 0;
              const positiveRoi = (row.returnPct ?? 0) >= 0;
              const isCurrentUser = Boolean(highlightId && row.accountId === highlightId);
              const trader = (
                <>
                  <Avatar name={row.displayName} src={row.avatarUrl} size="sm" />
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{row.displayName}</span>
                    <span className="text-xs text-muted-foreground">@{row.handle}</span>
                    {isCurrentUser ? <Badge variant="secondary">You</Badge> : null}
                    {row.isNpc ? <Badge variant="info">AI parody</Badge> : null}
                  </span>
                </>
              );
              return (
                <TableRow key={row.accountId} data-current-user={isCurrentUser ? "true" : undefined} className={cn(isCurrentUser && "bg-accent/50")}>
                  <TableCell className="text-right font-mono text-muted-foreground tabular-nums">#{row.rank}</TableCell>
                  <TableCell>
                    {onSelectTrader ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => !disabled && onSelectTrader(row.accountId)}
                        className={cn(focusRing, inactive, "inline-flex items-center gap-2.5 rounded-sm text-left hover:underline")}
                      >
                        {trader}
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-2.5">{trader}</div>
                    )}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono font-semibold tabular-nums", positive ? "text-ok" : "text-destructive")}>
                    {formatPts(row.netProfitPts, true)}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", row.returnPct === undefined ? "text-muted-foreground" : positiveRoi ? "text-ok" : "text-destructive")}>
                    {row.returnPct === undefined ? "—" : formatReturnPct(row.returnPct)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{row.winRatePct}%</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{formatPts(row.volumePts)}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {showPagination && totalPages !== undefined && onPageChange ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            Page {currentPage} of {totalPages}
            {totalCount !== undefined ? ` · ${totalCount} total` : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || currentPage <= 1}
              onClick={() => !disabled && onPageChange(currentPage - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || currentPage >= totalPages}
              onClick={() => !disabled && onPageChange(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
