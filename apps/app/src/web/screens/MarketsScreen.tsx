// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
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
  MarketCard,
  PositionRow,
  PriceChart,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TradeTicket,
  formatPts,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function MarketsScreen() {
  const s = useAppStore();
  const [marketTab, setMarketTab] = useState<"predictions" | "perps" | "positions" | "leaderboard">(
    s.selectedMarketKind === "perp" ? "perps" : "predictions",
  );
  const [sortBy, setSortBy] = useState<LeaderboardSortColumn>("netProfit");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const balancePts = s.viewer ? formatPts(s.viewer.balanceCents / 100) : "0 pts";
  const selectedPrediction = s.predictions.find((m) => m.card.id === s.selectedMarketId) ?? s.predictions[0] ?? null;
  const selectedPerp = s.perps.find((m) => m.ticker === s.selectedMarketId) ?? s.perps[0] ?? null;
  const openPositions = s.positions.filter((p) => !p.isClosed);

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
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold text-foreground">Markets</h1>
          {s.viewer ? (
            <span className="font-mono text-xs font-semibold text-muted-foreground tabular-nums">
              {balancePts}
            </span>
          ) : null}
        </div>
        {s.viewer ? (
          <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/wallet"); }}>
            Wallet
          </Button>
        ) : (
          <Button size="sm" shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
            Claim 100 pts
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-5 p-4">
        <Tabs
          value={marketTab}
          onValueChange={(next) => {
            if (next === "perps" || next === "positions" || next === "leaderboard" || next === "predictions") {
              setMarketTab(next);
            }
          }}
        >
          <TabsList variant="underline">
            <TabsTrigger value="predictions">Predictions</TabsTrigger>
            <TabsTrigger value="perps">Perps (20x)</TabsTrigger>
            <TabsTrigger value="positions">Positions ({openPositions.length})</TabsTrigger>
            <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          </TabsList>

          <TabsContent value="predictions" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex flex-col gap-3">
              {s.marketsLoading && s.predictions.length === 0 ? (
                <Skeleton className="h-44" />
              ) : s.predictions.length === 0 ? (
                <EmptyState title="No prediction markets available" />
              ) : (
                s.predictions.map((mkt) => (
                  <MarketCard
                    key={mkt.card.id}
                    market={mkt.card}
                    selected={selectedPrediction?.card.id === mkt.card.id}
                    onSelect={(id) => storeActions.selectMarket("prediction", id)}
                  />
                ))
              )}
            </div>
            {selectedPrediction ? (
              <div className="flex flex-col gap-3">
                <TradeTicket
                  marketKind="prediction"
                  marketTitle={selectedPrediction.card.question}
                  balancePts={balancePts}
                  yesOddsPct={selectedPrediction.card.yesOddsPct}
                  yesShares={selectedPrediction.card.yesShares}
                  noShares={selectedPrediction.card.noShares}
                  loading={s.tradeLoading}
                  error={s.tradeError ?? undefined}
                  disabled={selectedPrediction.status !== "open"}
                  onSubmit={(order) => {
                    if (order.marketKind === "prediction") {
                      void storeActions.submitPredictionOrder(
                        selectedPrediction.card.id,
                        order.action,
                        order.side === "NO" ? "no" : "yes",
                        order.amountPts,
                      );
                    }
                  }}
                />
                {selectedPrediction.resolutionProof ? (
                  <Card className="gap-2 rounded-xl p-4">
                    <CardHeader>
                      <CardTitle className="text-sm">Resolution proof</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground">{selectedPrediction.resolutionProof}</p>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="perps" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex flex-col gap-3">
              {selectedPerp ? (
                <PriceChart
                  points={selectedPerp.history}
                  title={`$${selectedPerp.ticker} Spot Index & Mark`}
                  ariaLabel={`${selectedPerp.ticker} price chart`}
                  formatValue={(v) => formatPts(v)}
                />
              ) : null}
              {s.marketsLoading && s.perps.length === 0 ? (
                <Skeleton className="h-44" />
              ) : s.perps.length === 0 ? (
                <EmptyState title="No perpetual markets available" />
              ) : (
                s.perps.map((perp) => (
                  <MarketCard
                    key={perp.ticker}
                    market={perp.card}
                    selected={selectedPerp?.ticker === perp.ticker}
                    onSelect={(id) => storeActions.selectMarket("perp", id)}
                  />
                ))
              )}
            </div>
            {selectedPerp ? (
              <TradeTicket
                marketKind="perp"
                ticker={selectedPerp.ticker}
                marketTitle={selectedPerp.card.name}
                balancePts={balancePts}
                markPricePts={selectedPerp.card.markPricePts}
                indexPricePts={selectedPerp.card.indexPricePts}
                maxLeverage={selectedPerp.card.maxLeverage ?? 20}
                loading={s.tradeLoading}
                error={s.tradeError ?? undefined}
                onSubmit={(order) => {
                  if (order.marketKind === "perp") {
                    void storeActions.submitPerpOrder(
                      selectedPerp.ticker,
                      order.side === "Short" ? "short" : "long",
                      order.marginPts,
                      order.leverage,
                    );
                  }
                }}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="positions">
            {!s.viewer ? (
              <EmptyState title="Sign in to view open positions">
                <Button shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>Sign in</Button>
              </EmptyState>
            ) : openPositions.length === 0 ? (
              <EmptyState title="No open positions yet" />
            ) : (
              <Card className="gap-0 overflow-hidden rounded-xl p-0">
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
          </TabsContent>

          <TabsContent value="leaderboard" className="flex flex-col gap-3">
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
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
