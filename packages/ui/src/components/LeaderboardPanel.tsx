import { type ComponentProps, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, Crosshair, ExternalLink } from "lucide-react";
import { Alert } from "./Alert.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardHeader } from "./Card.tsx";
import {
  type LeaderboardEntry,
  type LeaderboardSortColumn,
  LeaderboardTable,
} from "./LeaderboardTable.tsx";
import { RankBadge, RankNumber } from "./RankBadge.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";
import { cn, focusRing } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";

export type LeaderboardAudienceFilter = "all" | "traders" | "npcs";
export type LeaderboardTimeframe = "24H" | "7D" | "30D" | "ALL";

export const LEADERBOARD_TIMEFRAMES: readonly LeaderboardTimeframe[] = ["24H", "7D", "30D", "ALL"];

export type LeaderboardPanelProps = Omit<ComponentProps<"div">, "children"> & {
  /** Ranked rows for the current page and filters. */
  rows: readonly LeaderboardEntry[];
  /** Active audience tab (`all`, `traders`, or `npcs`). */
  audience: LeaderboardAudienceFilter;
  /** Called when the user switches the audience tab. */
  onAudienceChange: (audience: LeaderboardAudienceFilter) => void;
  /** Active ranking timeframe (`24H`, `7D`, `30D`, or `ALL`). */
  timeframe: LeaderboardTimeframe;
  /** Called when the user selects a timeframe pill. */
  onTimeframeChange: (timeframe: LeaderboardTimeframe) => void;
  /** Current 1-indexed page number. */
  page: number;
  /** Total number of pages available. */
  totalPages: number;
  /** Called when the user navigates to another page. */
  onPageChange: (page: number) => void;
  /** Currently sorted column passed through to `LeaderboardTable`. */
  sortBy?: LeaderboardSortColumn;
  /** Current sort direction. */
  sortDir?: "ascending" | "descending";
  /** Invoked when a sortable column header is clicked. */
  onSort?: (column: LeaderboardSortColumn) => void;
  /** Account ID of the signed-in viewer. */
  viewerAccountId?: string;
  /** Signed-in viewer's standing entry for the sticky bottom bar and Jump-to-My-Position button. */
  viewerPosition?: LeaderboardEntry | null;
  /** Invoked when clicking the `#rank` Jump-to-My-Position button. */
  onJumpToMyPosition?: () => void;
  /** Invoked when clicking Follow/Following on a trader. */
  onFollow?: (accountId: string) => void;
  /** Invoked when clicking View Profile in the detail inspector. */
  onViewProfile?: (handle: string, accountId: string) => void;
  /** Displays skeleton placeholders while loading. */
  loading?: boolean;
  /** Optional error banner message. */
  error?: string;
  /** Disables table and filter interactions. */
  disabled?: boolean;
};

function TraderDetailInspector({
  trader,
  isViewer,
  onFollow,
  onViewProfile,
  disabled,
}: {
  trader: LeaderboardEntry | null;
  isViewer: boolean;
  onFollow?: (accountId: string) => void;
  onViewProfile?: (handle: string, accountId: string) => void;
  disabled: boolean;
}) {
  if (!trader) {
    return (
      <Card className="p-5">
        <p className="py-8 text-center text-sm text-muted-foreground">Select a trader from the table to inspect performance.</p>
      </Card>
    );
  }

  const positive = trader.netProfitPts >= 0;
  const roiPositive = (trader.roiPct ?? 0) >= 0;

  return (
    <Card className="gap-4 p-5">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={trader.displayName} src={trader.avatarUrl} seed={trader.handle} size="lg" />
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-base leading-none font-semibold">{trader.displayName}</h2>
                {trader.isNpc ? (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <VerifiedBadge size="sm" />
                    <Bot aria-hidden className="size-3.5 text-muted-foreground" />
                  </span>
                ) : null}
              </div>
              <span className="truncate font-mono text-xs text-muted-foreground">@{trader.handle}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <RankNumber rank={trader.rank} size="sm" />
            {trader.rank <= 3 ? <RankBadge rank={trader.rank} size="sm" showLabel={false} /> : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isViewer && onFollow ? (
            <Button
              variant={trader.isFollowing ? "outline" : "primary"}
              size="sm"
              shape="pill"
              disabled={disabled}
              onClick={() => onFollow(trader.accountId)}
              className="flex-1"
            >
              {trader.isFollowing ? "Following" : "Follow"}
            </Button>
          ) : null}
          {onViewProfile ? (
            <Button
              variant="outline"
              size="sm"
              shape="pill"
              disabled={disabled}
              onClick={() => onViewProfile(trader.handle, trader.accountId)}
              className="flex-1"
            >
              View Profile
              <ExternalLink aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="gap-3">
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">Net Profit</dt>
            <dd className={cn("mt-1 font-mono text-sm font-bold tabular-nums", positive ? "text-ok" : "text-destructive")}>
              {formatPts(trader.netProfitPts, true)}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">ROI</dt>
            <dd
              className={cn(
                "mt-1 font-mono text-sm font-bold tabular-nums",
                trader.roiPct === undefined ? "text-muted-foreground" : roiPositive ? "text-ok" : "text-destructive",
              )}
            >
              {trader.roiPct !== undefined ? `${trader.roiPct >= 0 ? "+" : ""}${trader.roiPct.toFixed(1)}%` : "—"}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">Equity</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">
              {trader.equityPts !== undefined ? formatPts(trader.equityPts) : "—"}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">Win Rate</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">{trader.winRatePct}%</dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">Trades</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">
              {trader.tradeCount !== undefined ? trader.tradeCount : "—"}
            </dd>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <dt className="text-xs text-muted-foreground">Volume</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground tabular-nums">
              {formatPts(trader.volumePts)}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Full leaderboard layout with sticky audience/timeframe header, Jump-to-My-Position, sticky viewer footer, pagination, and trader inspector. */
export function LeaderboardPanel({
  rows,
  audience,
  onAudienceChange,
  timeframe,
  onTimeframeChange,
  page,
  totalPages,
  onPageChange,
  sortBy,
  sortDir = "descending",
  onSort,
  viewerAccountId,
  viewerPosition,
  onJumpToMyPosition,
  onFollow,
  onViewProfile,
  loading = false,
  error,
  disabled = false,
  onClick,
  className,
  ...props
}: LeaderboardPanelProps) {
  const blocked = disabled || loading;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeTrader =
    (selectedId ? rows.find((row) => row.accountId === selectedId) : null) ??
    rows[0] ??
    viewerPosition ??
    null;

  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(1, page), safeTotalPages);

  const tableContent = error ? (
    <div className="p-4">
      <Alert variant="destructive">{error}</Alert>
    </div>
  ) : loading ? (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 8 }, (_, idx) => (
        <Skeleton key={idx} className="h-12 w-full" />
      ))}
    </div>
  ) : (
    <LeaderboardTable
      rows={[...rows]}
      sortBy={sortBy}
      sortDir={sortDir}
      onSort={onSort}
      viewerAccountId={viewerAccountId}
      onSelectTrader={(accountId) => setSelectedId(accountId)}
      onFollow={onFollow}
      disabled={blocked}
      className="rounded-none border-0"
    />
  );

  return (
    <div
      aria-busy={loading || undefined}
      aria-disabled={blocked || undefined}
      onClick={blocked ? undefined : onClick}
      className={cn("flex flex-col gap-6 xl:flex-row xl:items-start", className)}
      {...props}
    >
      <Tabs
        value={audience}
        onValueChange={(next) => {
          if (!blocked && (next === "all" || next === "traders" || next === "npcs")) onAudienceChange(next);
        }}
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background"
      >
        <div className="sticky top-0 z-10 flex flex-col border-b border-border bg-background/95 backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-2">
            <h1 className="text-lg font-bold text-foreground">Leaderboard</h1>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Leaderboard timeframe" className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
                {LEADERBOARD_TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    disabled={blocked}
                    aria-pressed={timeframe === tf}
                    onClick={() => !blocked && onTimeframeChange(tf)}
                    className={cn(
                      focusRing,
                      "rounded-sm px-2.5 py-1 font-mono text-xs font-medium transition-colors duration-fast",
                      timeframe === tf ? "bg-feed-brand text-feed-brand-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      blocked && "pointer-events-none opacity-50",
                    )}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              {viewerPosition && onJumpToMyPosition ? (
                <Button variant="outline" size="sm" shape="pill" disabled={blocked} onClick={onJumpToMyPosition}>
                  <Crosshair aria-hidden className="size-3.5" />
                  <span className="font-mono tabular-nums">#{viewerPosition.rank}</span>
                </Button>
              ) : null}
            </div>
          </div>

          <div className="px-4">
            <TabsList variant="underline" className="border-b-0">
              <TabsTrigger value="all" disabled={blocked} className="flex-none">All</TabsTrigger>
              <TabsTrigger value="traders" disabled={blocked} className="flex-none">Traders</TabsTrigger>
              <TabsTrigger value="npcs" disabled={blocked} className="flex-none">NPCs</TabsTrigger>
            </TabsList>
          </div>
        </div>

        {(["all", "traders", "npcs"] as const).map((tabKey) => (
          <TabsContent key={tabKey} value={tabKey} className="mt-0 min-w-0 flex-1">
            {audience === tabKey ? tableContent : null}
          </TabsContent>
        ))}

        {viewerPosition ? (
          <div
            aria-label="Your position"
            className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-3 backdrop-blur-sm"
          >
            <div className="flex items-center gap-2.5">
              <Badge variant="info">Your position</Badge>
              <RankNumber rank={viewerPosition.rank} size="sm" />
              <span className="font-semibold text-foreground">{viewerPosition.displayName}</span>
              <span className="font-mono text-xs text-muted-foreground">@{viewerPosition.handle}</span>
            </div>
            <div className="flex items-center gap-4 font-mono text-sm tabular-nums">
              <span className={cn("font-bold", viewerPosition.netProfitPts >= 0 ? "text-ok" : "text-destructive")}>
                {formatPts(viewerPosition.netProfitPts, true)}
              </span>
              {viewerPosition.roiPct !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  {viewerPosition.roiPct >= 0 ? "+" : ""}
                  {viewerPosition.roiPct.toFixed(1)}% ROI
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {safeTotalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={blocked || safePage <= 1}
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
            >
              <ChevronLeft aria-hidden className="size-4" />
              Prev
            </Button>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              Page {safePage} of {safeTotalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={blocked || safePage >= safeTotalPages}
              onClick={() => onPageChange(Math.min(safeTotalPages, safePage + 1))}
            >
              Next
              <ChevronRight aria-hidden className="size-4" />
            </Button>
          </div>
        ) : null}
      </Tabs>

      <aside aria-label="Selected trader inspector" className="w-full shrink-0 xl:sticky xl:top-4 xl:w-96">
        <TraderDetailInspector
          trader={activeTrader}
          isViewer={Boolean(viewerAccountId && activeTrader?.accountId === viewerAccountId)}
          onFollow={onFollow}
          onViewProfile={onViewProfile}
          disabled={blocked}
        />
      </aside>
    </div>
  );
}
