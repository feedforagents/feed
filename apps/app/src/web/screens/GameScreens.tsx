// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  LeaderboardPanel,
  type LeaderboardSortColumn,
  type TradeConfirmationDetails,
  TradeConfirmationDialog,
  type WalletLedgerEntry,
  type WalletOpenPosition,
  WalletPanel,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPosition } from "../types.ts";

function formatLedgerKind(kind: string): string {
  return kind
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function calcLiquidationDistancePct(markCents: number, liqCents: number, side: "long" | "short"): number | undefined {
  if (markCents <= 0 || liqCents <= 0) return undefined;
  const diff = side === "long" ? markCents - liqCents : liqCents - markCents;
  return Math.max(0, (diff / markCents) * 100);
}

function toWalletOpenPosition(pos: AppPosition): WalletOpenPosition {
  if (pos.row.kind === "perp") {
    const side = pos.rawSide === "short" ? "short" : "long";
    const liqDist = calcLiquidationDistancePct(pos.markPriceCents, pos.liquidationPriceCents, side);
    const pnlPct = pos.marginCents > 0 ? (pos.unrealizedPnlCents / pos.marginCents) * 100 : 0;
    return {
      id: pos.row.id,
      kind: "perp",
      marketLabel: pos.row.marketLabel,
      side: side === "short" ? "Short" : "Long",
      sizeLabel: pos.row.quantityLabel,
      leverage: pos.leverage,
      entryLabel: pos.row.entryLabel,
      markLabel: pos.row.markLabel,
      pnlPts: pos.unrealizedPnlCents / 100,
      pnlPct,
      ...(pos.row.liquidationLabel ? { liquidationLabel: pos.row.liquidationLabel } : {}),
      ...(liqDist !== undefined ? { liquidationDistancePct: liqDist } : {}),
    };
  }
  const pnlPct = pos.costBasisCents > 0 ? (pos.unrealizedPnlCents / pos.costBasisCents) * 100 : 0;
  return {
    id: pos.row.id,
    kind: "prediction",
    marketLabel: pos.row.marketLabel,
    side: pos.rawSide === "no" ? "NO" : "YES",
    sizeLabel: pos.row.quantityLabel,
    entryLabel: pos.row.entryLabel,
    markLabel: pos.row.markLabel,
    pnlPts: pos.unrealizedPnlCents / 100,
    pnlPct,
  };
}

function buildCloseConfirmation(pos: AppPosition): TradeConfirmationDetails {
  if (pos.row.kind === "perp") {
    const notionalPts = pos.sizeCents / 100;
    const unrealizedPnlPts = pos.unrealizedPnlCents / 100;
    const unrealizedPnlPct = pos.marginCents > 0 ? (pos.unrealizedPnlCents / pos.marginCents) * 100 : 0;
    return {
      kind: "close-perp",
      ticker: pos.marketId,
      side: pos.rawSide === "short" ? "short" : "long",
      notionalPts,
      leverage: pos.leverage,
      entryPrice: pos.entryPriceCents / 100,
      markPrice: pos.markPriceCents / 100,
      estimatedFeePts: Math.max(0.01, (notionalPts * 10) / 10_000),
      unrealizedPnlPts,
      unrealizedPnlPct,
    };
  }
  const avgPricePct = pos.sidePriceBps / 100;
  const grossProceedsPts = pos.estimatedValueCents / 100;
  const estimatedFeePts = Math.max(0.01, (grossProceedsPts * 10) / 10_000);
  return {
    kind: "sell-prediction",
    question: pos.row.marketLabel,
    side: pos.rawSide === "no" ? "NO" : "YES",
    shares: pos.shares,
    avgPricePct,
    grossProceedsPts,
    estimatedFeePts,
    netProceedsPts: Math.max(0, grossProceedsPts - estimatedFeePts),
    unrealizedPnlPts: pos.unrealizedPnlCents / 100,
  };
}

export function LeaderboardScreen() {
  const s = useAppStore();
  const [sortBy, setSortBy] = useState<LeaderboardSortColumn>("rank");
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("ascending");

  const sortedRows = useMemo(() => {
    const dir = sortDir === "ascending" ? 1 : -1;
    return [...s.leaderboard].sort((a, b) => {
      if (sortBy === "rank") return (a.rank - b.rank) * dir;
      if (sortBy === "returnPct") return ((a.roiPct ?? 0) - (b.roiPct ?? 0)) * dir;
      if (sortBy === "winRate") return (a.winRatePct - b.winRatePct) * dir;
      if (sortBy === "volume") return (a.volumePts - b.volumePts) * dir;
      return (a.netProfitPts - b.netProfitPts) * dir;
    });
  }, [s.leaderboard, sortBy, sortDir]);

  const handleSort = (col: LeaderboardSortColumn) => {
    if (sortBy === col) {
      setSortDir(sortDir === "descending" ? "ascending" : "descending");
      return;
    }
    setSortBy(col);
    setSortDir(col === "rank" ? "ascending" : "descending");
  };

  const viewerPage = s.leaderboardViewerRank?.page ?? null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur-md">
        <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
          Trade Markets
        </Button>
      </div>

      <div className="p-4">
        <LeaderboardPanel
          rows={sortedRows}
          audience={s.leaderboardFilter}
          onAudienceChange={(audience) => {
            void storeActions.loadLeaderboardFiltered(audience, s.leaderboardTimeframe, 1);
          }}
          timeframe={s.leaderboardTimeframe}
          onTimeframeChange={(timeframe) => {
            void storeActions.loadLeaderboardFiltered(s.leaderboardFilter, timeframe, 1);
          }}
          page={s.leaderboardPage}
          totalPages={s.leaderboardTotalPages}
          onPageChange={(nextPage) => {
            void storeActions.loadLeaderboardFiltered(s.leaderboardFilter, s.leaderboardTimeframe, nextPage);
          }}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
          viewerAccountId={s.viewer?.accountId}
          viewerPosition={s.leaderboardViewerRank?.entry ?? null}
          onJumpToMyPosition={
            viewerPage !== null
              ? () => {
                  void storeActions.loadLeaderboardFiltered(s.leaderboardFilter, s.leaderboardTimeframe, viewerPage);
                }
              : undefined
          }
          onFollow={(accountId) => {
            const found =
              s.leaderboard.find((r) => r.accountId === accountId) ??
              (s.leaderboardViewerRank?.entry?.accountId === accountId ? s.leaderboardViewerRank.entry : undefined);
            if (found) void storeActions.toggleFollow(found.handle, found.isFollowing);
          }}
          onViewProfile={(handle) => {
            void storeActions.navigate(`/u/${encodeURIComponent(handle)}`);
          }}
          loading={s.leaderboardLoading && s.leaderboard.length === 0}
        />
      </div>
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
  const cashCents = econ?.balanceCents ?? s.viewer?.balanceCents ?? 0;
  const positionCents = econ?.positionValueCents ?? 0;
  const equityCents = econ?.equityCents ?? cashCents + positionCents;
  const startingGrantCents = econ?.startingGrantCents ?? s.viewer?.startingGrantCents ?? 10000;
  const netProfitCents = econ?.netProfitCents ?? equityCents - startingGrantCents;
  const feesPaidCents = econ?.totalFeesPaidCents ?? 0;
  const roiPct = startingGrantCents > 0 ? (netProfitCents / startingGrantCents) * 100 : 0;

  const openAppPositions = useMemo(() => s.positions.filter((p) => !p.isClosed), [s.positions]);
  const walletOpenPositions = useMemo(() => openAppPositions.map(toWalletOpenPosition), [openAppPositions]);
  const walletLedgerEntries = useMemo<ReadonlyArray<WalletLedgerEntry>>(
    () =>
      s.ledger.map((row) => ({
        id: row.id,
        timestampLabel: row.timestamp,
        eventLabel: formatLedgerKind(row.kind),
        deltaPts: row.deltaCents / 100,
        balanceAfterPts: row.balanceAfterCents / 100,
      })),
    [s.ledger],
  );

  const handleSelectPosition = (id: string, kind: "perp" | "prediction") => {
    const pos = openAppPositions.find((p) => p.row.id === id);
    if (!pos) return;
    const path = kind === "perp"
      ? `/markets/perps/${encodeURIComponent(pos.marketId)}`
      : `/markets/predictions/${encodeURIComponent(pos.marketId)}`;
    void storeActions.navigate(path);
  };

  const handleRequestClose = (id: string) => {
    const pos = openAppPositions.find((p) => p.row.id === id);
    if (!pos) return;
    setPendingClose({ pos, details: buildCloseConfirmation(pos) });
  };

  const handleConfirmClose = () => {
    if (!pendingClose) return;
    const target = pendingClose.pos;
    setPendingClose(null);
    if (target.row.kind === "perp") {
      void storeActions.closePerpPosition(target.row.id);
    } else {
      void storeActions.submitPredictionOrder(
        target.marketId,
        "Sell",
        target.rawSide === "no" ? "no" : "yes",
        target.shares,
      );
    }
  };

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
              Sign in &amp; claim 100 pts
            </Button>
          </EmptyState>
        </div>
      ) : (
        <div className="p-4">
          <WalletPanel
            summary={{
              equityPts: equityCents / 100,
              cashPts: cashCents / 100,
              openPositionsValuePts: positionCents / 100,
              netProfitPts: netProfitCents / 100,
              roiPct,
              feesPaidPts: feesPaidCents / 100,
            }}
            pnlHistory={s.pnlHistory}
            pnlTimeRange={s.pnlTimeRange}
            onPnlTimeRangeChange={(range) => {
              void storeActions.loadPnlHistory(range);
            }}
            openPositions={walletOpenPositions}
            closedPositions={s.closedPositions}
            ledgerEntries={walletLedgerEntries}
            onClosePosition={handleRequestClose}
            onSelectPosition={handleSelectPosition}
            closedPageSize={10}
            loading={s.economyLoading && !s.economy && s.ledger.length === 0}
            error={s.tradeError ?? undefined}
            submitting={s.tradeLoading}
          />
        </div>
      )}

      <TradeConfirmationDialog
        open={pendingClose !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingClose(null);
        }}
        details={pendingClose?.details ?? null}
        submitting={s.tradeLoading}
        onConfirm={handleConfirmClose}
      />
    </div>
  );
}
