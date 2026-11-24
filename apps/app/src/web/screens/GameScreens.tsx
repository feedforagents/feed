// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { useState } from "react";
import {
  Button,
  EmptyState,
  LeaderboardTable,
  Skeleton,
  WalletPanel,
  type LightweightChartPoint,
  type MarketTimeRange,
  type WalletLedgerEntry,
  type WalletOpenPosition,
  type WalletSummary,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

const RANGE_MS: Record<MarketTimeRange, number | null> = {
  "1H": 3_600_000,
  "4H": 14_400_000,
  "1D": 86_400_000,
  "1W": 604_800_000,
  ALL: null,
};

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

export function LeaderboardScreen() {
  const s = useAppStore();

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-base font-bold text-foreground">Leaderboard</h1>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            Starting capital: 100 pts — trade to climb the leaderboard
          </span>
        </div>
        <Button size="sm" variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
          Trade Markets
        </Button>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {s.leaderboardLoading && s.leaderboard.length === 0 ? (
          <Skeleton className="h-64" />
        ) : (
          <LeaderboardTable
            rows={[...s.leaderboard]}
            scope={s.leaderboardScope}
            onScopeChange={(scope) => {
              void storeActions.loadLeaderboard({ scope, page: 1 });
            }}
            metric={s.leaderboardMetric}
            onMetricChange={(metric) => {
              void storeActions.loadLeaderboard({ metric, page: 1 });
            }}
            currentUserId={s.viewer?.accountId}
            viewerAccountId={s.viewer?.accountId}
            currentUserRow={s.leaderboardCurrentUser}
            onJumpToCurrentUser={() => {
              void storeActions.jumpToMyLeaderboardRank();
            }}
            page={s.leaderboardPage}
            totalPages={s.leaderboardTotalPages}
            totalCount={s.leaderboardTotalCount}
            onPageChange={(page) => {
              void storeActions.loadLeaderboard({ page });
            }}
            onSelectTrader={(accountId) => {
              const found = s.leaderboard.find((r) => r.accountId === accountId)
                ?? (s.leaderboardCurrentUser?.accountId === accountId ? s.leaderboardCurrentUser : undefined);
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
  const [pnlTimeRange, setPnlTimeRange] = useState<MarketTimeRange>("ALL");

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

  const rangeMs = RANGE_MS[pnlTimeRange];
  const latestLedgerMs = s.ledger.reduce((acc, row) => Math.max(acc, row.createdAtMs), 0);
  const cutoffMs = rangeMs !== null && latestLedgerMs > 0 ? latestLedgerMs - rangeMs : null;
  const pnlHistory: LightweightChartPoint[] = [...s.ledger]
    .filter((row) => row.createdAtMs > 0 && (cutoffMs === null || row.createdAtMs >= cutoffMs))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map((row) => ({
      time: row.createdAtMs,
      value: (row.balanceAfterCents - startingGrantCents) / 100,
    }));

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center justify-between gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-base font-bold text-foreground">Wallet</h1>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            Starting capital: 100 pts — trade to climb the leaderboard
          </span>
        </div>
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
            summary={summary}
            pnlHistory={pnlHistory}
            pnlTimeRange={pnlTimeRange}
            onPnlTimeRangeChange={setPnlTimeRange}
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
              void storeActions.navigate(`/markets/predictions/${encodeURIComponent(found.marketId)}`);
            }}
            onClosePosition={(id, kind) => {
              const found = openPositions.find((pos) => pos.row.id === id);
              if (!found) return;
              if (kind === "perp") {
                void storeActions.closePerpPosition(found.row.id);
                return;
              }
              void storeActions.submitPredictionOrder(
                found.marketId,
                "Sell",
                found.rawSide === "no" ? "no" : "yes",
                found.wholeShares,
                found.shares,
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
