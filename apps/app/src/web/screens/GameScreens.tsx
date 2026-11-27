// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useState } from "react";
import {
  Button,
  EmptyState,
  formatPts,
  LeaderboardPanel,
  TradeConfirmationDialog,
  WalletPanel,
  type LeaderboardMetric,
  type LeaderboardSortColumn,
  type LightweightChartPoint,
  type TradeConfirmationDetails,
  type WalletLedgerEntry,
  type WalletOpenPosition,
  type WalletSummary,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPosition } from "../types.ts";

function formatLedgerKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function calcLiquidationDistancePct(markCents: number, liqCents: number, side: "long" | "short"): number | undefined {
  if (markCents <= 0 || liqCents <= 0) return undefined;
  const diff = side === "long" ? markCents - liqCents : liqCents - markCents;
  return Math.max(0, (diff / markCents) * 100);
}

function calcCeilFeePts(notionalCents: number, feeBps = 10): number {
  if (notionalCents <= 0 || feeBps <= 0) return 0;
  return Math.ceil((notionalCents * feeBps) / 10_000) / 100;
}

function buildCloseConfirmation(pos: AppPosition): TradeConfirmationDetails {
  if (pos.row.kind === "perp") {
    const notionalPts = pos.sizeCents / 100;
    return {
      kind: "close-perp",
      ticker: pos.marketId,
      side: pos.rawSide === "short" ? "short" : "long",
      notionalPts,
      leverage: pos.leverage,
      entryPrice: pos.entryPriceCents / 100,
      markPrice: pos.markPriceCents / 100,
      estimatedFeePts: calcCeilFeePts(pos.sizeCents, 10),
      unrealizedPnlPts: pos.unrealizedPnlCents / 100,
      unrealizedPnlPct: pos.pnlPct,
    };
  }
  const grossCents = Math.max(0, pos.grossSizeCents);
  const grossProceedsPts = grossCents / 100;
  const estimatedFeePts = calcCeilFeePts(grossCents, 10);
  return {
    kind: "sell-prediction",
    question: pos.row.marketLabel,
    side: pos.rawSide === "no" ? "NO" : "YES",
    shares: pos.wholeShares,
    avgPricePct: pos.wholeShares > 0 ? grossCents / pos.wholeShares : pos.currentPricePct,
    grossProceedsPts,
    estimatedFeePts,
    netProceedsPts: Math.max(0, grossProceedsPts - estimatedFeePts),
    unrealizedPnlPts: pos.unrealizedPnlCents / 100,
  };
}

function metricToSortColumn(metric: LeaderboardMetric): LeaderboardSortColumn {
  switch (metric) {
    case "return_pct":
      return "returnPct";
    case "win_rate":
      return "winRate";
    case "volume":
      return "volume";
    case "net_profit":
      return "netProfit";
  }
}

function sortColumnToMetric(col: LeaderboardSortColumn): LeaderboardMetric {
  switch (col) {
    case "returnPct":
      return "return_pct";
    case "winRate":
      return "win_rate";
    case "volume":
      return "volume";
    default:
      return "net_profit";
  }
}

export function LeaderboardScreen() {
  const s = useAppStore();

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-xs text-muted-foreground">
            {s.leaderboardAudience === "npcs"
              ? "Autonomous NPC traders ranked by net profit"
              : "Starting capital: 100 pts — trade to climb the leaderboard"}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate("/markets"); }}>
          Trade Markets
        </Button>
      </header>

      <LeaderboardPanel
        rows={[...s.leaderboard]}
        audience={s.leaderboardAudience}
        onAudienceChange={(audience) => {
          void storeActions.loadLeaderboard({ audience, page: 1 });
        }}
        timeframe={s.leaderboardTimeframe}
        onTimeframeChange={(timeframe) => {
          void storeActions.loadLeaderboard({ timeframe, page: 1 });
        }}
        page={s.leaderboardPage}
        totalPages={s.leaderboardTotalPages}
        onPageChange={(page) => {
          void storeActions.loadLeaderboard({ page });
        }}
        sortBy={metricToSortColumn(s.leaderboardMetric)}
        sortDir="descending"
        onSort={(col) => {
          void storeActions.loadLeaderboard({ metric: sortColumnToMetric(col), page: 1 });
        }}
        viewerAccountId={s.viewer?.accountId}
        viewerPosition={s.leaderboardCurrentUser}
        onJumpToMyPosition={() => {
          void storeActions.jumpToMyLeaderboardRank();
        }}
        onFollow={(accountId) => {
          const found = s.leaderboard.find((r) => r.accountId === accountId);
          if (found) void storeActions.toggleFollow(found.handle, found.isFollowing);
        }}
        onViewProfile={(handle) => {
          void storeActions.navigate(`/u/${encodeURIComponent(handle)}`);
        }}
        loading={s.leaderboardLoading && s.leaderboard.length === 0}
      />
    </div>
  );
}

export function WalletScreen() {
  const s = useAppStore();
  const [pendingClose, setPendingClose] = useState<{
    readonly pos: AppPosition;
    readonly details: TradeConfirmationDetails;
  } | null>(null);

  const econ = s.economy;
  const startingGrantCents = econ?.startingGrantCents ?? s.viewer?.startingGrantCents ?? 10000;
  const cashCents = econ?.balanceCents ?? s.viewer?.balanceCents ?? 0;
  const positionCents = econ?.positionValueCents ?? 0;
  const equityCents = econ?.equityCents ?? cashCents + positionCents;
  const netProfitCents = econ?.netProfitCents ?? equityCents - startingGrantCents;
  const feesPaidCents = econ?.totalFeesPaidCents ?? 0;
  const roiPct = startingGrantCents > 0 ? (netProfitCents / startingGrantCents) * 100 : 0;

  const summary: WalletSummary = {
    equityPts: equityCents / 100,
    cashPts: cashCents / 100,
    openPositionsValuePts: positionCents / 100,
    netProfitPts: netProfitCents / 100,
    roiPct,
    feesPaidPts: feesPaidCents / 100,
  };

  const openPositions = s.positions.filter((p) => !p.isClosed);
  const walletOpenPositions: WalletOpenPosition[] = openPositions.map((pos) => {
    const liqDist = pos.row.kind === "perp"
      ? calcLiquidationDistancePct(
          pos.markPriceCents,
          pos.liquidationPriceCents,
          pos.rawSide === "short" ? "short" : "long",
        )
      : undefined;
    return {
      id: pos.row.id,
      kind: pos.row.kind,
      marketLabel: pos.row.marketLabel,
      side: pos.row.side,
      sizeLabel: pos.row.quantityLabel,
      ...(pos.row.leverage ? { leverage: pos.row.leverage } : {}),
      entryLabel: pos.row.entryLabel,
      markLabel: pos.row.markLabel,
      pnlPts: pos.row.pnlPts,
      pnlPct: pos.pnlPct,
      ...(pos.row.liquidationLabel ? { liquidationLabel: pos.row.liquidationLabel } : {}),
      ...(liqDist !== undefined ? { liquidationDistancePct: liqDist } : {}),
    };
  });

  const ledgerEntries: WalletLedgerEntry[] = s.ledger.map((row) => ({
    id: row.id,
    timestampLabel: row.timestamp,
    eventLabel: formatLedgerKind(row.kind),
    deltaPts: row.deltaCents / 100,
    balanceAfterPts: row.balanceAfterCents / 100,
  }));

  const earliestLedgerMs = s.ledger.reduce(
    (acc, row) => (row.createdAtMs > 0 ? Math.min(acc, row.createdAtMs) : acc),
    Number.POSITIVE_INFINITY,
  );
  const latestLedgerMs = s.ledger.reduce(
    (acc, row) => (row.createdAtMs > 0 ? Math.max(acc, row.createdAtMs) : acc),
    0,
  );
  const endMs = Math.max(latestLedgerMs, s.worldStatus?.lastTickAt ?? 0);
  const fallbackPnlHistory: LightweightChartPoint[] =
    endMs > 0
      ? [
          { time: Number.isFinite(earliestLedgerMs) ? Math.min(earliestLedgerMs, endMs - 60_000) : endMs - 3_600_000, value: 0 },
          { time: endMs, value: netProfitCents / 100 },
        ]
      : [];
  const pnlHistory = s.pnlHistory.length > 0 ? s.pnlHistory : fallbackPnlHistory;

  const handleConfirmClose = async () => {
    if (!pendingClose || s.tradeLoading) return;
    const found = pendingClose.pos;
    const ok = found.row.kind === "perp"
      ? await storeActions.closePerpPosition(found.row.id)
      : await storeActions.submitPredictionOrder(
          found.marketId,
          "Sell",
          found.rawSide === "no" ? "no" : "yes",
          found.wholeShares,
          found.shares,
        );
    if (ok) {
      setPendingClose(null);
    }
  };

  return (
    <div className="flex flex-col">
      <header className="hidden h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:sticky md:top-0 md:z-20 md:flex">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-base font-bold text-foreground">Wallet</h1>
          <span className="truncate text-xs text-muted-foreground">
            Starting capital: {formatPts(startingGrantCents / 100)} — trade to climb the leaderboard
          </span>
        </div>
        <Button size="sm" onClick={() => { void storeActions.navigate("/markets"); }}>
          Markets
        </Button>
      </header>

      {!s.viewer ? (
        <div className="p-6">
          <EmptyState title="Sign in to view your wallet">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button shape="pill" onClick={() => storeActions.openJoinSheet()}>
                Sign in &amp; claim {formatPts(startingGrantCents / 100)}
              </Button>
              <Button size="sm" variant="outline" className="md:hidden" onClick={() => { void storeActions.navigate("/markets"); }}>
                Markets
              </Button>
            </div>
          </EmptyState>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3 md:hidden">
            <span className="truncate text-xs text-muted-foreground">
              Starting capital: {formatPts(startingGrantCents / 100)}
            </span>
            <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate("/markets"); }}>
              Markets
            </Button>
          </div>
          <WalletPanel
            summary={summary}
            pnlHistory={pnlHistory}
            pnlTimeRange={s.pnlTimeRange}
            onPnlTimeRangeChange={(range) => { void storeActions.loadPnlHistory(range); }}
            openPositions={walletOpenPositions}
            closedPositions={s.closedPositions}
            ledgerEntries={ledgerEntries}
            loading={s.economyLoading && s.economy === null}
            submitting={s.tradeLoading}
            onSelectPosition={(id, kind) => {
              const found = openPositions.find((pos) => pos.row.id === id);
              if (!found) return;
              if (kind === "perp") {
                void storeActions.navigate(`/markets/perps/${encodeURIComponent(found.marketId)}`);
                return;
              }
              storeActions.openPredictionQuickTrade(found.marketId, found.rawSide === "no" ? "no" : "yes");
            }}
            onClosePosition={(id) => {
              const found = openPositions.find((pos) => pos.row.id === id);
              if (!found) return;
              setPendingClose({ pos: found, details: buildCloseConfirmation(found) });
            }}
          />
        </div>
      )}

      <TradeConfirmationDialog
        open={pendingClose !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !s.tradeLoading) setPendingClose(null);
        }}
        details={pendingClose?.details ?? null}
        submitting={s.tradeLoading}
        onConfirm={() => { void handleConfirmClose(); }}
      />
    </div>
  );
}
