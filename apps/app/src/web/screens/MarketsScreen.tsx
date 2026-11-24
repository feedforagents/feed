// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  MarketsDashboard,
  MarketsTradingTerminal,
  type ExistingPerpPosition,
  type ExistingPredictionHolding,
  type MarketTimeRange,
  type MarketsDashboardSelection,
  type PerpMarketRow,
  type PerpPricePoint,
  type PredictionMarketRow,
  type PredictionProbabilityPoint,
  type TerminalPerpMarket,
  type TerminalPredictionMarket,
  formatPts,
} from "@repo/ui";
import { FlatPostList } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";

const FAVORITES_STORAGE_KEY = "feed:market-favorites";

const RANGE_MS: Record<MarketTimeRange, number | null> = {
  "1H": 3_600_000,
  "4H": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
  ALL: null,
};

function readFavoriteKeys(): ReadonlySet<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function writeFavoriteKeys(keys: ReadonlySet<string>): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...keys]));
    }
  } catch {
    return;
  }
}

function favoriteKey(selection: MarketsDashboardSelection): string {
  return selection.kind === "perp" ? `perp:${selection.ticker}` : `prediction:${selection.id}`;
}

type ActiveTerminalMarket =
  | { readonly kind: "perp"; readonly data: TerminalPerpMarket }
  | { readonly kind: "prediction"; readonly data: TerminalPredictionMarket };

function ServerPerpQuoteCard() {
  const s = useAppStore();
  const preview = s.perpPreview;
  if (!preview) return null;
  const heading = `Server Execution Quote ($${preview.ticker})`;
  return (
    <Card className="gap-2 rounded-xl p-4">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground">{heading}</CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="font-mono uppercase">
            {preview.side} {preview.leverage}x
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            shape="pill"
            onClick={() => {
              void storeActions.previewPerpOrder(
                preview.ticker,
                preview.side === "short" ? "long" : "short",
                10,
                5,
              );
            }}
          >
            Quote {preview.side === "short" ? "Long" : "Short"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 font-mono text-xs tabular-nums sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Est. fill</dt>
            <dd className="font-semibold text-foreground">{formatPts(preview.entryPriceCents / 100)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Liq. price</dt>
            <dd className="font-semibold text-foreground">{formatPts(preview.liquidationPriceCents / 100)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Fee</dt>
            <dd className="font-semibold text-foreground">{formatPts(preview.feeCents / 100)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Impact</dt>
            <dd className="font-semibold text-foreground">{(preview.priceImpactBps / 100).toFixed(2)}%</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function buildTerminalMarket(
  s: ReturnType<typeof useAppStore>,
  timeRange: MarketTimeRange,
): ActiveTerminalMarket | null {
  if (s.marketsViewMode !== "terminal") return null;
  const rangeMs = RANGE_MS[timeRange];
  const latestHistMs = s.marketHistory.reduce((acc, pt) => Math.max(acc, pt.recordedAt), 0);
  const cutoffMs = rangeMs !== null && latestHistMs > 0 ? latestHistMs - rangeMs : null;
  const filteredHistory = s.marketHistory.filter((pt) => cutoffMs === null || pt.recordedAt >= cutoffMs);

  if (s.selectedMarketKind === "perp") {
    const selectedPerp = s.perps.find((m) => m.ticker.toUpperCase() === (s.selectedMarketId ?? "").toUpperCase())
      ?? s.perps[0]
      ?? null;
    if (!selectedPerp) return null;
    const priceHistory: PerpPricePoint[] = filteredHistory.map((pt) => ({
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

  const selectedPrediction = s.predictions.find((m) => m.card.id === s.selectedMarketId) ?? s.predictions[0] ?? null;
  if (!selectedPrediction) return null;
  const probabilityHistory: PredictionProbabilityPoint[] = filteredHistory.map((pt) => ({
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
      yesShares: selectedPrediction.yesShares > 0 ? selectedPrediction.yesShares / 100 : 50,
      noShares: selectedPrediction.noShares > 0 ? selectedPrediction.noShares / 100 : 50,
      liquidityPts: selectedPrediction.liquidityCents / 100,
      endsAtLabel: selectedPrediction.card.closesIn ?? selectedPrediction.card.timeframe,
      feeBps: 10,
      maxOddsMoveBps: 2000,
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
  const [timeRange, setTimeRange] = useState<MarketTimeRange>("1D");
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(readFavoriteKeys);

  const balancePtsNum = s.viewer ? s.viewer.balanceCents / 100 : 0;
  const balancePts = formatPts(balancePtsNum);

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
    const key = favoriteKey(selection);
    const next = new Set(favorites);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    writeFavoriteKeys(next);
    setFavorites(next);
  };

  const handleSelectMarket = (selection: MarketsDashboardSelection) => {
    if (selection.kind === "perp") {
      storeActions.selectMarket("perp", selection.ticker);
      void storeActions.previewPerpOrder(selection.ticker, "long", 10, 5);
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
    isFavorite: favorites.has(`perp:${p.ticker}`),
  }));

  const predictionRows: PredictionMarketRow[] = s.predictions.map((m) => ({
    id: m.card.id,
    question: m.card.question,
    category: m.category,
    yesOddsPct: m.yesPriceBps / 100,
    liquidityPts: m.liquidityCents / 100,
    endsAtLabel: m.card.closesIn ?? m.card.timeframe,
    ...(m.expiresAtMs > 0 ? { endsAtMs: m.expiresAtMs } : {}),
    isFavorite: favorites.has(`prediction:${m.card.id}`),
  }));

  const terminalMarket = buildTerminalMarket(s, timeRange);

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-base font-bold text-foreground">Markets</h1>
          {s.viewer ? (
            <span className="font-mono text-xs font-semibold text-muted-foreground tabular-nums">
              {balancePts}
            </span>
          ) : (
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              Starting capital: 100 pts — trade to climb the leaderboard
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/leaderboard"); }}>
            Leaderboard
          </Button>
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
        {terminalMarket ? (
          <>
            <MarketsTradingTerminal
              key={`${terminalMarket.kind}:${terminalMarket.kind === "perp" ? terminalMarket.data.ticker : terminalMarket.data.id}`}
              market={terminalMarket}
              balancePts={balancePtsNum}
              timeRange={timeRange}
              onTimeRangeChange={setTimeRange}
              onBack={storeActions.openMarketsDashboard}
              trades={s.marketTrades}
              tradesLoading={s.marketTradesLoading}
              chartLoading={s.marketHistoryLoading}
              socialFeed={
                s.marketSocialPosts.length > 0 ? (
                  <FlatPostList posts={s.marketSocialPosts} mode="GameMode" />
                ) : undefined
              }
              perpPositions={perpPositions}
              predictionPositions={predictionPositions}
              submitting={s.tradeLoading}
              orderError={s.tradeError ?? undefined}
              onOpenPerp={(order) => {
                void storeActions.submitPerpOrder(order.ticker, order.side, order.marginPts, order.leverage);
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
            {terminalMarket.kind === "perp" ? <ServerPerpQuoteCard /> : null}
          </>
        ) : (
          <MarketsDashboard
            key={s.perps.length > 0 ? "perps-ready" : "preds-default"}
            perpMarkets={perpRows}
            predictionMarkets={predictionRows}
            defaultTab={s.perps.length > 0 ? "perps" : "predictions"}
            onSelectMarket={handleSelectMarket}
            onToggleFavorite={toggleFavorite}
            loading={s.marketsLoading && s.perps.length === 0 && s.predictions.length === 0}
          />
        )}
      </div>
    </div>
  );
}
