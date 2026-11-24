// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Label,
  LeaderboardTable,
  type LeaderboardSortColumn,
  MarketCard,
  PositionRow,
  PriceChart,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TradeTicket,
  formatPts,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

const BILLING_STATES = [
  { code: "US-AL", label: "Alabama (US-AL)" },
  { code: "US-AK", label: "Alaska (US-AK)" },
  { code: "US-AZ", label: "Arizona (US-AZ)" },
  { code: "US-AR", label: "Arkansas (US-AR)" },
  { code: "US-CA", label: "California (US-CA)" },
  { code: "US-CO", label: "Colorado (US-CO)" },
  { code: "US-CT", label: "Connecticut (US-CT)" },
  { code: "US-DE", label: "Delaware (US-DE)" },
  { code: "US-DC", label: "District of Columbia (US-DC)" },
  { code: "US-FL", label: "Florida (US-FL)" },
  { code: "US-GA", label: "Georgia (US-GA)" },
  { code: "US-HI", label: "Hawaii (US-HI)" },
  { code: "US-ID", label: "Idaho (US-ID)" },
  { code: "US-IL", label: "Illinois (US-IL)" },
  { code: "US-IN", label: "Indiana (US-IN)" },
  { code: "US-IA", label: "Iowa (US-IA)" },
  { code: "US-KS", label: "Kansas (US-KS)" },
  { code: "US-KY", label: "Kentucky (US-KY)" },
  { code: "US-LA", label: "Louisiana (US-LA)" },
  { code: "US-ME", label: "Maine (US-ME)" },
  { code: "US-MD", label: "Maryland (US-MD)" },
  { code: "US-MA", label: "Massachusetts (US-MA)" },
  { code: "US-MI", label: "Michigan (US-MI)" },
  { code: "US-MN", label: "Minnesota (US-MN)" },
  { code: "US-MS", label: "Mississippi (US-MS)" },
  { code: "US-MO", label: "Missouri (US-MO)" },
  { code: "US-MT", label: "Montana (US-MT)" },
  { code: "US-NE", label: "Nebraska (US-NE)" },
  { code: "US-NV", label: "Nevada (US-NV)" },
  { code: "US-NH", label: "New Hampshire (US-NH)" },
  { code: "US-NJ", label: "New Jersey (US-NJ)" },
  { code: "US-NM", label: "New Mexico (US-NM)" },
  { code: "US-NY", label: "New York (US-NY)" },
  { code: "US-NC", label: "North Carolina (US-NC)" },
  { code: "US-ND", label: "North Dakota (US-ND)" },
  { code: "US-OH", label: "Ohio (US-OH)" },
  { code: "US-OK", label: "Oklahoma (US-OK)" },
  { code: "US-OR", label: "Oregon (US-OR)" },
  { code: "US-PA", label: "Pennsylvania (US-PA)" },
  { code: "US-RI", label: "Rhode Island (US-RI)" },
  { code: "US-SC", label: "South Carolina (US-SC)" },
  { code: "US-SD", label: "South Dakota (US-SD)" },
  { code: "US-TN", label: "Tennessee (US-TN)" },
  { code: "US-TX", label: "Texas (US-TX)" },
  { code: "US-UT", label: "Utah (US-UT)" },
  { code: "US-VT", label: "Vermont (US-VT)" },
  { code: "US-VA", label: "Virginia (US-VA)" },
  { code: "US-WA", label: "Washington (US-WA — Blocked)" },
  { code: "US-WV", label: "West Virginia (US-WV)" },
  { code: "US-WI", label: "Wisconsin (US-WI)" },
  { code: "US-WY", label: "Wyoming (US-WY)" },
  { code: "NON-US", label: "Outside United States" },
];

function BuyPointsDialog({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const s = useAppStore();
  const [billingState, setBillingState] = useState("US-CA");
  const [selectedPackId, setSelectedPackId] = useState(s.packs[0]?.id ?? "pack_5");

  const activePackId = s.packs.some((p) => p.id === selectedPackId) ? selectedPackId : (s.packs[0]?.id ?? "pack_5");
  const isWashington = billingState === "US-WA";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>Buy virtual points</DialogTitle>
        <DialogDescription>Virtual points (pts) — no cash value. Buying points never affects leaderboard profit rank.</DialogDescription>

        {s.checkoutError ? <Alert variant="destructive">{s.checkoutError}</Alert> : null}
        {isWashington ? (
          <Alert variant="warn">
            Point purchases are blocked in Washington State (US-WA). Free play remains open.
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="billing-state-select">Billing state / region</Label>
          <Select value={billingState} onValueChange={setBillingState}>
            <SelectTrigger id="billing-state-select" aria-label="Billing state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BILLING_STATES.map((entry) => (
                <SelectItem key={entry.code} value={entry.code}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          {(s.packs.length > 0 ? s.packs : [
            { id: "pack_5", name: "500 pts Pack", usd: 5, points: 500 },
            { id: "pack_20", name: "2,000 pts Pack", usd: 20, points: 2000 },
            { id: "pack_50", name: "5,000 pts Pack", usd: 50, points: 5000 },
          ]).map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => setSelectedPackId(pack.id)}
              className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${activePackId === pack.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted"}`}
            >
              <span className="font-semibold text-foreground">{pack.name}</span>
              <span className="font-mono text-sm text-muted-foreground">${pack.usd}</span>
            </button>
          ))}
        </div>

        <Button
          loading={s.checkoutLoading}
          disabled={isWashington || s.checkoutLoading}
          onClick={() => {
            if (!s.viewer) {
              onOpenChange(false);
              storeActions.openJoinSheet("phone");
              return;
            }
            void storeActions.startPointPackCheckout(activePackId, billingState);
          }}
        >
          Checkout with Stripe
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function MarketsScreen() {
  const s = useAppStore();
  const marketTab = s.marketsTab;
  const [buyDialogOpen, setBuyDialogOpen] = useState(false);
  const [sortBy, setSortBy] = useState<LeaderboardSortColumn>("netProfit");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const balancePts = s.viewer ? formatPts(s.viewer.balanceCents / 100) : "0 pts";
  const selectedPrediction = s.predictions.find((m) => m.card.id === s.selectedMarketId) ?? s.predictions[0] ?? null;
  const selectedPerp = s.perps.find((m) => m.ticker === s.selectedMarketId) ?? s.perps[0] ?? null;

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
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">Markets & Trading</span>
            <Badge variant="outline">Virtual points (pts) — no cash value</Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {s.viewer ? `Available balance: ${balancePts}` : "Sign in with your phone to claim 100 pts and trade."}
          </span>
        </div>
        {s.viewer ? (
          <Button size="sm" variant="outline" onClick={() => setBuyDialogOpen(true)}>
            Buy pts
          </Button>
        ) : (
          <Button size="sm" onClick={() => storeActions.openJoinSheet("phone")}>
            Claim 100 pts
          </Button>
        )}
      </div>

      <Tabs value={marketTab} onValueChange={(next) => {
        if (next === "perps" || next === "positions" || next === "leaderboard" || next === "predictions") {
          storeActions.selectMarketsTab(next);
        }
      }}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="predictions">Predictions</TabsTrigger>
          <TabsTrigger value="perps">Perps (20x)</TabsTrigger>
          <TabsTrigger value="positions">Positions ({s.positions.length})</TabsTrigger>
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
                <Card className="gap-2 p-4">
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
              <Button onClick={() => storeActions.openJoinSheet("phone")}>Sign in</Button>
            </EmptyState>
          ) : s.positions.length === 0 ? (
            <EmptyState title="No open positions yet" />
          ) : (
            <Card className="gap-0 overflow-hidden p-0">
              {s.positions.map((pos) => (
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
          <Card className="gap-2 p-4">
            <CardHeader>
              <CardTitle className="text-sm">Net-Profit Standings</CardTitle>
              <CardDescription>Ranked by trading profit (equity − starting grant − purchased points).</CardDescription>
            </CardHeader>
            <CardFooter className="justify-start px-0 pt-0">
              <span className="text-xs text-muted-foreground">Virtual points (pts) — no cash value</span>
            </CardFooter>
          </Card>
          <LeaderboardTable
            rows={sortedRows}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={handleSort}
            onSelectTrader={(accountId) => {
              const found = s.leaderboard.find((r) => r.accountId === accountId);
              if (found) void storeActions.navigate(`/u/${encodeURIComponent(found.handle)}`);
            }}
          />
        </TabsContent>
      </Tabs>

      <BuyPointsDialog open={buyDialogOpen} onOpenChange={setBuyDialogOpen} />
    </div>
  );
}
