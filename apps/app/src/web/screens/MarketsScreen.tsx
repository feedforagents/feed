// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  type ExistingPerpPosition,
  type ExistingPredictionHolding,
  MarketsDashboard,
  MarketsTradingTerminal,
  type PerpMarketRow,
  PostComposer,
  type PredictionMarketRow,
  Skeleton,
  SpotlightTutorial,
  formatPts,
} from "@repo/ui";
import { HelpIcon } from "../icons.tsx";
import { FeedPostCard } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPerpMarket, AppPosition, AppPredictionMarket, AppWorldStatus } from "../types.ts";

function WorldClockHud({ status }: { readonly status: AppWorldStatus | null }) {
  if (!status) return null;
  return (
    <div
      aria-label={`World clock: Day ${status.currentDay}, Hour ${status.currentHour}, ${status.phase}`}
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-xs text-muted-foreground tabular-nums"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${status.gameRunning ? "bg-ok" : "bg-muted-foreground"}`}
      />
      <span className="font-semibold text-foreground">Day {status.currentDay}</span>
      <span aria-hidden="true">·</span>
      <span>Hour {status.currentHour}</span>
      <span aria-hidden="true">·</span>
      <span className="capitalize">{status.phase}</span>
    </div>
  );
}

function TerminalSocialFeed({
  kind,
  marketRef,
}: {
  readonly kind: "perp" | "prediction";
  readonly marketRef: string;
}) {
  const s = useAppStore();
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const handleSubmit = (content: string) => {
    if (posting) return;
    setPosting(true);
    void storeActions
      .createPost(content, kind === "perp" ? { ticker: marketRef } : { marketId: marketRef })
      .then((ok) => {
        if (ok) setDraft("");
      })
      .finally(() => {
        setPosting(false);
      });
  };

  return (
    <div className="flex flex-col gap-4">
      {s.viewer ? (
        <PostComposer
          value={draft}
          onValueChange={setDraft}
          onSubmit={handleSubmit}
          authorName={s.viewer.displayName}
          authorAvatarUrl={s.viewer.avatarUrl ?? undefined}
          placeholder={kind === "perp" ? `Share your thesis on $${marketRef}…` : "Discuss this prediction market…"}
          submitLabel="Post"
          loading={posting}
        />
      ) : null}

      {s.marketSocialLoading && s.marketSocialPosts.length === 0 ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : s.marketSocialPosts.length === 0 ? (
        <EmptyState
          title={kind === "perp" ? `No posts mentioning $${marketRef} yet` : "No discussion posts for this market yet"}
        />
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {s.marketSocialPosts.map((post) => (
            <FeedPostCard key={post.card.id} post={post} mode="GameMode" />
          ))}
        </div>
      )}
    </div>
  );
}

function toPerpMarketRow(perp: AppPerpMarket, watchlistSet: ReadonlySet<string>): PerpMarketRow {
  return {
    ticker: perp.ticker,
    name: perp.card.name,
    ...(perp.orgImageUrl ? { avatarUrl: perp.orgImageUrl } : {}),
    currentPrice: perp.markCents / 100,
    changePercent24h: perp.change24hPct,
    volume24h: perp.volume24hCents / 100,
    openInterest: perp.openInterestCents / 100,
    fundingRatePct: perp.fundingRateBps / 100,
    maxLeverage: perp.card.maxLeverage ?? 20,
    isFavorite: watchlistSet.has(`perp:${perp.ticker.toUpperCase()}`),
  };
}

function toPredictionMarketRow(pred: AppPredictionMarket, watchlistSet: ReadonlySet<string>): PredictionMarketRow {
  return {
    id: pred.card.id,
    question: pred.card.question,
    category: pred.category,
    yesOddsPct: pred.yesPriceBps / 100,
    liquidityPts: pred.liquidityCents / 100,
    endsAtLabel: pred.card.closesIn ?? (pred.status === "open" ? "Open" : pred.status),
    endsAtMs: pred.expiresAtMs,
    isFavorite: watchlistSet.has(`prediction:${pred.card.id}`),
  };
}

function toExistingPerpPositions(positions: ReadonlyArray<AppPosition>): ReadonlyArray<ExistingPerpPosition> {
  return positions
    .filter((pos) => !pos.isClosed && pos.row.kind === "perp")
    .map((pos) => ({
      id: pos.row.id,
      ticker: pos.marketId,
      side: pos.rawSide === "short" ? "short" : "long",
      notionalPts: pos.sizeCents / 100,
      marginPts: pos.marginCents / 100,
      leverage: pos.leverage,
      entryPrice: pos.entryPriceCents / 100,
      markPrice: pos.markPriceCents / 100,
      liquidationPrice: pos.liquidationPriceCents / 100,
      unrealizedPnlPts: pos.unrealizedPnlCents / 100,
      unrealizedPnlPct: pos.marginCents > 0 ? (pos.unrealizedPnlCents / pos.marginCents) * 100 : 0,
    }));
}

function toExistingPredictionHoldings(positions: ReadonlyArray<AppPosition>): ReadonlyArray<ExistingPredictionHolding> {
  return positions
    .filter((pos) => !pos.isClosed && pos.row.kind === "prediction")
    .map((pos) => ({
      id: pos.row.id,
      marketId: pos.marketId,
      question: pos.row.marketLabel,
      side: pos.rawSide === "no" ? "NO" : "YES",
      shares: pos.shares,
      avgPricePct: pos.shares > 0 ? Math.min(100, Math.max(0, pos.costBasisCents / pos.shares)) : pos.sidePriceBps / 100,
      currentPricePct: pos.sidePriceBps / 100,
      unrealizedPnlPts: pos.unrealizedPnlCents / 100,
    }));
}

export function MarketsScreen() {
  const s = useAppStore();
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const balancePts = s.viewer ? s.viewer.balanceCents / 100 : 0;
  const formattedBalance = formatPts(balancePts);
  const watchlistSet = useMemo(() => new Set(s.watchlist), [s.watchlist]);

  const perpRows = useMemo(
    () => s.perps.map((perp) => toPerpMarketRow(perp, watchlistSet)),
    [s.perps, watchlistSet],
  );
  const predictionRows = useMemo(
    () => s.predictions.map((pred) => toPredictionMarketRow(pred, watchlistSet)),
    [s.predictions, watchlistSet],
  );
  const perpPositions = useMemo(() => toExistingPerpPositions(s.positions), [s.positions]);
  const predictionPositions = useMemo(() => toExistingPredictionHoldings(s.positions), [s.positions]);

  const selectedPerp = s.selectedMarketId && s.selectedMarketKind === "perp"
    ? s.perps.find((p) => p.ticker.toUpperCase() === s.selectedMarketId?.toUpperCase()) ?? null
    : null;
  const selectedPrediction = s.selectedMarketId && s.selectedMarketKind === "prediction"
    ? s.predictions.find((m) => m.card.id === s.selectedMarketId) ?? null
    : null;

  const isTerminalRoute = s.selectedMarketId !== null;
  const initialDashboardTab = s.perps.length > 0 ? "perps" : "predictions";

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur-md md:top-0">
        <div className="flex flex-wrap items-center gap-3">
          <WorldClockHud status={s.worldStatus} />
          {s.viewer ? (
            <span className="font-mono text-xs font-semibold text-muted-foreground tabular-nums">
              {formattedBalance}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {!isTerminalRoute ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open trading tutorial"
              onClick={() => setTutorialOpen(true)}
            >
              <HelpIcon className="size-4" />
            </Button>
          ) : null}
          {s.viewer ? (
            <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/wallet"); }}>
              Wallet
            </Button>
          ) : (
            <Button size="sm" shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
              Claim 100 pts
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {isTerminalRoute ? (
          selectedPerp ? (
            <MarketsTradingTerminal
              market={{
                kind: "perp",
                data: {
                  ticker: selectedPerp.ticker,
                  name: selectedPerp.card.name,
                  ...(selectedPerp.orgImageUrl ? { avatarUrl: selectedPerp.orgImageUrl } : {}),
                  currentPrice: selectedPerp.markCents / 100,
                  indexPrice: selectedPerp.indexCents / 100,
                  changePercent24h: selectedPerp.change24hPct,
                  volume24h: selectedPerp.volume24hCents / 100,
                  openInterest: selectedPerp.openInterestCents / 100,
                  fundingRatePct: selectedPerp.fundingRateBps / 100,
                  maxLeverage: selectedPerp.card.maxLeverage ?? 20,
                  priceHistory: s.perpHistory,
                },
              }}
              balancePts={balancePts}
              timeRange={s.marketTimeRange}
              onTimeRangeChange={(range) => { void storeActions.setMarketTimeRange(range); }}
              onBack={() => { void storeActions.navigate("/markets"); }}
              trades={s.marketTrades}
              tradesLoading={s.marketTradesLoading}
              chartLoading={s.marketChartLoading}
              socialFeed={<TerminalSocialFeed kind="perp" marketRef={selectedPerp.ticker} />}
              perpPositions={perpPositions}
              predictionPositions={predictionPositions}
              onOpenPerp={(order) => {
                void storeActions.submitPerpOrder(order.ticker, order.side, order.marginPts, order.leverage);
              }}
              onRebalancePerp={(order) => {
                void storeActions.rebalancePerpPosition({
                  positionId: order.positionId,
                  ticker: order.ticker,
                  action: order.action,
                  side: order.nextSide,
                  marginPts: order.marginPts,
                  resultingNotionalPts: order.resultingNotionalPts,
                  leverage: order.leverage,
                });
              }}
              onClosePerp={(positionId) => { void storeActions.closePerpPosition(positionId); }}
              onSubmitPrediction={(order) => {
                void storeActions.submitPredictionOrder(
                  order.marketId,
                  order.action === "sell" ? "Sell" : "Buy",
                  order.side === "NO" ? "no" : "yes",
                  order.amountOrShares,
                );
              }}
              onOpenResolutionArticle={(articleId) => { void storeActions.navigate(`/article/${encodeURIComponent(articleId)}`); }}
              submitting={s.tradeLoading}
              orderError={s.tradeError ?? undefined}
              confirmBeforeSubmit
            />
          ) : selectedPrediction ? (
            <MarketsTradingTerminal
              market={{
                kind: "prediction",
                data: {
                  id: selectedPrediction.card.id,
                  question: selectedPrediction.card.question,
                  category: selectedPrediction.category,
                  yesOddsPct: selectedPrediction.yesPriceBps / 100,
                  yesShares: selectedPrediction.yesShares > 0 ? selectedPrediction.yesShares : 500,
                  noShares: selectedPrediction.noShares > 0 ? selectedPrediction.noShares : 500,
                  liquidityPts: selectedPrediction.liquidityCents / 100,
                  endsAtLabel: selectedPrediction.card.closesIn,
                  resolutionCriteria: selectedPrediction.resolutionProof ?? (selectedPrediction.description || undefined),
                  ...(selectedPrediction.resolutionArticleId
                    ? { resolutionArticleId: selectedPrediction.resolutionArticleId }
                    : {}),
                  probabilityHistory: s.predictionHistory,
                },
              }}
              balancePts={balancePts}
              timeRange={s.marketTimeRange}
              onTimeRangeChange={(range) => { void storeActions.setMarketTimeRange(range); }}
              onBack={() => { void storeActions.navigate("/markets"); }}
              trades={s.marketTrades}
              tradesLoading={s.marketTradesLoading}
              chartLoading={s.marketChartLoading}
              socialFeed={<TerminalSocialFeed kind="prediction" marketRef={selectedPrediction.card.id} />}
              perpPositions={perpPositions}
              predictionPositions={predictionPositions}
              onOpenPerp={(order) => {
                void storeActions.submitPerpOrder(order.ticker, order.side, order.marginPts, order.leverage);
              }}
              onRebalancePerp={(order) => {
                void storeActions.rebalancePerpPosition({
                  positionId: order.positionId,
                  ticker: order.ticker,
                  action: order.action,
                  side: order.nextSide,
                  marginPts: order.marginPts,
                  resultingNotionalPts: order.resultingNotionalPts,
                  leverage: order.leverage,
                });
              }}
              onClosePerp={(positionId) => { void storeActions.closePerpPosition(positionId); }}
              onSubmitPrediction={(order) => {
                void storeActions.submitPredictionOrder(
                  order.marketId,
                  order.action === "sell" ? "Sell" : "Buy",
                  order.side === "NO" ? "no" : "yes",
                  order.amountOrShares,
                );
              }}
              onOpenResolutionArticle={(articleId) => { void storeActions.navigate(`/article/${encodeURIComponent(articleId)}`); }}
              submitting={s.tradeLoading}
              orderError={s.tradeError ?? undefined}
              confirmBeforeSubmit
            />
          ) : s.marketsLoading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
          ) : (
            <EmptyState title="Market not found">
              <Button size="sm" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
                Back to Markets
              </Button>
            </EmptyState>
          )
        ) : (
          <MarketsDashboard
            key={initialDashboardTab}
            defaultTab={initialDashboardTab}
            perpMarkets={perpRows}
            predictionMarkets={predictionRows}
            loading={s.marketsLoading && perpRows.length === 0 && predictionRows.length === 0}
            onSelectMarket={(selection) => {
              const path = selection.kind === "perp"
                ? `/markets/perps/${encodeURIComponent(selection.ticker)}`
                : `/markets/predictions/${encodeURIComponent(selection.id)}`;
              void storeActions.navigate(path);
            }}
            onToggleFavorite={(selection) => {
              storeActions.toggleWatchlistItem(
                selection.kind,
                selection.kind === "perp" ? selection.ticker : selection.id,
              );
            }}
          />
        )}
      </div>

      <SpotlightTutorial open={tutorialOpen} onOpenChange={setTutorialOpen} />
    </div>
  );
}
