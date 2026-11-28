// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  MarketsDashboard,
  MarketsTradingTerminal,
  PostComposer,
  Skeleton,
  SpotlightTutorial,
  type ExistingPerpPosition,
  type ExistingPredictionHolding,
  type MarketsDashboardSelection,
  type PerpMarketRow,
  type PerpPricePoint,
  type PerpServerQuote,
  type PredictionMarketRow,
  type PredictionProbabilityPoint,
  type TerminalPerpMarket,
  type TerminalPredictionMarket,
  formatPts,
} from "@repo/ui";
import { HelpIcon } from "../icons.tsx";
import { FlatPostList } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import { toPredictionStatus } from "./markets-status.ts";
import type { AppWorldStatus } from "../types.ts";

function WorldClockHud({ status }: { readonly status: AppWorldStatus | null }) {
  if (!status) return null;
  return (
    <div
      aria-label={`World clock: Day ${status.currentDay}, Hour ${status.currentHour}, ${status.phase}`}
      className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs text-muted-foreground tabular-nums"
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
      .then((result) => {
        if (result.kind === "published") setDraft("");
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
      {s.marketSocialPosts.length === 0 ? (
        <EmptyState
          title={kind === "perp" ? `No posts mentioning $${marketRef} yet` : "No discussion posts for this market yet"}
        />
      ) : (
        <FlatPostList posts={s.marketSocialPosts} mode="GameMode" />
      )}
    </div>
  );
}

type ActiveTerminalMarket =
  | { readonly kind: "perp"; readonly data: TerminalPerpMarket }
  | { readonly kind: "prediction"; readonly data: TerminalPredictionMarket };

function toTerminalOutcome(raw?: "YES" | "NO" | "CANCELLED"): "yes" | "no" | null {
  if (raw === "YES") return "yes";
  if (raw === "NO") return "no";
  return null;
}

function buildTerminalMarket(
  s: ReturnType<typeof useAppStore>,
): ActiveTerminalMarket | null {
  if (s.marketsViewMode !== "terminal") return null;

  if (s.selectedMarketKind === "perp") {
    const selectedPerp = s.selectedMarketId
      ? s.perps.find((m) => m.ticker.toUpperCase() === s.selectedMarketId?.toUpperCase()) ?? null
      : null;
    if (!selectedPerp) return null;
    const priceHistory: PerpPricePoint[] = s.marketHistory.map((pt) => ({
      time: pt.recordedAt,
      price: (pt.markPriceCents ?? pt.priceCents) / 100,
    }));
    return {
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
        feeBps: 10,
        priceHistory,
      },
    };
  }

  const selectedPrediction = s.selectedMarketId
    ? s.predictions.find((m) => m.card.id === s.selectedMarketId) ?? null
    : null;
  if (!selectedPrediction) return null;
  const probabilityHistory: PredictionProbabilityPoint[] = s.marketHistory.map((pt) => ({
    time: pt.recordedAt,
    yesPrice: Math.min(0.99, Math.max(0.01, (pt.yesPriceBps ?? pt.priceCents * 100) / 10000)),
  }));
  return {
    kind: "prediction",
    data: {
      id: selectedPrediction.card.id,
      question: selectedPrediction.card.question,
      category: selectedPrediction.category,
      yesOddsPct: selectedPrediction.yesPriceBps / 100,
      yesShares: selectedPrediction.yesShares > 0 ? selectedPrediction.yesShares / 100 : 500,
      noShares: selectedPrediction.noShares > 0 ? selectedPrediction.noShares / 100 : 500,
      liquidityPts: selectedPrediction.liquidityCents / 100,
      endsAtLabel: selectedPrediction.card.closesIn ?? selectedPrediction.card.timeframe,
      feeBps: 10,
      maxOddsMoveBps: 2000,
      status: toPredictionStatus(selectedPrediction.status),
      resolvedOutcome: toTerminalOutcome(selectedPrediction.card.resolvedOutcome),
      ...(selectedPrediction.resolutionProof
        ? { resolutionCriteria: selectedPrediction.resolutionProof }
        : selectedPrediction.description
          ? { resolutionCriteria: selectedPrediction.description }
          : {}),
      ...(selectedPrediction.resolutionArticleId ? { resolutionArticleId: selectedPrediction.resolutionArticleId } : {}),
      probabilityHistory,
    },
  };
}

export function MarketsScreen() {
  const s = useAppStore();
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const balancePtsNum = s.viewer ? s.viewer.balanceCents / 100 : 0;
  const balancePts = formatPts(balancePtsNum);
  const favorites = useMemo(() => new Set(s.watchlist), [s.watchlist]);

  const openPositions = s.positions.filter((p) => !p.isClosed);
  const perpPositions: ExistingPerpPosition[] = openPositions
    .filter((p) => p.row.kind === "perp")
    .map((p) => ({
      id: p.row.id,
      ticker: p.marketId,
      side: p.rawSide === "short" ? "short" : "long",
      notionalPts: p.sizeCents / 100,
      marginPts: p.marginCents / 100,
      leverage: p.leverage,
      entryPrice: p.entryPriceCents / 100,
      markPrice: p.markPriceCents / 100,
      liquidationPrice: p.liquidationPriceCents / 100,
      unrealizedPnlPts: p.unrealizedPnlCents / 100,
      unrealizedPnlPct: p.pnlPct,
    }));

  const predictionPositions: ExistingPredictionHolding[] = openPositions
    .filter((p) => p.row.kind === "prediction")
    .map((p) => ({
      id: p.row.id,
      marketId: p.marketId,
      question: p.row.marketLabel,
      side: p.rawSide === "no" ? "NO" : "YES",
      shares: p.wholeShares,
      avgPricePct: p.avgPricePct,
      currentPricePct: p.currentPricePct,
      unrealizedPnlPts: p.unrealizedPnlCents / 100,
    }));

  const toggleFavorite = (selection: MarketsDashboardSelection) => {
    storeActions.toggleWatchlistItem(
      selection.kind,
      selection.kind === "perp" ? selection.ticker : selection.id,
    );
  };

  const handleSelectMarket = (selection: MarketsDashboardSelection) => {
    if (selection.kind === "perp") {
      storeActions.selectMarket("perp", selection.ticker);
      return;
    }
    storeActions.selectMarket("prediction", selection.id);
  };

  const perpRows: PerpMarketRow[] = s.perps.map((p) => ({
    ticker: p.ticker,
    name: p.card.name,
    ...(p.orgImageUrl ? { avatarUrl: p.orgImageUrl } : {}),
    currentPrice: p.markCents / 100,
    changePercent24h: p.change24hPct,
    volume24h: p.volume24hCents / 100,
    openInterest: p.openInterestCents / 100,
    fundingRatePct: p.fundingRateBps / 100,
    maxLeverage: p.card.maxLeverage ?? 20,
    isFavorite: favorites.has(`perp:${p.ticker.toUpperCase()}`) || favorites.has(`perp:${p.ticker}`),
  }));

  const predictionRows: PredictionMarketRow[] = s.predictions.map((m) => ({
    id: m.card.id,
    question: m.card.question,
    category: m.category,
    yesOddsPct: m.yesPriceBps / 100,
    liquidityPts: m.liquidityCents / 100,
    endsAtLabel: m.card.closesIn ?? m.card.timeframe,
    ...(m.expiresAtMs > 0 ? { endsAtMs: m.expiresAtMs } : {}),
    status: toPredictionStatus(m.status),
    resolvedOutcome: toTerminalOutcome(m.card.resolvedOutcome),
    isFavorite: favorites.has(`prediction:${m.card.id}`),
  }));

  const terminalMarket = buildTerminalMarket(s);
  const missingTerminalTarget =
    s.marketsViewMode === "terminal" && !terminalMarket && !s.marketsLoading;
  const loadingTerminalTarget =
    s.marketsViewMode === "terminal" && !terminalMarket && s.marketsLoading;

  const perpServerQuote: PerpServerQuote | null =
    terminalMarket?.kind === "perp" &&
    s.perpPreview &&
    s.perpPreview.ticker.toUpperCase() === terminalMarket.data.ticker.toUpperCase()
      ? {
          fillPricePts: s.perpPreview.entryPriceCents / 100,
          impactPct: s.perpPreview.priceImpactBps / 100,
          liquidationPricePts: s.perpPreview.liquidationPriceCents / 100,
          feePts: s.perpPreview.feeCents / 100,
          totalRequiredPts: s.perpPreview.totalDebitCents / 100,
          side: s.perpPreview.side,
          marginPts: s.perpPreview.collateralCents / 100,
          leverage: s.perpPreview.leverage,
        }
      : null;

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/85 px-4 py-2 backdrop-blur-md md:top-0 md:py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 md:gap-3">
          {!terminalMarket ? <h1 className="hidden text-base font-bold text-foreground md:block">Markets</h1> : null}
          <WorldClockHud status={s.worldStatus} />
          {s.viewer ? (
            <span className="font-mono text-xs font-semibold text-muted-foreground tabular-nums">
              {balancePts}
            </span>
          ) : (
            <span className="hidden truncate text-xs text-muted-foreground lg:inline">
              Starting capital: 100 pts — trade to climb the leaderboard
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!terminalMarket ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open trading tutorial"
              onClick={() => setTutorialOpen(true)}
            >
              <HelpIcon className="size-4" />
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate("/leaderboard"); }}>
            Leaderboard
          </Button>
          {s.viewer ? (
            <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate("/wallet"); }}>
              Wallet
            </Button>
          ) : (
            <Button size="sm" onClick={() => storeActions.openJoinSheet()}>
              Claim 100 pts
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-col">
        {terminalMarket ? (
          <MarketsTradingTerminal
            key={`${terminalMarket.kind}:${terminalMarket.kind === "perp" ? terminalMarket.data.ticker : terminalMarket.data.id}`}
            market={terminalMarket}
            initialPredictionSide={s.selectedMarketSide}
            predictionSideIntentSeq={s.marketSideIntentSeq}
            balancePts={balancePtsNum}
            timeRange={s.marketTimeRange}
            onTimeRangeChange={(range) => { void storeActions.setMarketTimeRange(range); }}
            onBack={storeActions.openMarketsDashboard}
            trades={s.marketTrades}
            tradesLoading={s.marketTradesLoading}
            chartLoading={s.marketHistoryLoading}
            socialFeed={
              <TerminalSocialFeed
                kind={terminalMarket.kind}
                marketRef={terminalMarket.kind === "perp" ? terminalMarket.data.ticker : terminalMarket.data.id}
              />
            }
            perpPositions={perpPositions}
            predictionPositions={predictionPositions}
            serverQuote={perpServerQuote}
            onPreviewPerpOrder={(order) => {
              void storeActions.previewPerpOrder(order.ticker, order.side, order.marginPts, order.leverage);
            }}
            submitting={s.tradeLoading}
            orderError={s.tradeError ?? undefined}
            onOpenPerp={(order) => {
              void storeActions.submitPerpOrder(order.ticker, order.side, order.marginPts, order.leverage, order.mode);
            }}
            onRebalancePerp={(order) => {
              void storeActions.rebalancePerpPosition(order);
            }}
            onClosePerp={(positionId) => {
              void storeActions.closePerpPosition(positionId);
            }}
            onSubmitPrediction={(order) => {
              const rawSide = order.side === "NO" ? "no" : "yes";
              if (order.action === "sell") {
                void storeActions.submitPredictionOrder(
                  order.marketId,
                  "Sell",
                  rawSide,
                  order.amountOrShares,
                  Math.max(1, Math.round(order.amountOrShares * 100)),
                );
                return;
              }
              void storeActions.submitPredictionOrder(order.marketId, "Buy", rawSide, order.amountOrShares);
            }}
            onOpenResolutionArticle={(articleId) => {
              void storeActions.navigate(`/article/${encodeURIComponent(articleId)}`);
            }}
          />
        ) : loadingTerminalTarget ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-72" />
          </div>
        ) : missingTerminalTarget ? (
          <div className="p-6">
            <EmptyState title="Market not found">
              <Button variant="outline" onClick={storeActions.openMarketsDashboard}>
                Back to Markets
              </Button>
            </EmptyState>
          </div>
        ) : (
          <MarketsDashboard
            perpMarkets={perpRows}
            predictionMarkets={predictionRows}
            defaultTab={s.perps.length > 0 ? "perps" : "predictions"}
            onSelectMarket={handleSelectMarket}
            onToggleFavorite={toggleFavorite}
            loading={s.marketsLoading && s.perps.length === 0 && s.predictions.length === 0}
          />
        )}
      </div>

      <SpotlightTutorial open={tutorialOpen} onOpenChange={setTutorialOpen} />
    </div>
  );
}
