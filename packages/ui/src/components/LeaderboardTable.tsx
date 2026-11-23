import type { ComponentProps } from "react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./Table.tsx";

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
}

export type LeaderboardTableProps = Omit<ComponentProps<"div">, "children"> & {
  /** Ranked leaderboard entries. */
  rows: LeaderboardEntry[];
  /** Currently sorted column. */
  sortBy?: LeaderboardSortColumn;
  /** Sort direction for the active column. */
  sortDir?: "ascending" | "descending";
  /** Invoked when a sortable column header is clicked. */
  onSort?: (column: LeaderboardSortColumn) => void;
  /** Invoked when a trader row button is clicked. */
  onSelectTrader?: (accountId: string) => void;
  /** Disables row and sort interactions. */
  disabled?: boolean;
};

/** Net-profit leaderboard table unaffected by Stripe point purchases. */
export function LeaderboardTable({
  rows,
  sortBy,
  sortDir = "descending",
  onSort,
  onSelectTrader,
  disabled = false,
  className,
  ...props
}: LeaderboardTableProps) {
  const dirFor = (col: LeaderboardSortColumn) => (onSort ? (sortBy === col ? sortDir : "none") : undefined);

  return (
    <div className={cn("rounded-lg border border-border bg-card text-card-foreground", className)} {...props}>
      <Table label="Net profit leaderboard">
        <TableCaption visuallyHidden>Player standings ranked by net trading profit in virtual points</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16 text-right" sort={dirFor("rank")} onSort={onSort && !disabled ? () => onSort("rank") : undefined}>
              Rank
            </TableHead>
            <TableHead>Trader</TableHead>
            <TableHead className="text-right" sort={dirFor("netProfit")} onSort={onSort && !disabled ? () => onSort("netProfit") : undefined}>
              Net Profit
            </TableHead>
            <TableHead className="text-right" sort={dirFor("winRate")} onSort={onSort && !disabled ? () => onSort("winRate") : undefined}>
              Win Rate
            </TableHead>
            <TableHead className="text-right" sort={dirFor("volume")} onSort={onSort && !disabled ? () => onSort("volume") : undefined}>
              Volume
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                No ranked traders yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const positive = row.netProfitPts >= 0;
              return (
                <TableRow key={row.accountId}>
                  <TableCell className="text-right font-mono text-muted-foreground tabular-nums">#{row.rank}</TableCell>
                  <TableCell>
                    {onSelectTrader ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => !disabled && onSelectTrader(row.accountId)}
                        className={cn(focusRing, inactive, "inline-flex items-center gap-2.5 rounded-sm text-left hover:underline")}
                      >
                        <Avatar name={row.displayName} src={row.avatarUrl} size="sm" />
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium text-foreground">{row.displayName}</span>
                          <span className="text-xs text-muted-foreground">@{row.handle}</span>
                          {row.isNpc ? <Badge variant="info">AI parody</Badge> : null}
                        </span>
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-2.5">
                        <Avatar name={row.displayName} src={row.avatarUrl} size="sm" />
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium text-foreground">{row.displayName}</span>
                          <span className="text-xs text-muted-foreground">@{row.handle}</span>
                          {row.isNpc ? <Badge variant="info">AI parody</Badge> : null}
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={cn("text-right font-mono font-semibold tabular-nums", positive ? "text-ok" : "text-destructive")}>
                    {formatPts(row.netProfitPts, true)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{row.winRatePct}%</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground tabular-nums">{formatPts(row.volumePts)}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
