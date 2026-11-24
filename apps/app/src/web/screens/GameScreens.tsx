// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  LeaderboardTable,
  type LeaderboardSortColumn,
  PositionRow,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatPts,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function LeaderboardScreen() {
  const s = useAppStore();
  const [sortBy, setSortBy] = useState<LeaderboardSortColumn>("netProfit");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const sortedRows = [...s.leaderboard].sort((a, b) => {
    const dir = sortDir === "ascending" ? 1 : -1;
    if (sortBy === "rank") return (a.rank - b.rank) * dir;
    if (sortBy === "winRate") return (a.winRatePct - b.winRatePct) * dir;
    if (sortBy === "volume") return (a.volumePts - b.volumePts) * dir;
    return (a.netProfitPts - b.netProfitPts) * dir;
  });

  const handleSort = (col: LeaderboardSortColumn) => {
    if (sortBy === col) {
      setSortDir(sortDir === "descending" ? "ascending" : "descending");
      return;
    }
    setSortBy(col);
    setSortDir("descending");
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <h1 className="text-base font-bold text-foreground">Leaderboard</h1>
        <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
          Trade Markets
        </Button>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {s.leaderboardLoading && s.leaderboard.length === 0 ? (
          <Skeleton className="h-64" />
        ) : (
          <LeaderboardTable
            rows={sortedRows}
            sortBy={sortBy}
            sortDir={sortDir}
            viewerAccountId={s.viewer?.accountId}
            onSort={handleSort}
            onSelectTrader={(accountId) => {
              const found = s.leaderboard.find((r) => r.accountId === accountId);
              if (found) void storeActions.navigate(`/u/${encodeURIComponent(found.handle)}`);
            }}
            onFollow={(accountId) => {
              const found = s.leaderboard.find((r) => r.accountId === accountId);
              if (found) void storeActions.toggleFollow(found.handle, found.isFollowing);
            }}
          />
        )}
      </div>
    </div>
  );
}

export function WalletScreen() {
  const s = useAppStore();
  const econ = s.economy;
  const cashCents = econ?.balanceCents ?? s.viewer?.balanceCents ?? 0;
  const positionCents = econ?.positionValueCents ?? 0;
  const equityCents = econ?.equityCents ?? cashCents + positionCents;
  const netProfitCents = econ?.netProfitCents ?? equityCents - (s.viewer?.startingGrantCents ?? 10000);
  const openPositions = s.positions.filter((p) => !p.isClosed);

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <h1 className="text-base font-bold text-foreground">Wallet</h1>
        <Button size="sm" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
          Markets
        </Button>
      </header>

      {!s.viewer ? (
        <div className="p-6">
          <EmptyState title="Sign in to view your wallet">
            <Button shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
              Sign in & claim 100 pts
            </Button>
          </EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Total Equity</span>
              <span className="font-mono text-xl font-bold text-foreground tabular-nums">{formatPts(equityCents / 100)}</span>
            </Card>
            <Card className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Available Cash</span>
              <span className="font-mono text-xl font-bold text-foreground tabular-nums">{formatPts(cashCents / 100)}</span>
            </Card>
            <Card className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Positions Value</span>
              <span className="font-mono text-xl font-bold text-foreground tabular-nums">{formatPts(positionCents / 100)}</span>
            </Card>
            <Card className="gap-1 p-4">
              <span className="text-xs text-muted-foreground">Net Profit</span>
              <span className={`font-mono text-xl font-bold tabular-nums ${netProfitCents >= 0 ? "text-ok" : "text-destructive"}`}>
                {formatPts(netProfitCents / 100, true)}
              </span>
            </Card>
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-bold text-foreground">Open Positions ({openPositions.length})</h2>
            {openPositions.length === 0 ? (
              <Card className="p-6">
                <EmptyState title="No open positions">
                  <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
                    Explore Markets
                  </Button>
                </EmptyState>
              </Card>
            ) : (
              <Card className="gap-0 overflow-hidden p-0">
                {openPositions.map((pos) => (
                  <PositionRow
                    key={pos.row.id}
                    position={pos.row}
                    loading={s.tradeLoading}
                    onClose={() => {
                      if (pos.row.kind === "perp") {
                        void storeActions.closePerpPosition(pos.row.id);
                      } else {
                        void storeActions.submitPredictionOrder(
                          pos.marketId,
                          "Sell",
                          pos.rawSide === "no" ? "no" : "yes",
                          pos.shares,
                        );
                      }
                    }}
                  />
                ))}
              </Card>
            )}
          </section>

          <Card className="gap-3 p-4">
            <CardHeader>
              <CardTitle className="text-sm">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {s.economyLoading && s.ledger.length === 0 ? (
                <Skeleton className="h-32" />
              ) : s.ledger.length === 0 ? (
                <EmptyState title="No ledger activity yet" />
              ) : (
                <Table label="Wallet ledger">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead className="text-right">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.ledger.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-sm font-medium text-foreground">{row.kind}</TableCell>
                        <TableCell className={`text-right font-mono tabular-nums ${row.deltaCents >= 0 ? "text-ok" : "text-destructive"}`}>
                          {formatPts(row.deltaCents / 100, true)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                          {formatPts(row.balanceAfterCents / 100)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{row.timestamp}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
