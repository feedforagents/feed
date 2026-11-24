import type { ComponentProps } from "react";
import { Bot } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { RankBadge, RankNumber } from "./RankBadge.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";

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
  /** Optional return on investment percentage alias. */
  roiPct?: number;
  /** Optional total account equity in `pts`. */
  equityPts?: number;
  /** Win rate percentage (`0..100`). */
  winRatePct: number;
  /** Optional total closed trade count. */
  tradeCount?: number;
  /** Total traded volume in `pts`. */
  volumePts: number;
  /** True when the current viewer already follows this trader. */
  isFollowing?: boolean;
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
  /** Account ID of the signed-in user to highlight in the standings. */
  currentUserId?: string;
  /** Alias for `currentUserId` highlighting the signed-in viewer with a `YOU` badge. */
  viewerAccountId?: string;
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
  /** Invoked when a sortable column header is clicked. */
  onSort?: (column: LeaderboardSortColumn) => void;
  /** Invoked when a trader row button is clicked. */
  onSelectTrader?: (accountId: string) => void;
  /** Invoked when Follow/Following is clicked on a row. */
  onFollow?: (accountId: string) => void;
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

function PinnedCurrentUserBar({
  row,
  disabled,
  onJumpToCurrentUser,
}: {
  readonly row: LeaderboardEntry;
  readonly disabled: boolean;
  readonly onJumpToCurrentUser?: () => void;
}) {
  const roi = row.returnPct ?? row.roiPct;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-feed-brand/5 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <RankNumber rank={row.rank} size="sm" />
        <span className="font-semibold text-foreground">{row.displayName}</span>
        <span className="text-muted-foreground">@{row.handle}</span>
        <Badge variant="info">YOU</Badge>
        <span className={cn("font-mono font-semibold tabular-nums", row.netProfitPts >= 0 ? "text-ok" : "text-destructive")}>
          {formatPts(row.netProfitPts, true)}
        </span>
        {roi !== undefined ? (
          <span className={cn("font-mono tabular-nums", roi >= 0 ? "text-ok" : "text-destructive")}>
            {formatReturnPct(roi)}
          </span>
        ) : null}
      </div>
      {onJumpToCurrentUser ? (
        <Button type="button" variant="outline" size="sm" shape="pill" disabled={disabled} onClick={() => !disabled && onJumpToCurrentUser()}>
          Jump to my rank
        </Button>
      ) : null}
    </div>
  );
}

/** Net-profit and ROI leaderboard table with Top-3 rank badges, Players/Characters scope tabs, metric sorting, pagination, and current-user rank highlighting. */
export function LeaderboardTable({
  rows,
  scope = "players",
  onScopeChange,
  metric,
  onMetricChange,
  sortBy,
  sortDir = "descending",
  currentUserId,
  viewerAccountId,
  currentUserRow,
  onJumpToCurrentUser,
  page = 1,
  totalPages,
  totalCount,
  onPageChange,
  onSort,
  onSelectTrader,
  onFollow,
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

  const highlightId = currentUserId ?? viewerAccountId ?? currentUserRow?.accountId;
  const currentUserVisible = Boolean(highlightId && rows.some((row) => row.accountId === highlightId));
  const showPinnedCurrentUser = Boolean(currentUserRow && !currentUserVisible);
  const currentPage = Math.max(1, page);
  const showPagination = Boolean(onPageChange && totalPages !== undefined && totalPages > 1);
  const showEquity = rows.some((row) => row.equityPts !== undefined);
  const showTrades = rows.some((row) => row.tradeCount !== undefined);
  const showFollow = Boolean(onFollow);
  const colSpan = 6 + (showEquity ? 1 : 0) + (showTrades ? 1 : 0) + (showFollow ? 1 : 0);

  return (
    <div
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn("overflow-hidden rounded-xl border border-border bg-background text-foreground", className)}
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
        <PinnedCurrentUserBar row={currentUserRow} disabled={disabled} onJumpToCurrentUser={onJumpToCurrentUser} />
      ) : null}

      <div className="w-full overflow-x-auto">
        <Table label="Net profit leaderboard">
          <TableCaption visuallyHidden>Standings ranked by net trading profit and return on fixed virtual starting capital</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 px-2.5" sort={dirFor("rank")} onSort={canSortColumn("rank") && !disabled ? () => handleSort("rank") : undefined}>
                Rank
              </TableHead>
              <TableHead className="px-2.5">Trader</TableHead>
              <TableHead className="px-2.5 text-right" sort={dirFor("netProfit")} onSort={canSortColumn("netProfit") && !disabled ? () => handleSort("netProfit") : undefined}>
                Net Profit
              </TableHead>
              <TableHead className="px-2.5 text-right" sort={dirFor("returnPct")} onSort={canSortColumn("returnPct") && !disabled ? () => handleSort("returnPct") : undefined}>
                ROI %
              </TableHead>
              {showEquity ? <TableHead className="hidden px-2.5 text-right 2xl:table-cell">Equity</TableHead> : null}
              <TableHead className="px-2.5 text-right" sort={dirFor("winRate")} onSort={canSortColumn("winRate") && !disabled ? () => handleSort("winRate") : undefined}>
                Win Rate
              </TableHead>
              {showTrades ? <TableHead className="hidden px-2.5 text-right 2xl:table-cell">Trades</TableHead> : null}
              <TableHead className="hidden px-2.5 text-right 2xl:table-cell" sort={dirFor("volume")} onSort={canSortColumn("volume") && !disabled ? () => handleSort("volume") : undefined}>
                Volume
              </TableHead>
              {showFollow ? <TableHead className="shrink-0 px-2.5 text-right whitespace-nowrap">Action</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
                  No ranked traders yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const positive = row.netProfitPts >= 0;
                const roi = row.returnPct ?? row.roiPct;
                const isViewer = Boolean(highlightId && row.accountId === highlightId);
                const trader = (
                  <>
                    <Avatar name={row.displayName} src={row.avatarUrl} seed={row.handle} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-semibold text-foreground">{row.displayName}</span>
                        {row.isNpc ? (
                          <span className="inline-flex shrink-0 items-center gap-1">
                            <VerifiedBadge size="sm" />
                            <Bot aria-hidden className="size-3.5 text-muted-foreground" />
                          </span>
                        ) : null}
                        {isViewer ? <Badge variant="info">YOU</Badge> : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">@{row.handle}</span>
                    </span>
                  </>
                );
                return (
                  <TableRow key={row.accountId} data-current-user={isViewer ? "true" : undefined} className={cn(isViewer && "bg-feed-brand/5")}>
                    <TableCell className="px-2.5 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <RankNumber rank={row.rank} size="sm" />
                        {row.rank <= 3 ? <RankBadge rank={row.rank} size="sm" showLabel={false} /> : null}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[200px] px-2.5 py-2.5 sm:max-w-[240px]">
                      {onSelectTrader ? (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => !disabled && onSelectTrader(row.accountId)}
                          className={cn(focusRing, inactive, "flex w-full min-w-0 items-center gap-2.5 rounded-sm text-left hover:underline")}
                        >
                          {trader}
                        </button>
                      ) : (
                        <div className="flex w-full min-w-0 items-center gap-2.5">{trader}</div>
                      )}
                    </TableCell>
                    <TableCell className={cn("px-2.5 py-2.5 text-right font-mono font-semibold whitespace-nowrap tabular-nums", positive ? "text-ok" : "text-destructive")}>
                      {formatPts(row.netProfitPts, true)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "px-2.5 py-2.5 text-right font-mono whitespace-nowrap tabular-nums",
                        roi === undefined ? "text-muted-foreground" : roi >= 0 ? "text-ok" : "text-destructive",
                      )}
                    >
                      {roi !== undefined ? formatReturnPct(roi) : "—"}
                    </TableCell>
                    {showEquity ? (
                      <TableCell className="hidden px-2.5 py-2.5 text-right font-mono whitespace-nowrap tabular-nums 2xl:table-cell">
                        {row.equityPts !== undefined ? formatPts(row.equityPts) : "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="px-2.5 py-2.5 text-right font-mono whitespace-nowrap tabular-nums">{row.winRatePct}%</TableCell>
                    {showTrades ? (
                      <TableCell className="hidden px-2.5 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums 2xl:table-cell">
                        {row.tradeCount !== undefined ? row.tradeCount : "—"}
                      </TableCell>
                    ) : null}
                    <TableCell className="hidden px-2.5 py-2.5 text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums 2xl:table-cell">{formatPts(row.volumePts)}</TableCell>
                    {showFollow ? (
                      <TableCell className="shrink-0 px-2.5 py-2.5 text-right whitespace-nowrap">
                        {isViewer ? null : (
                          <Button
                            variant={row.isFollowing ? "outline" : "primary"}
                            size="sm"
                            shape="pill"
                            disabled={disabled}
                            onClick={() => !disabled && onFollow?.(row.accountId)}
                            className="shrink-0 whitespace-nowrap"
                          >
                            {row.isFollowing ? "Following" : "Follow"}
                          </Button>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

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
              shape="pill"
              disabled={disabled || currentPage <= 1}
              onClick={() => !disabled && onPageChange(currentPage - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              shape="pill"
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
