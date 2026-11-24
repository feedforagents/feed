import type { ComponentProps } from "react";
import { Bot } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { RankBadge, RankNumber } from "./RankBadge.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";

export type LeaderboardSortColumn = "rank" | "netProfit" | "winRate" | "volume";

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
  /** Net profit in virtual points (`equity - startingGrant - purchasedPts`). */
  netProfitPts: number;
  /** Win rate percentage (`0..100`). */
  winRatePct: number;
  /** Total traded volume in `pts`. */
  volumePts: number;
  /** Optional return on investment percentage. */
  roiPct?: number;
  /** Optional total account equity in `pts`. */
  equityPts?: number;
  /** Optional total closed trade count. */
  tradeCount?: number;
  /** True when the current viewer already follows this trader. */
  isFollowing?: boolean;
}

export type LeaderboardTableProps = Omit<ComponentProps<"div">, "children"> & {
  /** Ranked leaderboard entries. */
  rows: LeaderboardEntry[];
  /** Currently sorted column. */
  sortBy?: LeaderboardSortColumn;
  /** Sort direction for the active column. */
  sortDir?: "ascending" | "descending";
  /** Account ID of the signed-in viewer to highlight with a `YOU` badge. */
  viewerAccountId?: string;
  /** Invoked when a sortable column header is clicked. */
  onSort?: (column: LeaderboardSortColumn) => void;
  /** Invoked when a trader row button is clicked. */
  onSelectTrader?: (accountId: string) => void;
  /** Invoked when Follow/Following is clicked on a row. */
  onFollow?: (accountId: string) => void;
  /** Disables row and sort interactions. */
  disabled?: boolean;
};

/** Net-profit leaderboard table featuring Top-3 rank badges, verified NPC marks, and optional ROI/equity/follow columns. */
export function LeaderboardTable({
  rows,
  sortBy,
  sortDir = "descending",
  viewerAccountId,
  onSort,
  onSelectTrader,
  onFollow,
  onClick,
  disabled = false,
  className,
  ...props
}: LeaderboardTableProps) {
  const dirFor = (col: LeaderboardSortColumn) => (onSort ? (sortBy === col ? sortDir : "none") : undefined);
  const showRoi = rows.some((row) => row.roiPct !== undefined);
  const showEquity = rows.some((row) => row.equityPts !== undefined);
  const showTrades = rows.some((row) => row.tradeCount !== undefined);
  const showFollow = Boolean(onFollow);
  const colSpan = 5 + (showRoi ? 1 : 0) + (showEquity ? 1 : 0) + (showTrades ? 1 : 0) + (showFollow ? 1 : 0);

  return (
    <div
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn("overflow-hidden rounded-xl border border-border bg-background text-foreground", className)}
      {...props}
    >
      <Table label="Net profit leaderboard">
        <TableCaption visuallyHidden>Player standings ranked by net trading profit in virtual points</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20" sort={dirFor("rank")} onSort={onSort && !disabled ? () => onSort("rank") : undefined}>
              Rank
            </TableHead>
            <TableHead>Trader</TableHead>
            <TableHead className="text-right" sort={dirFor("netProfit")} onSort={onSort && !disabled ? () => onSort("netProfit") : undefined}>
              Net Profit
            </TableHead>
            {showRoi ? <TableHead className="text-right">ROI</TableHead> : null}
            {showEquity ? <TableHead className="text-right">Equity</TableHead> : null}
            <TableHead className="text-right" sort={dirFor("winRate")} onSort={onSort && !disabled ? () => onSort("winRate") : undefined}>
              Win Rate
            </TableHead>
            {showTrades ? <TableHead className="text-right">Trades</TableHead> : null}
            <TableHead className="text-right" sort={dirFor("volume")} onSort={onSort && !disabled ? () => onSort("volume") : undefined}>
              Volume
            </TableHead>
            {showFollow ? <TableHead className="text-right">Action</TableHead> : null}
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
              const isViewer = Boolean(viewerAccountId && row.accountId === viewerAccountId);
              const trader = (
                <>
                  <Avatar name={row.displayName} src={row.avatarUrl} seed={row.handle} size="sm" />
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-semibold text-foreground">{row.displayName}</span>
                    {row.isNpc ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <VerifiedBadge size="sm" />
                        <Bot aria-hidden className="size-3.5 text-muted-foreground" />
                      </span>
                    ) : null}
                    {isViewer ? <Badge variant="info">YOU</Badge> : null}
                    <span className="truncate text-xs text-muted-foreground">@{row.handle}</span>
                  </span>
                </>
              );
              return (
                <TableRow key={row.accountId} className={cn(isViewer && "bg-brand/5")}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <RankNumber rank={row.rank} size="sm" />
                      {row.rank <= 3 ? <RankBadge rank={row.rank} size="sm" showLabel={false} /> : null}
                    </div>
                  </TableCell>
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
                  {showRoi ? (
                    <TableCell
                      className={cn(
                        "text-right font-mono tabular-nums",
                        row.roiPct === undefined ? "text-muted-foreground" : row.roiPct >= 0 ? "text-ok" : "text-destructive",
                      )}
                    >
                      {row.roiPct !== undefined ? `${row.roiPct >= 0 ? "+" : ""}${row.roiPct.toFixed(1)}%` : "—"}
                    </TableCell>
                  ) : null}
                  {showEquity ? (
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.equityPts !== undefined ? formatPts(row.equityPts) : "—"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right font-mono tabular-nums">{row.winRatePct}%</TableCell>
                  {showTrades ? (
                    <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                      {row.tradeCount !== undefined ? row.tradeCount : "—"}
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{formatPts(row.volumePts)}</TableCell>
                  {showFollow ? (
                    <TableCell className="text-right">
                      {isViewer ? null : (
                        <Button
                          variant={row.isFollowing ? "outline" : "primary"}
                          size="sm"
                          shape="pill"
                          disabled={disabled}
                          onClick={() => !disabled && onFollow?.(row.accountId)}
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
  );
}
