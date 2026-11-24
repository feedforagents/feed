import { type ComponentProps, type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ExternalLink,
  HelpCircle,
  Info,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Alert } from "./Alert.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./Card.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./Dialog.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { type MarketTimeRange } from "./LightweightChartBase.tsx";
import { PerpPriceChart, type PerpPricePoint } from "./PerpPriceChart.tsx";
import { PredictionProbabilityChart, type PredictionProbabilityPoint } from "./PredictionProbabilityChart.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./Sheet.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { SpotlightTutorial } from "./SpotlightTutorial.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.tsx";
import { type TradeConfirmationDetails, TradeConfirmationDialog } from "./TradeConfirmationDialog.tsx";

export interface TerminalPerpMarket {
  /** Market ticker symbol such as `SAMALT`. */
  ticker: string;
  /** Organization or contract name. */
  name: string;
  /** Optional organization avatar URL. */
  avatarUrl?: string;
  /** Current mark price in `pts`. */
  currentPrice: number;
  /** Optional NPC spot index price in `pts`. */
  indexPrice?: number;
  /** 24h percentage change. */
  changePercent24h: number;
  /** 24h volume in `pts`. */
  volume24h?: number;
  /** Open interest in `pts`. */
  openInterest?: number;
  /** Funding rate percentage. */
  fundingRatePct?: number;
  /** Maximum leverage allowed (defaults to 20). */
  maxLeverage?: number;
  /** Canonical fee in basis points (defaults to 10). */
  feeBps?: number;
  /** Historical mark prices for the chart. */
  priceHistory: readonly PerpPricePoint[];
}

export interface TerminalPredictionMarket {
  /** Prediction market identifier. */
  id: string;
  /** Market question headline. */
  question: string;
  /** Optional category label. */
  category?: string;
  /** Current YES implied probability (`0..100`). */
  yesOddsPct: number;
  /** CPMM YES share reserve (credited cents/shares). */
  yesShares: number;
  /** CPMM NO share reserve (credited cents/shares). */
  noShares: number;
  /** Total pool liquidity in `pts`. */
  liquidityPts?: number;
  /** Human-readable countdown or resolution time label. */
  endsAtLabel?: string;
  /** Canonical fee in basis points (defaults to 10). */
  feeBps?: number;
  /** Maximum allowed single-trade odds move in basis points (defaults to 2000). */
  maxOddsMoveBps?: number;
  /** Resolution rule summary shown in the info modal. */
  resolutionCriteria?: string;
  /** Optional article ID backing resolution evidence. */
  resolutionArticleId?: string;
  /** Historical YES/NO probability curve points. */
  probabilityHistory: readonly PredictionProbabilityPoint[];
}

export interface ExistingPerpPosition {
  /** Position identifier. */
  id: string;
  /** Contract ticker symbol. */
  ticker: string;
  /** Position side (`long` or `short`). */
  side: "long" | "short";
  /** Current notional size in `pts`. */
  notionalPts: number;
  /** Collateral margin posted in `pts`. */
  marginPts: number;
  /** Leverage multiplier (`1..20`). */
  leverage: number;
  /** Weighted average entry price. */
  entryPrice: number;
  /** Current mark price. */
  markPrice: number;
  /** Estimated liquidation price. */
  liquidationPrice: number;
  /** Live unrealized PnL in `pts`. */
  unrealizedPnlPts: number;
  /** Live unrealized PnL percentage relative to margin. */
  unrealizedPnlPct: number;
}

export interface ExistingPredictionHolding {
  /** Position identifier. */
  id: string;
  /** Prediction market identifier. */
  marketId: string;
  /** Market question label for sidebar display. */
  question: string;
  /** Outcome side (`YES` or `NO`). */
  side: "YES" | "NO";
  /** Owned share count. */
  shares: number;
  /** Average entry price percentage (`0..100`). */
  avgPricePct: number;
  /** Current mark price percentage (`0..100`). */
  currentPricePct: number;
  /** Unrealized PnL in `pts`. */
  unrealizedPnlPts: number;
}

export interface AssetTradeEntry {
  /** Unique trade identifier. */
  id: string;
  /** Trader display name. */
  displayName: string;
  /** Trader handle without `@`. */
  handle: string;
  /** Optional avatar URL. */
  avatarUrl?: string;
  /** Marks NPC accounts. */
  isNpc?: boolean;
  /** Action label such as `LONG`, `SHORT`, `BUY YES`, `SELL NO`, or `CLOSE`. */
  actionLabel: string;
  /** Visual polarity of the trade (`ok` or `destructive`). */
  tone: "ok" | "destructive";
  /** Trade size in `pts`. */
  amountPts: number;
  /** Optional execution price or odds string. */
  priceLabel: string;
  /** Optional leverage multiplier for perp trades. */
  leverage?: number;
  /** Optional share count for prediction trades. */
  shares?: number;
  /** Relative timestamp label such as `2m ago`. */
  timeAgoLabel: string;
}

export interface PerpOpenOrderInput {
  ticker: string;
  side: "long" | "short";
  marginPts: number;
  notionalPts: number;
  leverage: number;
}

export interface PerpRebalanceOrderInput {
  action: "add" | "reduce" | "flip";
  positionId: string;
  ticker: string;
  currentSide: "long" | "short";
  nextSide: "long" | "short";
  marginPts: number;
  deltaNotionalPts: number;
  resultingNotionalPts: number;
  leverage: number;
}

export interface PredictionOrderInput {
  marketId: string;
  action: "buy" | "sell";
  side: "YES" | "NO";
  amountOrShares: number;
}

export interface AssetTradesFeedProps {
  /** Recent trades for the active market. */
  trades: readonly AssetTradeEntry[];
  /** Displays skeleton rows while loading. */
  loading?: boolean;
  /** Optional empty message. */
  emptyMessage?: string;
  /** Additional class names for the list wrapper. */
  className?: string;
}

export interface PerpOrderPanelProps {
  /** Active perpetual contract metadata. */
  market: TerminalPerpMarket;
  /** Trader's spendable cash balance in `pts`. */
  balancePts: number;
  /** Existing open position on this ticker, if any. */
  existingPosition?: ExistingPerpPosition | null;
  /** Opens a new perp position. */
  onOpenPerp: (order: PerpOpenOrderInput) => void;
  /** Rebalances an existing perp position (`add`, `reduce`, or `flip`). */
  onRebalancePerp?: (order: PerpRebalanceOrderInput) => void;
  /** Closes an existing perp position by ID. */
  onClosePerp?: (positionId: string) => void;
  /** Opens confirmation dialog before executing when true (default true). */
  confirmBeforeSubmit?: boolean;
  /** Disables submission while a trade is in flight. */
  submitting?: boolean;
  /** Optional external submission error message. */
  error?: string;
}

export interface PredictionOrderPanelProps {
  /** Active prediction market metadata. */
  market: TerminalPredictionMarket;
  /** Trader's spendable cash balance in `pts`. */
  balancePts: number;
  /** Owned YES shares on this market (used for Sell + Max button). */
  yesPositionShares?: number;
  /** Owned NO shares on this market (used for Sell + Max button). */
  noPositionShares?: number;
  /** Submits a buy or sell prediction order. */
  onSubmitOrder: (order: PredictionOrderInput) => void;
  /** Invoked when clicking the resolution article link in the info modal. */
  onOpenResolutionArticle?: (articleId: string) => void;
  /** Opens confirmation dialog before executing when true (default true). */
  confirmBeforeSubmit?: boolean;
  /** Disables submission while a trade is in flight. */
  submitting?: boolean;
  /** Optional external submission error message. */
  error?: string;
}

export type MarketsTradingTerminalProps = Omit<ComponentProps<"div">, "children"> & {
  /** Selected market (either perpetual or prediction). */
  market:
    | { kind: "perp"; data: TerminalPerpMarket }
    | { kind: "prediction"; data: TerminalPredictionMarket };
  /** Trader's available spendable cash in `pts`. */
  balancePts: number;
  /** Active chart time range. */
  timeRange: MarketTimeRange;
  /** Invoked when the user switches chart timeframes. */
  onTimeRangeChange: (range: MarketTimeRange) => void;
  /** Returns to the markets dashboard list. */
  onBack?: () => void;
  /** Recent trades for the active market's `Trades` tab. */
  trades?: readonly AssetTradeEntry[];
  /** Loading state for the trade tape. */
  tradesLoading?: boolean;
  /** Loading state for the main chart. */
  chartLoading?: boolean;
  /** Social discussion feed slot rendered under the `Social` tab. */
  socialFeed?: ReactNode;
  /** Open perpetual positions (used for active ticker rebalance & Positions sidebar). */
  perpPositions?: readonly ExistingPerpPosition[];
  /** Open prediction holdings (used for Sell Max & Positions sidebar). */
  predictionPositions?: readonly ExistingPredictionHolding[];
  /** Submits a fresh perp open order. */
  onOpenPerp?: (order: PerpOpenOrderInput) => void;
  /** Submits a perp rebalance (`add`, `reduce`, or `flip`) order. */
  onRebalancePerp?: (order: PerpRebalanceOrderInput) => void;
  /** Closes an open perp position by ID. */
  onClosePerp?: (positionId: string) => void;
  /** Submits a prediction buy or sell order. */
  onSubmitPrediction?: (order: PredictionOrderInput) => void;
  /** Invoked when the user clicks a resolution article link. */
  onOpenResolutionArticle?: (articleId: string) => void;
  /** Disables order submission while an execution is pending. */
  submitting?: boolean;
  /** Optional order panel error message. */
  orderError?: string;
  /** Shows the optional `xl:w-96` sticky Positions sidebar on wide screens (default true). */
  showPositionsSidebar?: boolean;
  /** Opens confirmation dialog before trade execution (default true). */
  confirmBeforeSubmit?: boolean;
};

const MIN_PERP_NOTIONAL_PTS = 10;
const LEVERAGE_CHIPS = [1, 2, 5, 10, 20] as const;
const PERCENT_PRESETS = [
  { label: "25%", ratio: 0.25 },
  { label: "50%", ratio: 0.5 },
  { label: "75%", ratio: 0.75 },
  { label: "MAX", ratio: 1 },
] as const;

function formatPricePts(value: number): string {
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} pts`;
}

function calcFeePts(notionalPts: number, feeBps: number): number {
  if (notionalPts <= 0 || feeBps <= 0) return 0;
  return Math.max(0.01, (notionalPts * feeBps) / 10_000);
}

function calcLiquidationPrice(entryPrice: number, side: "long" | "short", leverage: number): number {
  if (entryPrice <= 0 || leverage <= 0) return 0;
  const maintenanceBuffer = 0.9 / leverage;
  return side === "long" ? Math.max(0, entryPrice * (1 - maintenanceBuffer)) : entryPrice * (1 + maintenanceBuffer);
}

function calcLiquidationDistancePct(markPrice: number, liquidationPrice: number, side: "long" | "short"): number {
  if (markPrice <= 0) return 100;
  const diff = side === "long" ? markPrice - liquidationPrice : liquidationPrice - markPrice;
  return Math.max(0, (diff / markPrice) * 100);
}

function estimateCpmmBuy(
  yesShares: number,
  noShares: number,
  side: "YES" | "NO",
  amountPts: number,
  feeBps: number,
): { shares: number; avgPricePct: number; priceImpactPct: number; feePts: number; payoutPts: number; roiPct: number } {
  const feePts = calcFeePts(amountPts, feeBps);
  const netPts = Math.max(0, amountPts - feePts);
  const total = yesShares + noShares;
  if (yesShares <= 0 || noShares <= 0 || netPts <= 0 || total <= 0) {
    return { shares: 0, avgPricePct: 50, priceImpactPct: 0, feePts, payoutPts: 0, roiPct: 0 };
  }
  const initialYesPct = (noShares / total) * 100;
  const initialSidePct = side === "YES" ? initialYesPct : 100 - initialYesPct;
  const k = yesShares * noShares;
  const nextYes = side === "YES" ? k / (noShares + netPts) : yesShares + netPts;
  const nextNo = side === "YES" ? noShares + netPts : k / (yesShares + netPts);
  const shares = (side === "YES" ? yesShares - nextYes : noShares - nextNo) + netPts;
  const nextTotal = nextYes + nextNo;
  const postYesPct = nextTotal > 0 ? (nextNo / nextTotal) * 100 : initialYesPct;
  const postSidePct = side === "YES" ? postYesPct : 100 - postYesPct;
  const avgPricePct = shares > 0 ? (netPts / shares) * 100 : initialSidePct;
  const priceImpactPct = Math.abs(postSidePct - initialSidePct);
  const payoutPts = shares;
  const roiPct = amountPts > 0 ? ((payoutPts - amountPts) / amountPts) * 100 : 0;
  return { shares, avgPricePct, priceImpactPct, feePts, payoutPts, roiPct };
}

/** Live trade tape list for a perpetual or prediction market. */
export function AssetTradesFeed({
  trades,
  loading = false,
  emptyMessage = "No recent trades on this market yet.",
  className,
}: AssetTradesFeedProps) {
  if (loading) {
    return (
      <div className={cn("flex flex-col gap-2.5 p-4", className)}>
        {Array.from({ length: 5 }, (_, idx) => (
          <Skeleton key={idx} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (trades.length === 0) {
    return <p className={cn("py-10 text-center text-sm text-muted-foreground", className)}>{emptyMessage}</p>;
  }

  return (
    <ul aria-label="Recent market trades" className={cn("divide-y divide-border", className)}>
      {trades.map((trade) => (
        <li key={trade.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={trade.displayName} src={trade.avatarUrl} seed={trade.handle} size="sm" />
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-foreground">{trade.displayName}</span>
                {trade.isNpc ? <Bot aria-label="NPC trader" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                <Badge variant={trade.tone} className="font-mono">{trade.actionLabel}</Badge>
                {trade.leverage ? <Badge variant="outline" className="font-mono">{trade.leverage}x</Badge> : null}
              </div>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                @{trade.handle} · {trade.priceLabel}
                {trade.shares !== undefined ? ` · ${trade.shares.toFixed(1)} sh` : ""}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end font-mono tabular-nums">
            <span className="font-semibold text-foreground">{formatPts(trade.amountPts)}</span>
            <span className="text-xs text-muted-foreground">{trade.timeAgoLabel}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PendingTradeDialog({
  details,
  submitting,
  onClear,
  onExecute,
}: {
  details: TradeConfirmationDetails | null;
  submitting: boolean;
  onClear: () => void;
  onExecute: () => void;
}) {
  return (
    <TradeConfirmationDialog
      open={details !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClear();
      }}
      details={details}
      submitting={submitting}
      onConfirm={() => {
        onClear();
        onExecute();
      }}
    />
  );
}

function ExistingPositionSummaryCard({ position }: { position: ExistingPerpPosition }) {
  const liqDistPct = calcLiquidationDistancePct(position.markPrice, position.liquidationPrice, position.side);
  const nearLiquidation = liqDistPct < 5;
  const pnlPos = position.unrealizedPnlPts >= 0;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Badge variant={position.side === "long" ? "ok" : "destructive"} className="font-mono uppercase">
            {position.side}
          </Badge>
          <Badge variant="outline" className="font-mono">{position.leverage}x</Badge>
          <span className="font-mono text-xs font-semibold text-foreground">${position.ticker}</span>
        </div>
        <span className={cn("font-mono text-xs font-bold tabular-nums", pnlPos ? "text-ok" : "text-destructive")}>
          {formatPts(position.unrealizedPnlPts, true)} ({pnlPos ? "+" : ""}
          {position.unrealizedPnlPct.toFixed(1)}%)
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-xs tabular-nums">
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Size</dt>
          <dd className="font-semibold text-foreground">{formatPts(position.notionalPts)}</dd>
        </div>
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Entry</dt>
          <dd className="text-foreground">{formatPricePts(position.entryPrice)}</dd>
        </div>
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Mark</dt>
          <dd className="text-foreground">{formatPricePts(position.markPrice)}</dd>
        </div>
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Est. Liq</dt>
          <dd className={cn(nearLiquidation ? "font-bold text-warn" : "text-foreground")}>
            {formatPricePts(position.liquidationPrice)}
          </dd>
        </div>
      </dl>

      {nearLiquidation ? (
        <Alert variant="warn" className="py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            <span>Near liquidation ({liqDistPct.toFixed(1)}% away). Reduce or close now.</span>
          </div>
        </Alert>
      ) : null}
    </div>
  );
}

function RebalancePerpForm({
  market,
  balancePts,
  existingPosition,
  onRebalancePerp,
  onClosePerp,
  confirmBeforeSubmit,
  submitting,
  error,
}: {
  market: TerminalPerpMarket;
  balancePts: number;
  existingPosition: ExistingPerpPosition;
  onRebalancePerp?: (order: PerpRebalanceOrderInput) => void;
  onClosePerp?: (positionId: string) => void;
  confirmBeforeSubmit: boolean;
  submitting: boolean;
  error?: string;
}) {
  const amountId = useId();
  const maxLev = Math.min(20, Math.max(1, market.maxLeverage ?? 20));
  const feeBps = market.feeBps ?? 10;

  const [mode, setMode] = useState<"add" | "reduce" | "close" | "flip">("add");
  const [inputValue, setInputValue] = useState("10");
  const [flipLeverage, setFlipLeverage] = useState(Math.min(maxLev, existingPosition.leverage));
  const [pendingConfirm, setPendingConfirm] = useState<TradeConfirmationDetails | null>(null);

  const numericInput = Number(inputValue);
  const validInput = mode === "close" || (Number.isFinite(numericInput) && numericInput > 0);
  const oppositeSide: "long" | "short" = existingPosition.side === "long" ? "short" : "long";

  const activeLeverage = mode === "flip" ? flipLeverage : existingPosition.leverage;
  const deltaNotionalPts =
    mode === "close"
      ? existingPosition.notionalPts
      : mode === "reduce"
        ? Math.min(existingPosition.notionalPts, Math.max(0, numericInput))
        : Math.max(0, numericInput) * activeLeverage;

  const resultingNotionalPts =
    mode === "add"
      ? existingPosition.notionalPts + deltaNotionalPts
      : mode === "reduce"
        ? Math.max(0, existingPosition.notionalPts - deltaNotionalPts)
        : mode === "flip"
          ? deltaNotionalPts
          : 0;

  const estimatedFeePts =
    mode === "flip"
      ? calcFeePts(existingPosition.notionalPts, feeBps) + calcFeePts(deltaNotionalPts, feeBps)
      : calcFeePts(deltaNotionalPts, feeBps);

  const marginNeeded = mode === "add" || mode === "flip" ? Math.max(0, numericInput) : 0;
  const totalRequiredPts = mode === "reduce" || mode === "close" ? estimatedFeePts : marginNeeded + estimatedFeePts;
  const insufficientBalance = (mode === "add" || mode === "flip") && totalRequiredPts > balancePts;
  const belowMinNotional = (mode === "add" || mode === "flip") && deltaNotionalPts > 0 && deltaNotionalPts < MIN_PERP_NOTIONAL_PTS;
  const reduceExceedsSize = mode === "reduce" && numericInput >= existingPosition.notionalPts;

  const nextSide = mode === "flip" ? oppositeSide : existingPosition.side;
  const nextLiqPrice =
    mode === "close" ? undefined : calcLiquidationPrice(market.currentPrice, nextSide, activeLeverage);
  const nextLiqDist =
    nextLiqPrice !== undefined ? calcLiquidationDistancePct(market.currentPrice, nextLiqPrice, nextSide) : undefined;

  const applyPreset = (ratio: number) => {
    if (mode === "reduce") {
      setInputValue((existingPosition.notionalPts * ratio).toFixed(2));
      return;
    }
    const maxMargin = Math.max(0, balancePts / (1 + (activeLeverage * feeBps) / 10_000));
    setInputValue((maxMargin * ratio).toFixed(2));
  };

  const execute = () => {
    if (mode === "close" || reduceExceedsSize) {
      onClosePerp?.(existingPosition.id);
      return;
    }
    onRebalancePerp?.({
      action: mode,
      positionId: existingPosition.id,
      ticker: market.ticker,
      currentSide: existingPosition.side,
      nextSide,
      marginPts: marginNeeded,
      deltaNotionalPts,
      resultingNotionalPts,
      leverage: activeLeverage,
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !validInput || insufficientBalance || belowMinNotional) return;
    if (!confirmBeforeSubmit) {
      execute();
      return;
    }
    if (mode === "close" || reduceExceedsSize) {
      setPendingConfirm({
        kind: "close-perp",
        ticker: market.ticker,
        side: existingPosition.side,
        notionalPts: existingPosition.notionalPts,
        leverage: existingPosition.leverage,
        entryPrice: existingPosition.entryPrice,
        markPrice: market.currentPrice,
        estimatedFeePts: calcFeePts(existingPosition.notionalPts, feeBps),
        unrealizedPnlPts: existingPosition.unrealizedPnlPts,
        unrealizedPnlPct: existingPosition.unrealizedPnlPct,
      });
      return;
    }
    setPendingConfirm({
      kind: "rebalance-perp",
      action: mode,
      ticker: market.ticker,
      currentSide: existingPosition.side,
      nextSide,
      currentNotionalPts: existingPosition.notionalPts,
      deltaNotionalPts,
      resultingNotionalPts,
      leverage: activeLeverage,
      entryPrice: market.currentPrice,
      estimatedFeePts,
      totalRequiredPts,
      liquidationPrice: nextLiqPrice,
      liquidationDistancePct: nextLiqDist,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <ExistingPositionSummaryCard position={existingPosition} />

      <SegmentedControl
        aria-label="Position rebalance action"
        value={mode}
        disabled={submitting}
        onValueChange={(next) => {
          if (next === "add" || next === "reduce" || next === "close" || next === "flip") setMode(next);
        }}
        options={[
          { value: "add", label: "Add" },
          { value: "reduce", label: "Reduce" },
          { value: "close", label: "Close" },
          { value: "flip", label: "Flip" },
        ]}
      />

      {mode !== "close" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={amountId}>{mode === "reduce" ? "Reduce Notional (pts)" : "Margin (pts)"}</Label>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {formatPts(balancePts)}</span>
          </div>
          <Input
            id={amountId}
            type="number"
            min="0.01"
            step="any"
            value={inputValue}
            disabled={submitting}
            invalid={!validInput && inputValue !== ""}
            onChange={(event) => setInputValue(event.target.value)}
            className="font-mono tabular-nums"
          />
          <div className="grid grid-cols-4 gap-1.5">
            {PERCENT_PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => applyPreset(preset.ratio)}
                className="font-mono text-xs tabular-nums"
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {mode === "flip" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label>Flip Leverage ({oppositeSide.toUpperCase()})</Label>
            <Badge variant="outline" className="font-mono tabular-nums">{flipLeverage}x</Badge>
          </div>
          <input
            type="range"
            aria-label="Flip leverage"
            min={1}
            max={maxLev}
            step={1}
            value={flipLeverage}
            disabled={submitting}
            onChange={(event) => setFlipLeverage(Number(event.target.value))}
            className="w-full accent-primary disabled:opacity-50"
          />
        </div>
      ) : null}

      <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs tabular-nums">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Resulting Position</dt>
          <dd className="font-semibold text-foreground">
            {mode === "close" || reduceExceedsSize ? "Closed (0 pts)" : `${nextSide.toUpperCase()} ${formatPts(resultingNotionalPts)}`}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Est. Fee ({feeBps} bps)</dt>
          <dd className="text-foreground">{formatPts(estimatedFeePts)}</dd>
        </div>
        {mode === "add" || mode === "flip" ? (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Additional Required</dt>
            <dd className="font-semibold text-foreground">{formatPts(totalRequiredPts)}</dd>
          </div>
        ) : null}
      </dl>

      {belowMinNotional ? <Alert variant="warn">Minimum order notional is {formatPts(MIN_PERP_NOTIONAL_PTS)}.</Alert> : null}
      {insufficientBalance ? <Alert variant="destructive">Insufficient spendable balance ({formatPts(balancePts)}).</Alert> : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Button
        type="submit"
        shape="pill"
        variant={mode === "close" || (mode === "flip" && oppositeSide === "short") ? "destructive" : "primary"}
        loading={submitting}
        disabled={submitting || !validInput || insufficientBalance || belowMinNotional}
        className="w-full"
      >
        <RefreshCw aria-hidden className="size-4" />
        {mode === "close" || reduceExceedsSize
          ? `Close ${existingPosition.side.toUpperCase()} $${market.ticker}`
          : mode === "add"
            ? `Add to ${existingPosition.side.toUpperCase()}`
            : mode === "reduce"
              ? `Reduce ${existingPosition.side.toUpperCase()}`
              : `Flip to ${oppositeSide.toUpperCase()} ${flipLeverage}x`}
      </Button>

      <PendingTradeDialog
        details={pendingConfirm}
        submitting={submitting}
        onClear={() => setPendingConfirm(null)}
        onExecute={execute}
      />
    </form>
  );
}

/** Perpetual order ticket supporting fresh Long/Short entries and intuitive Add/Reduce/Close/Flip rebalancing. */
export function PerpOrderPanel({
  market,
  balancePts,
  existingPosition,
  onOpenPerp,
  onRebalancePerp,
  onClosePerp,
  confirmBeforeSubmit = true,
  submitting = false,
  error,
}: PerpOrderPanelProps) {
  const marginId = useId();
  const leverageId = useId();
  const maxLev = Math.min(20, Math.max(1, market.maxLeverage ?? 20));
  const feeBps = market.feeBps ?? 10;

  const [side, setSide] = useState<"long" | "short">("long");
  const [marginText, setMarginText] = useState("10");
  const [leverage, setLeverage] = useState(Math.min(maxLev, 5));
  const [pendingConfirm, setPendingConfirm] = useState<TradeConfirmationDetails | null>(null);

  if (existingPosition) {
    return (
      <Card className="gap-4 p-4">
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm">{`Manage $${market.ticker}`}</CardTitle>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {formatPts(balancePts)}</span>
        </CardHeader>
        <CardContent>
          <RebalancePerpForm
            market={market}
            balancePts={balancePts}
            existingPosition={existingPosition}
            onRebalancePerp={onRebalancePerp}
            onClosePerp={onClosePerp}
            confirmBeforeSubmit={confirmBeforeSubmit}
            submitting={submitting}
            error={error}
          />
        </CardContent>
      </Card>
    );
  }

  const marginPts = Number(marginText);
  const validMargin = Number.isFinite(marginPts) && marginPts > 0;
  const notionalPts = validMargin ? marginPts * leverage : 0;
  const estimatedFeePts = calcFeePts(notionalPts, feeBps);
  const totalRequiredPts = validMargin ? marginPts + estimatedFeePts : 0;
  const openInterestBase = Math.max(market.openInterest ?? 50_000, 1_000);
  const markImpactPct = validMargin ? Math.min(15, (notionalPts / openInterestBase) * 5) : 0;
  const estEntryPrice =
    side === "long" ? market.currentPrice * (1 + markImpactPct / 100) : market.currentPrice * (1 - markImpactPct / 100);
  const liqPrice = calcLiquidationPrice(estEntryPrice, side, leverage);
  const liqDistPct = calcLiquidationDistancePct(estEntryPrice, liqPrice, side);
  const belowMinNotional = validMargin && notionalPts < MIN_PERP_NOTIONAL_PTS;
  const insufficientBalance = validMargin && totalRequiredPts > balancePts;

  const applyMarginPreset = (ratio: number) => {
    const maxMargin = Math.max(0, balancePts / (1 + (leverage * feeBps) / 10_000));
    setMarginText((maxMargin * ratio).toFixed(2));
  };

  const executeOpen = () => {
    onOpenPerp({ ticker: market.ticker, side, marginPts, notionalPts, leverage });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !validMargin || belowMinNotional || insufficientBalance) return;
    if (!confirmBeforeSubmit) {
      executeOpen();
      return;
    }
    setPendingConfirm({
      kind: "open-perp",
      ticker: market.ticker,
      side,
      marginPts,
      notionalPts,
      leverage,
      entryPrice: estEntryPrice,
      estimatedFeePts,
      totalRequiredPts,
      liquidationPrice: liqPrice,
      liquidationDistancePct: liqDistPct,
    });
  };

  return (
    <Card className="gap-4 p-4">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">{`Trade $${market.ticker}`}</CardTitle>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {formatPts(balancePts)}</span>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <SegmentedControl
            aria-label="Perp direction"
            value={side}
            disabled={submitting}
            onValueChange={(next) => setSide(next === "short" ? "short" : "long")}
            options={[
              { value: "long", label: "Long" },
              { value: "short", label: "Short" },
            ]}
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor={marginId}>Margin (pts)</Label>
            <Input
              id={marginId}
              type="number"
              min="0.01"
              step="any"
              value={marginText}
              disabled={submitting}
              invalid={!validMargin && marginText !== ""}
              onChange={(event) => setMarginText(event.target.value)}
              className="font-mono tabular-nums"
            />
            <div className="grid grid-cols-4 gap-1.5">
              {PERCENT_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => applyMarginPreset(preset.ratio)}
                  className="font-mono text-xs tabular-nums"
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={leverageId}>Leverage</Label>
              <Badge variant={leverage >= 10 ? "warn" : "outline"} className="font-mono tabular-nums">
                {leverage}x
              </Badge>
            </div>
            <input
              id={leverageId}
              type="range"
              min={1}
              max={maxLev}
              step={1}
              value={leverage}
              disabled={submitting}
              onChange={(event) => setLeverage(Number(event.target.value))}
              className="w-full accent-primary disabled:opacity-50"
            />
            <div className="grid grid-cols-5 gap-1">
              {LEVERAGE_CHIPS.filter((chip) => chip <= maxLev).map((chip) => (
                <Button
                  key={chip}
                  type="button"
                  variant={leverage === chip ? "primary" : "outline"}
                  size="sm"
                  disabled={submitting}
                  onClick={() => setLeverage(chip)}
                  className="px-2 font-mono text-xs tabular-nums"
                >
                  {chip}x
                </Button>
              ))}
            </div>
          </div>

          <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs tabular-nums">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Notional Size</dt>
              <dd className="font-semibold text-foreground">{validMargin ? formatPts(notionalPts) : "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Est. Entry</dt>
              <dd className="text-foreground">{formatPricePts(estEntryPrice)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Mark Impact</dt>
              <dd className={cn(markImpactPct >= 2 ? "text-warn" : "text-foreground")}>{markImpactPct.toFixed(2)}%</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Est. Liquidation</dt>
              <dd className={cn(liqDistPct < 10 ? "font-semibold text-warn" : "text-foreground")}>
                {formatPricePts(liqPrice)} ({liqDistPct.toFixed(1)}%)
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
              <dd className="text-foreground">{validMargin ? formatPts(estimatedFeePts) : "—"}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <dt className="text-muted-foreground">Total Required</dt>
              <dd className="font-bold text-foreground">{validMargin ? formatPts(totalRequiredPts) : "—"}</dd>
            </div>
          </dl>

          {belowMinNotional ? <Alert variant="warn">Minimum notional size is {formatPts(MIN_PERP_NOTIONAL_PTS)}.</Alert> : null}
          {insufficientBalance ? <Alert variant="destructive">Insufficient balance ({formatPts(balancePts)} available).</Alert> : null}
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <Button
            type="submit"
            shape="pill"
            variant={side === "short" ? "destructive" : "primary"}
            loading={submitting}
            disabled={submitting || !validMargin || belowMinNotional || insufficientBalance}
            className="w-full"
          >
            Open {side === "long" ? "Long" : "Short"} {leverage}x
          </Button>
        </form>
      </CardContent>

      <PendingTradeDialog
        details={pendingConfirm}
        submitting={submitting}
        onClear={() => setPendingConfirm(null)}
        onExecute={executeOpen}
      />
    </Card>
  );
}

/** CPMM YES/NO prediction market order ticket with payout preview, impact guard, and resolution info modal. */
export function PredictionOrderPanel({
  market,
  balancePts,
  yesPositionShares = 0,
  noPositionShares = 0,
  onSubmitOrder,
  onOpenResolutionArticle,
  confirmBeforeSubmit = true,
  submitting = false,
  error,
}: PredictionOrderPanelProps) {
  const inputId = useId();
  const feeBps = market.feeBps ?? 10;
  const maxOddsMovePct = (market.maxOddsMoveBps ?? 2000) / 100;

  const [action, setAction] = useState<"buy" | "sell">("buy");
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [amountText, setAmountText] = useState("10");
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<TradeConfirmationDetails | null>(null);

  const numericValue = Number(amountText);
  const validInput = Number.isFinite(numericValue) && numericValue > 0;
  const ownedShares = side === "YES" ? yesPositionShares : noPositionShares;
  const sideOddsPct = side === "YES" ? market.yesOddsPct : 100 - market.yesOddsPct;

  const buyQuote = useMemo(
    () => estimateCpmmBuy(market.yesShares, market.noShares, side, validInput ? numericValue : 0, feeBps),
    [market.yesShares, market.noShares, side, validInput, numericValue, feeBps],
  );

  const sellGrossPts = validInput ? (numericValue * sideOddsPct) / 100 : 0;
  const sellFeePts = calcFeePts(sellGrossPts, feeBps);
  const sellNetPts = Math.max(0, sellGrossPts - sellFeePts);

  const insufficientBalance = action === "buy" && validInput && numericValue > balancePts;
  const insufficientShares = action === "sell" && validInput && numericValue > ownedShares;
  const exceedsOddsMove = action === "buy" && buyQuote.priceImpactPct >= maxOddsMovePct;

  const executeOrder = () => {
    onSubmitOrder({ marketId: market.id, action, side, amountOrShares: numericValue });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !validInput || insufficientBalance || insufficientShares) return;
    if (!confirmBeforeSubmit) {
      executeOrder();
      return;
    }
    if (action === "buy") {
      setPendingConfirm({
        kind: "buy-prediction",
        question: market.question,
        side,
        amountPts: numericValue,
        estimatedShares: buyQuote.shares,
        avgPricePct: buyQuote.avgPricePct,
        priceImpactPct: buyQuote.priceImpactPct,
        estimatedFeePts: buyQuote.feePts,
        estimatedPayoutPts: buyQuote.payoutPts,
        estimatedRoiPct: buyQuote.roiPct,
      });
    } else {
      setPendingConfirm({
        kind: "sell-prediction",
        question: market.question,
        side,
        shares: numericValue,
        avgPricePct: sideOddsPct,
        grossProceedsPts: sellGrossPts,
        estimatedFeePts: sellFeePts,
        netProceedsPts: sellNetPts,
      });
    }
  };

  return (
    <Card className="gap-4 p-4">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">Trade Prediction</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => setResolutionOpen(true)} className="h-7 gap-1 px-2 text-xs">
          <Info aria-hidden className="size-3.5" />
          Rules
        </Button>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <SegmentedControl
            aria-label="Prediction action"
            value={action}
            disabled={submitting}
            onValueChange={(next) => setAction(next === "sell" ? "sell" : "buy")}
            options={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
          />

          <SegmentedControl
            aria-label="Outcome side"
            value={side}
            disabled={submitting}
            onValueChange={(next) => setSide(next === "NO" ? "NO" : "YES")}
            options={[
              { value: "YES", label: `YES ${market.yesOddsPct.toFixed(0)}%` },
              { value: "NO", label: `NO ${(100 - market.yesOddsPct).toFixed(0)}%` },
            ]}
          />

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={inputId}>{action === "buy" ? "Amount (pts)" : "Shares to Sell"}</Label>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {action === "buy" ? `Avail ${formatPts(balancePts)}` : `Held ${ownedShares.toFixed(2)} sh`}
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                id={inputId}
                type="number"
                min="0.01"
                step="any"
                value={amountText}
                disabled={submitting}
                invalid={!validInput && amountText !== ""}
                onChange={(event) => setAmountText(event.target.value)}
                className="font-mono tabular-nums"
              />
              {action === "sell" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting || ownedShares <= 0}
                  onClick={() => setAmountText(ownedShares.toFixed(2))}
                >
                  Max
                </Button>
              ) : null}
            </div>

            {action === "buy" ? (
              <div className="grid grid-cols-4 gap-1.5">
                {PERCENT_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    onClick={() => setAmountText((balancePts * preset.ratio).toFixed(2))}
                    className="font-mono text-xs tabular-nums"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs tabular-nums">
            {action === "buy" ? (
              <>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Est. Shares</dt>
                  <dd className="font-semibold text-foreground">{validInput ? buyQuote.shares.toFixed(2) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Avg Price</dt>
                  <dd className="text-foreground">{buyQuote.avgPricePct.toFixed(1)}%</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Price Impact</dt>
                  <dd className={cn(exceedsOddsMove ? "font-semibold text-warn" : "text-foreground")}>
                    {buyQuote.priceImpactPct.toFixed(2)}%
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
                  <dd className="text-foreground">{validInput ? formatPts(buyQuote.feePts) : "—"}</dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1.5">
                  <dt className="text-muted-foreground">Est. Payout / ROI</dt>
                  <dd className="font-bold text-ok">
                    {validInput ? `${formatPts(buyQuote.payoutPts)} (+${buyQuote.roiPct.toFixed(1)}%)` : "—"}
                  </dd>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Gross Proceeds</dt>
                  <dd className="text-foreground">{validInput ? formatPts(sellGrossPts) : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
                  <dd className="text-foreground">{validInput ? formatPts(sellFeePts) : "—"}</dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1.5">
                  <dt className="text-muted-foreground">Net Proceeds</dt>
                  <dd className="font-bold text-ok">{validInput ? formatPts(sellNetPts) : "—"}</dd>
                </div>
              </>
            )}
          </dl>

          {exceedsOddsMove ? (
            <Alert variant="warn">
              Price impact ({buyQuote.priceImpactPct.toFixed(2)}%) exceeds the {maxOddsMovePct.toFixed(1)}% max single-trade odds move guard.
            </Alert>
          ) : null}
          {insufficientBalance ? <Alert variant="destructive">Insufficient balance ({formatPts(balancePts)} available).</Alert> : null}
          {insufficientShares ? <Alert variant="destructive">Cannot sell more than your {ownedShares.toFixed(2)} {side} shares.</Alert> : null}
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <Button
            type="submit"
            shape="pill"
            variant={action === "buy" && side === "NO" ? "destructive" : "primary"}
            loading={submitting}
            disabled={submitting || !validInput || insufficientBalance || insufficientShares}
            className="w-full"
          >
            {action === "buy" ? `Buy ${side}` : `Sell ${side}`}
          </Button>
        </form>
      </CardContent>

      <Dialog open={resolutionOpen} onOpenChange={setResolutionOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Resolution Rules</DialogTitle>
          <DialogDescription>{market.question}</DialogDescription>
          <p className="text-sm leading-relaxed text-card-foreground">
            {market.resolutionCriteria ?? "Resolves YES or NO at market close based on the verified in-world news oracle and settlement event."}
          </p>
          {market.resolutionArticleId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenResolutionArticle?.(market.resolutionArticleId ?? "")}
              className="self-start"
            >
              <ExternalLink aria-hidden className="size-3.5" />
              View Resolution Article
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>

      <PendingTradeDialog
        details={pendingConfirm}
        submitting={submitting}
        onClear={() => setPendingConfirm(null)}
        onExecute={executeOrder}
      />
    </Card>
  );
}

function PositionsSidebarList({
  perpPositions,
  predictionPositions,
  onClosePerp,
  submitting,
}: {
  perpPositions: readonly ExistingPerpPosition[];
  predictionPositions: readonly ExistingPredictionHolding[];
  onClosePerp?: (id: string) => void;
  submitting: boolean;
}) {
  if (perpPositions.length === 0 && predictionPositions.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No open positions.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {perpPositions.map((pos) => {
        const liqDist = calcLiquidationDistancePct(pos.markPrice, pos.liquidationPrice, pos.side);
        const nearLiq = liqDist < 5;
        const posPnl = pos.unrealizedPnlPts >= 0;
        return (
          <div key={pos.id} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Badge variant={pos.side === "long" ? "ok" : "destructive"} className="font-mono uppercase">{pos.side}</Badge>
                <Badge variant="outline" className="font-mono">{pos.leverage}x</Badge>
                <span className="font-mono text-sm font-bold text-foreground">${pos.ticker}</span>
              </div>
              <span className={cn("font-mono text-xs font-bold tabular-nums", posPnl ? "text-ok" : "text-destructive")}>
                {formatPts(pos.unrealizedPnlPts, true)} ({posPnl ? "+" : ""}{pos.unrealizedPnlPct.toFixed(1)}%)
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2 font-mono text-xs text-muted-foreground tabular-nums">
              <span>Size {formatPts(pos.notionalPts)}</span>
              <span>Liq {formatPricePts(pos.liquidationPrice)}</span>
            </div>
            {nearLiq ? (
              <Badge variant="warn" className="self-start">Near Liq ({liqDist.toFixed(1)}%)</Badge>
            ) : null}
            {onClosePerp ? (
              <Button variant="outline" size="sm" disabled={submitting} onClick={() => onClosePerp(pos.id)} className="w-full">
                Close Position
              </Button>
            ) : null}
          </div>
        );
      })}

      {predictionPositions.map((pos) => {
        const posPnl = pos.unrealizedPnlPts >= 0;
        return (
          <div key={pos.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <Badge variant={pos.side === "YES" ? "ok" : "destructive"}>{pos.side}</Badge>
              <span className={cn("font-mono text-xs font-bold tabular-nums", posPnl ? "text-ok" : "text-destructive")}>
                {formatPts(pos.unrealizedPnlPts, true)}
              </span>
            </div>
            <p className="line-clamp-2 text-xs font-medium text-foreground">{pos.question}</p>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {pos.shares.toFixed(1)} sh · Avg {pos.avgPricePct.toFixed(0)}% → {pos.currentPricePct.toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TerminalHeader({
  market,
  fullscreen,
  onBack,
  onOpenTutorial,
  onToggleFullscreen,
}: {
  market: MarketsTradingTerminalProps["market"];
  fullscreen: boolean;
  onBack?: () => void;
  onOpenTutorial: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 px-2">
            <ArrowLeft aria-hidden className="size-4" />
            Markets
          </Button>
        ) : null}

        {market.kind === "perp" ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={market.data.name} src={market.data.avatarUrl} seed={market.data.ticker} size="sm" />
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-2">
                <h1 className="font-mono text-base font-bold text-foreground">${market.data.ticker}</h1>
                <Badge variant={market.data.changePercent24h >= 0 ? "ok" : "destructive"} className="font-mono tabular-nums">
                  {market.data.changePercent24h >= 0 ? "+" : ""}
                  {market.data.changePercent24h.toFixed(2)}%
                </Badge>
              </div>
              <span className="truncate text-xs text-muted-foreground">{market.data.name}</span>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-sm font-bold text-foreground sm:text-base">{market.data.question}</h1>
              {market.data.category ? <Badge variant="secondary">{market.data.category}</Badge> : null}
            </div>
            {market.data.endsAtLabel ? (
              <span className="font-mono text-xs text-muted-foreground">Ends {market.data.endsAtLabel}</span>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open trading tutorial"
          onClick={onOpenTutorial}
          className={cn(focusRing)}
        >
          <HelpCircle aria-hidden className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          aria-pressed={fullscreen}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
        </Button>
      </div>
    </header>
  );
}

/** Full split-pane trading terminal with interactive charts, rebalancing perp & CPMM prediction tickets, trade tape, and mobile trade sheet. */
export function MarketsTradingTerminal({
  market,
  balancePts,
  timeRange,
  onTimeRangeChange,
  onBack,
  trades = [],
  tradesLoading = false,
  chartLoading = false,
  socialFeed,
  perpPositions = [],
  predictionPositions = [],
  onOpenPerp,
  onRebalancePerp,
  onClosePerp,
  onSubmitPrediction,
  onOpenResolutionArticle,
  submitting = false,
  orderError,
  showPositionsSidebar = true,
  confirmBeforeSubmit = true,
  className,
  ...props
}: MarketsTradingTerminalProps) {
  const [desktopTab, setDesktopTab] = useState<"chart" | "social" | "trades">("chart");
  const [mobileTab, setMobileTab] = useState<"chart" | "social" | "positions" | "trades">("chart");
  const [fullscreen, setFullscreen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const activePerpPosition =
    market.kind === "perp"
      ? perpPositions.find((pos) => pos.ticker.toLowerCase() === market.data.ticker.toLowerCase()) ?? null
      : null;

  const yesSharesOwned =
    market.kind === "prediction"
      ? predictionPositions.find((p) => p.marketId === market.data.id && p.side === "YES")?.shares ?? 0
      : 0;
  const noSharesOwned =
    market.kind === "prediction"
      ? predictionPositions.find((p) => p.marketId === market.data.id && p.side === "NO")?.shares ?? 0
      : 0;

  const orderPanel =
    market.kind === "perp" ? (
      <PerpOrderPanel
        market={market.data}
        balancePts={balancePts}
        existingPosition={activePerpPosition}
        onOpenPerp={(order) => onOpenPerp?.(order)}
        onRebalancePerp={onRebalancePerp}
        onClosePerp={onClosePerp}
        confirmBeforeSubmit={confirmBeforeSubmit}
        submitting={submitting}
        error={orderError}
      />
    ) : (
      <PredictionOrderPanel
        market={market.data}
        balancePts={balancePts}
        yesPositionShares={yesSharesOwned}
        noPositionShares={noSharesOwned}
        onSubmitOrder={(order) => onSubmitPrediction?.(order)}
        onOpenResolutionArticle={onOpenResolutionArticle}
        confirmBeforeSubmit={confirmBeforeSubmit}
        submitting={submitting}
        error={orderError}
      />
    );

  const chartNode =
    market.kind === "perp" ? (
      <PerpPriceChart
        ticker={market.data.ticker}
        data={market.data.priceHistory}
        currentPrice={market.data.currentPrice}
        timeRange={timeRange}
        onTimeRangeChange={onTimeRangeChange}
        loading={chartLoading}
        height={380}
      />
    ) : (
      <PredictionProbabilityChart
        marketId={market.data.id}
        data={market.data.probabilityHistory}
        timeRange={timeRange}
        onTimeRangeChange={onTimeRangeChange}
        loading={chartLoading}
        height={380}
      />
    );

  const socialNode = socialFeed ?? (
    <p className="py-10 text-center text-sm text-muted-foreground">No market discussion posts yet.</p>
  );

  const totalPositions = perpPositions.length + predictionPositions.length;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-background text-foreground",
        fullscreen ? "fixed inset-0 z-40 overflow-auto" : "rounded-xl border border-border",
        className,
      )}
      {...props}
    >
      <TerminalHeader
        market={market}
        fullscreen={fullscreen}
        onBack={onBack}
        onOpenTutorial={() => setTutorialOpen(true)}
        onToggleFullscreen={() => setFullscreen((prev) => !prev)}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col lg:border-r lg:border-border">
          <Tabs
            value={mobileTab}
            onValueChange={(next) => {
              if (next === "chart" || next === "social" || next === "positions" || next === "trades") setMobileTab(next);
            }}
            className="flex min-h-0 flex-1 flex-col lg:hidden"
          >
            <div className="border-b border-border px-4">
              <TabsList variant="underline" className="border-b-0">
                <TabsTrigger value="chart">Chart</TabsTrigger>
                <TabsTrigger value="social">Social</TabsTrigger>
                <TabsTrigger value="positions">Positions ({totalPositions})</TabsTrigger>
                <TabsTrigger value="trades">Trades</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="chart" className="mt-0 min-h-0 flex-1 overflow-auto p-4 pb-20">
              {chartNode}
            </TabsContent>
            <TabsContent value="social" className="mt-0 min-h-0 flex-1 overflow-auto p-4 pb-20">
              {socialNode}
            </TabsContent>
            <TabsContent value="positions" className="mt-0 min-h-0 flex-1 overflow-auto p-4 pb-20">
              <PositionsSidebarList
                perpPositions={perpPositions}
                predictionPositions={predictionPositions}
                onClosePerp={onClosePerp}
                submitting={submitting}
              />
            </TabsContent>
            <TabsContent value="trades" className="mt-0 min-h-0 flex-1 overflow-auto p-4 pb-20">
              <AssetTradesFeed trades={trades} loading={tradesLoading} />
            </TabsContent>
          </Tabs>

          <Tabs
            value={desktopTab}
            onValueChange={(next) => {
              if (next === "chart" || next === "social" || next === "trades") setDesktopTab(next);
            }}
            className="hidden min-h-0 flex-1 flex-col lg:flex"
          >
            <div className="border-b border-border px-4">
              <TabsList variant="underline" className="border-b-0">
                <TabsTrigger value="chart" className="flex-none">Chart</TabsTrigger>
                <TabsTrigger value="social" className="flex-none">Social</TabsTrigger>
                <TabsTrigger value="trades" className="flex-none">Trades ({trades.length})</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="chart" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
              {chartNode}
            </TabsContent>
            <TabsContent value="social" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
              {socialNode}
            </TabsContent>
            <TabsContent value="trades" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
              <AssetTradesFeed trades={trades} loading={tradesLoading} />
            </TabsContent>
          </Tabs>
        </div>

        <aside aria-label="Order entry" className="hidden w-96 shrink-0 overflow-auto p-4 lg:block">
          {orderPanel}
        </aside>

        {showPositionsSidebar ? (
          <aside aria-label="Open positions" className="hidden w-96 shrink-0 border-l border-border xl:block">
            <div className="sticky top-0 flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Positions</h2>
                <Badge variant="secondary" className="font-mono tabular-nums">{totalPositions}</Badge>
              </div>
              <PositionsSidebarList
                perpPositions={perpPositions}
                predictionPositions={predictionPositions}
                onClosePerp={onClosePerp}
                submitting={submitting}
              />
            </div>
          </aside>
        ) : null}
      </div>

      <div className="sticky bottom-0 z-20 border-t border-border bg-background/95 p-3 backdrop-blur-sm lg:hidden">
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="primary" shape="pill" className="w-full">
              {market.kind === "perp"
                ? activePerpPosition
                  ? `Manage $${market.data.ticker}`
                  : `Trade $${market.data.ticker}`
                : "Trade YES / NO"}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="p-4">
            <SheetTitle className="sr-only">Order Ticket</SheetTitle>
            {orderPanel}
          </SheetContent>
        </Sheet>
      </div>

      <SpotlightTutorial open={tutorialOpen} onOpenChange={setTutorialOpen} />
    </div>
  );
}
