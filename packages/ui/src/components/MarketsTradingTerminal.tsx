import { type ComponentProps, type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
  Info,
  Maximize2,
  Minimize2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { cn, focusRing } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { bigIntSqrt } from "../lib/math.ts";
import { Alert } from "./Alert.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
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
  /** Optional lifecycle status (`active`, `resolved`, `cancelled`, or `expired`). */
  status?: "active" | "resolved" | "cancelled" | "expired";
  /** Settled winning side when `status` is `resolved`. */
  resolvedOutcome?: "yes" | "no" | null;
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
  mode?: "open" | "flip";
}

export interface PerpRebalanceOrderInput {
  action: "add" | "reduce" | "flip";
  mode?: "add" | "reduce" | "flip";
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

export interface PerpServerQuote {
  /** Server-quoted execution fill price in `pts`. */
  fillPricePts: number;
  /** Server-quoted price impact percentage. */
  impactPct: number;
  /** Optional server-quoted liquidation price in `pts`. */
  liquidationPricePts?: number;
  /** Optional server-quoted fee in `pts`. */
  feePts?: number;
  /** Optional server-quoted total required margin and fee in `pts`. */
  totalRequiredPts?: number;
  /** Optional order side this quote applies to. */
  side?: "long" | "short";
  /** Optional margin in `pts` this quote applies to. */
  marginPts?: number;
  /** Optional leverage multiplier this quote applies to. */
  leverage?: number;
}

export interface PerpPreviewOrderInput {
  ticker: string;
  side: "long" | "short";
  marginPts: number;
  leverage: number;
}

export interface PerpOrderPanelProps {
  /** Active perpetual contract metadata. */
  market: TerminalPerpMarket;
  /** Trader's spendable cash balance in `pts`. */
  balancePts: number;
  /** Existing open position on this ticker, if any. */
  existingPosition?: ExistingPerpPosition | null;
  /** Optional live server execution quote feeding Est. Entry and Price Impact directly into the summary. */
  serverQuote?: PerpServerQuote | null;
  /** Requests a refreshed server quote when order parameters change. */
  onPreviewPerpOrder?: (order: PerpPreviewOrderInput) => void;
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
  /** Side the ticket opens on (default `YES`); a new value moves an open ticket to that side. */
  initialSide?: "YES" | "NO";
  /** Bumped on each new side intent; a new value re-applies `initialSide` even when the side itself is unchanged. */
  sideIntentSeq?: number;
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
  /** Optional live server execution quote for perpetual order preview. */
  serverQuote?: PerpServerQuote | null;
  /** Requests a refreshed server quote when perpetual order inputs change. */
  onPreviewPerpOrder?: (order: PerpPreviewOrderInput) => void;
  /** Submits a fresh perp open order. */
  onOpenPerp?: (order: PerpOpenOrderInput) => void;
  /** Submits a perp rebalance (`add`, `reduce`, or `flip`) order. */
  onRebalancePerp?: (order: PerpRebalanceOrderInput) => void;
  /** Closes an open perp position by ID. */
  onClosePerp?: (positionId: string) => void;
  /** Side the prediction ticket opens on (default `YES`); a new value moves an open ticket to that side. */
  initialPredictionSide?: "YES" | "NO";
  /** Bumped on each new prediction side intent; a new value re-applies `initialPredictionSide` even when the side itself is unchanged. */
  predictionSideIntentSeq?: number;
  /** Submits a prediction buy or sell order. */
  onSubmitPrediction?: (order: PredictionOrderInput) => void;
  /** Invoked when the user clicks a resolution article link. */
  onOpenResolutionArticle?: (articleId: string) => void;
  /** Disables order submission while an execution is pending. */
  submitting?: boolean;
  /** Optional order panel error message. */
  orderError?: string;
  /** Shows the optional `2xl:w-80` sticky Positions sidebar on wide screens (default true). */
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

function calcFeePts(notionalPts: number, feeBps: number): number {
  if (notionalPts <= 0 || feeBps <= 0) return 0;
  const notionalCents = Math.round(notionalPts * 100);
  return Math.ceil((notionalCents * feeBps) / 10_000) / 100;
}

function calcMaxMarginPts(availablePts: number, leverage: number, feeBps: number): number {
  const availCents = Math.floor(Math.max(0, availablePts) * 100);
  if (availCents <= 0 || leverage <= 0) return 0;
  let marginCents = Math.floor((availCents * 10_000) / (10_000 + leverage * feeBps));
  while (marginCents > 0) {
    const notionalCents = Math.round(marginCents * leverage);
    const feeCents = feeBps > 0 ? Math.ceil((notionalCents * feeBps) / 10_000) : 0;
    if (marginCents + feeCents <= availCents) break;
    marginCents -= 1;
  }
  return marginCents / 100;
}

function floorCents(value: number): number {
  return Math.floor(Math.max(0, value) * 100) / 100;
}

function PercentPresetRow({
  disabled,
  onSelect,
}: {
  readonly disabled: boolean;
  readonly onSelect: (ratio: number) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {PERCENT_PRESETS.map((preset) => (
        <Button
          key={preset.label}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onSelect(preset.ratio)}
          className="font-mono text-xs tabular-nums"
        >
          {preset.label}
        </Button>
      ))}
    </div>
  );
}

function calcLiquidationPrice(entryPrice: number, side: "long" | "short", leverage: number): number {
  if (entryPrice <= 0 || leverage <= 0) return 0;
  const maintenanceBuffer = Math.max(0, 1 / leverage - 0.025);
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
): {
  shares: number;
  avgPricePct: number;
  priceImpactPct: number;
  postYesPct: number;
  feePts: number;
  payoutPts: number;
  roiPct: number;
} {
  const feePts = calcFeePts(amountPts, feeBps);
  const amountCents = Math.round(Math.max(0, amountPts) * 100);
  const feeCents = Math.round(feePts * 100);
  const netCents = Math.max(0, amountCents - feeCents);
  const yesR = BigInt(Math.max(0, Math.round(yesShares * 100)));
  const noR = BigInt(Math.max(0, Math.round(noShares * 100)));
  const total = yesR + noR;
  if (yesR <= 0n || noR <= 0n || netCents <= 0 || total <= 0n) {
    const fallbackYesPct = total > 0n ? Number((noR * 10_000n) / total) / 100 : 50;
    return { shares: 0, avgPricePct: side === "YES" ? fallbackYesPct : 100 - fallbackYesPct, priceImpactPct: 0, postYesPct: fallbackYesPct, feePts, payoutPts: 0, roiPct: 0 };
  }
  const initialYesPct = Number((noR * 10_000n) / total) / 100;
  const initialSidePct = side === "YES" ? initialYesPct : 100 - initialYesPct;
  const net = BigInt(netCents);
  const denom = side === "YES" ? noR + net : yesR + net;
  const nextSideR = (yesR * noR + denom - 1n) / denom;
  const boughtCentShares = (side === "YES" ? yesR : noR) - nextSideR + net;
  const postYesR = side === "YES" ? nextSideR : yesR + net;
  const postNoR = side === "YES" ? noR + net : nextSideR;
  const postTotal = postYesR + postNoR;
  const postYesPct = postTotal > 0n ? Number((postNoR * 10_000n) / postTotal) / 100 : initialYesPct;
  const postSidePct = side === "YES" ? postYesPct : 100 - postYesPct;
  const shares = boughtCentShares > 0n ? Number(boughtCentShares) / 100 : 0;
  const netPts = netCents / 100;
  const avgPricePct = shares > 0 ? (netPts / shares) * 100 : initialSidePct;
  const priceImpactPct = Math.abs(postSidePct - initialSidePct);
  const payoutPts = shares;
  const roiPct = amountPts > 0 ? ((payoutPts - amountPts) / amountPts) * 100 : 0;
  return { shares, avgPricePct, priceImpactPct, postYesPct, feePts, payoutPts, roiPct };
}

function estimateCpmmSell(
  yesShares: number,
  noShares: number,
  side: "YES" | "NO",
  sellWholeShares: number,
  feeBps: number,
): {
  grossPts: number;
  feePts: number;
  netPts: number;
  avgPricePct: number;
  priceImpactPct: number;
  postYesPct: number;
} {
  const yesR = BigInt(Math.max(0, Math.round(yesShares * 100)));
  const noR = BigInt(Math.max(0, Math.round(noShares * 100)));
  const total = yesR + noR;
  const initialYesPct = total > 0n ? Number((noR * 10_000n) / total) / 100 : 50;
  const initialSidePct = side === "YES" ? initialYesPct : 100 - initialYesPct;
  const sellCentShares = BigInt(Math.max(0, Math.round(sellWholeShares * 100)));
  if (yesR <= 0n || noR <= 0n || sellCentShares <= 0n) {
    return { grossPts: 0, feePts: 0, netPts: 0, avgPricePct: initialSidePct, priceImpactPct: 0, postYesPct: initialYesPct };
  }
  const sideR = side === "YES" ? yesR : noR;
  const oppR = side === "YES" ? noR : yesR;
  const sum = sideR + oppR + sellCentShares;
  const diff = sideR + oppR - sellCentShares;
  const disc = diff * diff + 4n * sideR * sellCentShares;
  const rootFloor = bigIntSqrt(disc);
  const rootCeil = rootFloor * rootFloor >= disc ? rootFloor : rootFloor + 1n;
  const denom = sum + rootCeil;
  const raw = denom > 0n ? (2n * sellCentShares * oppR) / denom : 0n;
  const maxOut = oppR > 1n ? (oppR - 1n < sellCentShares ? oppR - 1n : sellCentShares) : 0n;
  const grossCents = raw < 0n ? 0n : raw > maxOut ? maxOut : raw;
  const postSideR = sideR + sellCentShares - grossCents;
  const postOppR = oppR - grossCents;
  const postYesR = side === "YES" ? postSideR : postOppR;
  const postNoR = side === "YES" ? postOppR : postSideR;
  const postTotal = postYesR + postNoR;
  const postYesPct = postTotal > 0n ? Number((postNoR * 10_000n) / postTotal) / 100 : initialYesPct;
  const postSidePct = side === "YES" ? postYesPct : 100 - postYesPct;
  const grossPts = Number(grossCents) / 100;
  const feePts = calcFeePts(grossPts, feeBps);
  const netPts = Math.max(0, Math.round((grossPts - feePts) * 100) / 100);
  const avgPricePct = sellCentShares > 0n ? (Number(grossCents) / Number(sellCentShares)) * 100 : initialSidePct;
  const priceImpactPct = Math.abs(postSidePct - initialSidePct);
  return { grossPts, feePts, netPts, avgPricePct, priceImpactPct, postYesPct };
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
                {trade.shares !== undefined ? ` · ${trade.shares.toFixed(2)} sh` : ""}
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

function OrderPolarityToggle<T extends string>({
  ariaLabel,
  value,
  onChange,
  disabled,
  positiveOption,
  negativeOption,
}: {
  ariaLabel: string;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  positiveOption: { value: T; label: string };
  negativeOption: { value: T; label: string };
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid w-full grid-cols-2 gap-1 rounded-md border border-border bg-muted p-1"
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === positiveOption.value}
        disabled={disabled}
        onClick={() => onChange(positiveOption.value)}
        className={cn(
          focusRing,
          "h-9 w-full rounded-sm px-3 text-sm transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
          value === positiveOption.value
            ? "bg-ok-solid font-semibold text-ok-solid-foreground shadow-sm"
            : "bg-transparent font-medium text-muted-foreground hover:text-foreground",
        )}
      >
        {positiveOption.label}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === negativeOption.value}
        disabled={disabled}
        onClick={() => onChange(negativeOption.value)}
        className={cn(
          focusRing,
          "h-9 w-full rounded-sm px-3 text-sm transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
          value === negativeOption.value
            ? "bg-danger-solid font-semibold text-danger-solid-foreground shadow-sm"
            : "bg-transparent font-medium text-muted-foreground hover:text-foreground",
        )}
      >
        {negativeOption.label}
      </button>
    </div>
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
          <dd className="text-foreground">{formatPts(position.entryPrice)}</dd>
        </div>
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Mark</dt>
          <dd className="text-foreground">{formatPts(position.markPrice)}</dd>
        </div>
        <div className="flex justify-between gap-1">
          <dt className="text-muted-foreground">Est. Liq</dt>
          <dd className={cn(nearLiquidation ? "font-bold text-warn" : "text-foreground")}>
            {formatPts(position.liquidationPrice)}
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

function RebalanceSummaryList({
  mode,
  reduceExceedsSize,
  nextSide,
  resultingNotionalPts,
  feeBps,
  estimatedFeePts,
  totalRequiredPts,
}: {
  mode: "add" | "reduce" | "close" | "flip";
  reduceExceedsSize: boolean;
  nextSide: "long" | "short";
  resultingNotionalPts: number;
  feeBps: number;
  estimatedFeePts: number;
  totalRequiredPts: number;
}) {
  return (
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

  const closeFeePts = calcFeePts(existingPosition.notionalPts, feeBps);
  const openFeePts = calcFeePts(deltaNotionalPts, feeBps);
  const estimatedFeePts = mode === "flip" ? closeFeePts + openFeePts : openFeePts;

  const netCloseEquityPts = Math.max(0, existingPosition.marginPts + existingPosition.unrealizedPnlPts - closeFeePts);
  const flipAvailablePts = balancePts + netCloseEquityPts;
  const availableForModePts = mode === "flip" ? flipAvailablePts : balancePts;

  const marginNeeded = mode === "add" || mode === "flip" ? Math.max(0, numericInput) : 0;
  const totalRequiredPts =
    mode === "reduce" || mode === "close"
      ? estimatedFeePts
      : mode === "flip"
        ? marginNeeded + openFeePts
        : marginNeeded + estimatedFeePts;
  const insufficientBalance = (mode === "add" || mode === "flip") && totalRequiredPts > availableForModePts + 1e-9;
  const belowMinNotional = (mode === "add" || mode === "flip") && deltaNotionalPts > 0 && deltaNotionalPts < MIN_PERP_NOTIONAL_PTS;
  const reduceExceedsSize = mode === "reduce" && numericInput >= existingPosition.notionalPts;

  const nextSide = mode === "flip" ? oppositeSide : existingPosition.side;
  const nextLiqPrice =
    mode === "close" ? undefined : calcLiquidationPrice(market.currentPrice, nextSide, activeLeverage);
  const nextLiqDist =
    nextLiqPrice !== undefined ? calcLiquidationDistancePct(market.currentPrice, nextLiqPrice, nextSide) : undefined;

  const applyPreset = (ratio: number) => {
    if (mode === "reduce") {
      setInputValue(floorCents(existingPosition.notionalPts * ratio).toFixed(2));
      return;
    }
    const maxMargin = calcMaxMarginPts(availableForModePts, activeLeverage, feeBps);
    setInputValue(floorCents(maxMargin * ratio).toFixed(2));
  };

  const execute = () => {
    if (mode === "close" || reduceExceedsSize) {
      onClosePerp?.(existingPosition.id);
      return;
    }
    onRebalancePerp?.({
      action: mode,
      mode,
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
        className="grid w-full grid-cols-4"
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
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {mode === "flip" ? `Flip Avail ${formatPts(availableForModePts)}` : `Avail ${formatPts(balancePts)}`}
            </span>
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
          <PercentPresetRow disabled={submitting} onSelect={applyPreset} />
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

      <RebalanceSummaryList
        mode={mode}
        reduceExceedsSize={reduceExceedsSize}
        nextSide={nextSide}
        resultingNotionalPts={resultingNotionalPts}
        feeBps={feeBps}
        estimatedFeePts={estimatedFeePts}
        totalRequiredPts={totalRequiredPts}
      />

      {belowMinNotional ? <Alert variant="warn">Minimum order notional is {formatPts(MIN_PERP_NOTIONAL_PTS)}.</Alert> : null}
      {insufficientBalance ? <Alert variant="destructive">Insufficient available balance ({formatPts(availableForModePts)}).</Alert> : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <Button
        type="submit"
        variant={mode === "close" || mode === "reduce" || (mode === "flip" && oppositeSide === "short") ? "destructive" : "primary"}
        loading={submitting}
        disabled={submitting || !validInput || insufficientBalance || belowMinNotional}
        className={cn(
          "h-10 w-full",
          (mode === "add" || (mode === "flip" && oppositeSide === "long")) &&
            "bg-ok-solid text-ok-solid-foreground hover:bg-ok-solid/90",
        )}
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

function PerpOrderSummary({
  validMargin,
  notionalPts,
  liveQuote,
  estEntryPrice,
  impactPct,
  liqPrice,
  liqDistPct,
  feeBps,
  estimatedFeePts,
  totalRequiredPts,
}: {
  validMargin: boolean;
  notionalPts: number;
  liveQuote: boolean;
  estEntryPrice: number;
  impactPct: number;
  liqPrice: number;
  liqDistPct: number;
  feeBps: number;
  estimatedFeePts: number;
  totalRequiredPts: number;
}) {
  return (
    <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-3 font-mono text-xs tabular-nums">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Notional Size</dt>
        <dd className="font-semibold text-foreground">{validMargin ? formatPts(notionalPts) : "—"}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">{liveQuote ? "Est. Entry (Live)" : "Est. Entry"}</dt>
        <dd className="font-semibold text-foreground">{formatPts(estEntryPrice)}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Price Impact</dt>
        <dd className={cn(impactPct >= 2 ? "text-warn" : "text-foreground")}>{impactPct.toFixed(2)}%</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Est. Liquidation</dt>
        <dd className={cn(liqDistPct < 10 ? "font-semibold text-warn" : "text-foreground")}>
          {formatPts(liqPrice)} ({liqDistPct.toFixed(1)}%)
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
  );
}

/** Perpetual order ticket supporting fresh Long/Short entries and intuitive Add/Reduce/Close/Flip rebalancing. */
export function PerpOrderPanel({
  market,
  balancePts,
  existingPosition,
  serverQuote,
  onPreviewPerpOrder,
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
      <div className="flex flex-col gap-4 bg-background text-foreground">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{`Manage $${market.ticker}`}</h3>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {formatPts(balancePts)}</span>
        </div>
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
      </div>
    );
  }

  const marginPts = Number(marginText);
  const validMargin = Number.isFinite(marginPts) && marginPts > 0;
  const notionalPts = validMargin ? marginPts * leverage : 0;
  const activeQuote =
    serverQuote &&
    (serverQuote.side === undefined || serverQuote.side === side) &&
    (serverQuote.leverage === undefined || serverQuote.leverage === leverage) &&
    (serverQuote.marginPts === undefined || (validMargin && Math.abs(serverQuote.marginPts - marginPts) < 0.01))
      ? serverQuote
      : null;
  const estimatedFeePts =
    activeQuote?.feePts !== undefined ? activeQuote.feePts : calcFeePts(notionalPts, feeBps);
  const totalRequiredPts =
    activeQuote?.totalRequiredPts !== undefined
      ? activeQuote.totalRequiredPts
      : validMargin
        ? marginPts + estimatedFeePts
        : 0;
  const openInterestBase = Math.max(market.openInterest ?? 50_000, 1_000);
  const clientImpactPct = validMargin ? Math.min(15, (notionalPts / openInterestBase) * 5) : 0;
  const impactPct = activeQuote ? activeQuote.impactPct : clientImpactPct;
  const clientEstEntryPrice =
    side === "long" ? market.currentPrice * (1 + clientImpactPct / 100) : market.currentPrice * (1 - clientImpactPct / 100);
  const estEntryPrice = activeQuote ? activeQuote.fillPricePts : clientEstEntryPrice;
  const liqPrice =
    activeQuote?.liquidationPricePts !== undefined
      ? activeQuote.liquidationPricePts
      : calcLiquidationPrice(estEntryPrice, side, leverage);
  const liqDistPct = calcLiquidationDistancePct(estEntryPrice, liqPrice, side);
  const belowMinNotional = validMargin && notionalPts < MIN_PERP_NOTIONAL_PTS;
  const insufficientBalance = validMargin && totalRequiredPts > balancePts;

  const requestPreview = (nextSide: "long" | "short", nextMargin: number, nextLeverage: number) => {
    if (!onPreviewPerpOrder || !Number.isFinite(nextMargin) || nextMargin <= 0) return;
    onPreviewPerpOrder({
      ticker: market.ticker,
      side: nextSide,
      marginPts: nextMargin,
      leverage: nextLeverage,
    });
  };

  const handleSideChange = (nextSide: "long" | "short") => {
    setSide(nextSide);
    if (validMargin) requestPreview(nextSide, marginPts, leverage);
  };

  const handleMarginChange = (nextText: string) => {
    setMarginText(nextText);
    const parsed = Number(nextText);
    if (Number.isFinite(parsed) && parsed > 0) requestPreview(side, parsed, leverage);
  };

  const handleLeverageChange = (nextLeverage: number) => {
    setLeverage(nextLeverage);
    if (validMargin) requestPreview(side, marginPts, nextLeverage);
  };

  const applyMarginPreset = (ratio: number) => {
    const maxMargin = calcMaxMarginPts(balancePts, leverage, feeBps);
    const nextVal = floorCents(maxMargin * ratio);
    setMarginText(nextVal.toFixed(2));
    if (nextVal > 0) requestPreview(side, nextVal, leverage);
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
    <div className="flex flex-col gap-4 bg-background text-foreground">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{`Trade $${market.ticker}`}</h3>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {formatPts(balancePts)}</span>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <OrderPolarityToggle
          ariaLabel="Perp direction"
          value={side}
          disabled={submitting}
          onChange={handleSideChange}
          positiveOption={{ value: "long", label: "Long" }}
          negativeOption={{ value: "short", label: "Short" }}
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
            onChange={(event) => handleMarginChange(event.target.value)}
            className="font-mono tabular-nums"
          />
          <PercentPresetRow disabled={submitting} onSelect={applyMarginPreset} />
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
            onChange={(event) => handleLeverageChange(Number(event.target.value))}
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
                onClick={() => handleLeverageChange(chip)}
                className="px-2 font-mono text-xs tabular-nums"
              >
                {chip}x
              </Button>
            ))}
          </div>
        </div>

        <PerpOrderSummary
          validMargin={validMargin}
          notionalPts={notionalPts}
          liveQuote={activeQuote !== null}
          estEntryPrice={estEntryPrice}
          impactPct={impactPct}
          liqPrice={liqPrice}
          liqDistPct={liqDistPct}
          feeBps={feeBps}
          estimatedFeePts={estimatedFeePts}
          totalRequiredPts={totalRequiredPts}
        />

        {belowMinNotional ? <Alert variant="warn">Minimum notional size is {formatPts(MIN_PERP_NOTIONAL_PTS)}.</Alert> : null}
        {insufficientBalance ? <Alert variant="destructive">Insufficient balance ({formatPts(balancePts)} available).</Alert> : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Button
          type="submit"
          variant={side === "short" ? "destructive" : "primary"}
          loading={submitting}
          disabled={submitting || !validMargin || belowMinNotional || insufficientBalance}
          className={cn(
            "h-10 w-full",
            side === "long" && "bg-ok-solid text-ok-solid-foreground hover:bg-ok-solid/90",
          )}
        >
          Open {side === "long" ? "Long" : "Short"} {leverage}x
        </Button>
      </form>

      <PendingTradeDialog
        details={pendingConfirm}
        submitting={submitting}
        onClear={() => setPendingConfirm(null)}
        onExecute={executeOpen}
      />
    </div>
  );
}

function PredictionClosedBanner({
  market,
  onOpenResolutionArticle,
}: {
  market: TerminalPredictionMarket;
  onOpenResolutionArticle?: (articleId: string) => void;
}) {
  const isResolved = market.status === "resolved";
  const isCancelled = market.status === "cancelled";
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-background p-4",
        isResolved && market.resolvedOutcome === "yes" && "border-ok/40 bg-ok/5",
        isResolved && market.resolvedOutcome === "no" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex items-center gap-2">
        {isResolved && market.resolvedOutcome === "yes" ? (
          <CheckCircle2 aria-hidden className="size-5 shrink-0 text-ok" />
        ) : (
          <XCircle aria-hidden className={cn("size-5 shrink-0", isResolved ? "text-destructive" : "text-muted-foreground")} />
        )}
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">
            {isResolved
              ? `Market Resolved: ${market.resolvedOutcome === "yes" ? "YES" : "NO"}`
              : isCancelled
                ? "Market Cancelled"
                : "Trading Closed"}
          </span>
          <span className="text-xs text-muted-foreground">
            {isResolved
              ? "Settlement is complete and trading is disabled."
              : isCancelled
                ? "This market was cancelled and shares were refunded."
                : "This market has closed and is awaiting resolution."}
          </span>
        </div>
      </div>
      {market.resolutionCriteria ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{market.resolutionCriteria}</p>
      ) : null}
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
    </div>
  );
}

function PredictionQuoteSummary({
  action,
  validInput,
  exceedsOddsMove,
  feeBps,
  buyQuote,
  sellQuote,
}: {
  action: "buy" | "sell";
  validInput: boolean;
  exceedsOddsMove: boolean;
  feeBps: number;
  buyQuote: ReturnType<typeof estimateCpmmBuy>;
  sellQuote: ReturnType<typeof estimateCpmmSell>;
}) {
  return (
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
            <dt className="text-muted-foreground">Avg Sell Price</dt>
            <dd className="text-foreground">{validInput ? `${sellQuote.avgPricePct.toFixed(1)}%` : "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Price Impact</dt>
            <dd className={cn(exceedsOddsMove ? "font-semibold text-warn" : "text-foreground")}>
              {validInput ? `${sellQuote.priceImpactPct.toFixed(2)}%` : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Gross Proceeds</dt>
            <dd className="text-foreground">{validInput ? formatPts(sellQuote.grossPts) : "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
            <dd className="text-foreground">{validInput ? formatPts(sellQuote.feePts) : "—"}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-1.5">
            <dt className="text-muted-foreground">Net Proceeds</dt>
            <dd className="font-bold text-ok">{validInput ? formatPts(sellQuote.netPts) : "—"}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

/** CPMM YES/NO prediction market order ticket with payout preview, impact guard, and resolution info modal. */
export function PredictionOrderPanel({
  market,
  balancePts,
  yesPositionShares = 0,
  noPositionShares = 0,
  initialSide = "YES",
  sideIntentSeq = 0,
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
  const [side, setSide] = useState<"YES" | "NO">(initialSide);
  const [prevInitialSide, setPrevInitialSide] = useState(initialSide);
  const [prevSideIntentSeq, setPrevSideIntentSeq] = useState(sideIntentSeq);
  if (initialSide !== prevInitialSide || sideIntentSeq !== prevSideIntentSeq) {
    setPrevInitialSide(initialSide);
    setPrevSideIntentSeq(sideIntentSeq);
    setSide(initialSide);
  }
  const [amountText, setAmountText] = useState("10");
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<TradeConfirmationDetails | null>(null);

  const isResolved = market.status === "resolved";
  const isCancelled = market.status === "cancelled";
  const isExpired = market.status === "expired";
  const isMarketClosed = isResolved || isCancelled || isExpired;

  const numericValue = Number(amountText);
  const validInput = Number.isFinite(numericValue) && numericValue > 0;
  const ownedShares = side === "YES" ? yesPositionShares : noPositionShares;

  const buyQuote = useMemo(
    () => estimateCpmmBuy(market.yesShares, market.noShares, side, validInput ? numericValue : 0, feeBps),
    [market.yesShares, market.noShares, side, validInput, numericValue, feeBps],
  );

  const sellQuote = useMemo(
    () => estimateCpmmSell(market.yesShares, market.noShares, side, validInput ? numericValue : 0, feeBps),
    [market.yesShares, market.noShares, side, validInput, numericValue, feeBps],
  );

  const belowMinimum = validInput && numericValue < 1;
  const insufficientBalance = action === "buy" && validInput && numericValue > balancePts + 1e-9;
  const insufficientShares = action === "sell" && validInput && numericValue > ownedShares + 1e-9;
  const activePriceImpactPct = action === "buy" ? buyQuote.priceImpactPct : sellQuote.priceImpactPct;
  const activePostYesPct = action === "buy" ? buyQuote.postYesPct : sellQuote.postYesPct;
  const exceedsOddsMove = validInput && activePriceImpactPct > maxOddsMovePct;
  const exceedsOddsBounds = validInput && (activePostYesPct < 2 || activePostYesPct > 98);
  const cannotSubmit =
    isMarketClosed ||
    submitting ||
    !validInput ||
    belowMinimum ||
    insufficientBalance ||
    insufficientShares ||
    exceedsOddsMove ||
    exceedsOddsBounds;

  const executeOrder = () => {
    onSubmitOrder({ marketId: market.id, action, side, amountOrShares: numericValue });
  };

  const executeConfirmedOrder = () => {
    if (pendingConfirm?.kind === "buy-prediction" && pendingConfirm.amountPts <= balancePts + 1e-9) {
      onSubmitOrder({ marketId: market.id, action: "buy", side: pendingConfirm.side, amountOrShares: pendingConfirm.amountPts });
    } else if (pendingConfirm?.kind === "sell-prediction" && pendingConfirm.shares <= (pendingConfirm.side === "YES" ? yesPositionShares : noPositionShares) + 1e-9) {
      onSubmitOrder({ marketId: market.id, action: "sell", side: pendingConfirm.side, amountOrShares: pendingConfirm.shares });
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (cannotSubmit) return;
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
        avgPricePct: sellQuote.avgPricePct,
        grossProceedsPts: sellQuote.grossPts,
        estimatedFeePts: sellQuote.feePts,
        netProceedsPts: sellQuote.netPts,
      });
    }
  };

  const isBuyYes = action === "buy" && side === "YES";

  return (
    <div className="flex flex-col gap-4 bg-background text-foreground">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Trade Prediction</h3>
        <Button variant="ghost" size="sm" onClick={() => setResolutionOpen(true)} className="h-7 gap-1 px-2 text-xs">
          <Info aria-hidden className="size-3.5" />
          Rules
        </Button>
      </div>

      {isMarketClosed ? (
        <PredictionClosedBanner market={market} onOpenResolutionArticle={onOpenResolutionArticle} />
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <OrderPolarityToggle
            ariaLabel="Prediction action"
            value={action}
            disabled={submitting}
            onChange={setAction}
            positiveOption={{ value: "buy", label: "Buy" }}
            negativeOption={{ value: "sell", label: "Sell" }}
          />

          <OrderPolarityToggle
            ariaLabel="Outcome side"
            value={side}
            disabled={submitting}
            onChange={setSide}
            positiveOption={{ value: "YES", label: `YES ${market.yesOddsPct.toFixed(0)}%` }}
            negativeOption={{ value: "NO", label: `NO ${(100 - market.yesOddsPct).toFixed(0)}%` }}
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
                min="1"
                step="any"
                value={amountText}
                disabled={submitting}
                invalid={(!validInput || belowMinimum) && amountText !== ""}
                onChange={(event) => setAmountText(event.target.value)}
                className="font-mono tabular-nums"
              />
              {action === "sell" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting || ownedShares <= 0}
                  onClick={() => setAmountText(floorCents(ownedShares).toFixed(2))}
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
                    onClick={() => setAmountText(floorCents(balancePts * preset.ratio).toFixed(2))}
                    className="font-mono text-xs tabular-nums"
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          <PredictionQuoteSummary
            action={action}
            validInput={validInput}
            exceedsOddsMove={exceedsOddsMove}
            feeBps={feeBps}
            buyQuote={buyQuote}
            sellQuote={sellQuote}
          />

          {belowMinimum ? (
            <Alert variant="warn">
              {action === "buy" ? "Minimum buy order is 1.00 pt." : "Minimum sell order is 1.00 share."}
            </Alert>
          ) : null}
          {exceedsOddsMove ? (
            <Alert variant="destructive">
              Price impact ({activePriceImpactPct.toFixed(2)}%) exceeds the {maxOddsMovePct.toFixed(1)}% max single-trade odds move guard.
            </Alert>
          ) : null}
          {exceedsOddsBounds ? (
            <Alert variant="destructive">
              Order would push market odds outside the allowed 2%–98% range.
            </Alert>
          ) : null}
          {insufficientBalance ? <Alert variant="destructive">Insufficient balance ({formatPts(balancePts)} available).</Alert> : null}
          {insufficientShares ? <Alert variant="destructive">Cannot sell more than your {ownedShares.toFixed(2)} {side} shares.</Alert> : null}
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <Button
            type="submit"
            variant={isBuyYes ? "primary" : "destructive"}
            loading={submitting}
            disabled={cannotSubmit}
            className={cn(
              "h-10 w-full",
              isBuyYes && "bg-ok-solid text-ok-solid-foreground hover:bg-ok-solid/90",
            )}
          >
            {action === "buy" ? `Buy ${side}` : `Sell ${side}`}
          </Button>
        </form>
      )}

      <Dialog open={resolutionOpen} onOpenChange={setResolutionOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Resolution Rules</DialogTitle>
          <DialogDescription>{market.question}</DialogDescription>
          <p className="text-sm leading-relaxed text-foreground">
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
        onExecute={executeConfirmedOrder}
      />
    </div>
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
    <div className="flex flex-col divide-y divide-border">
      {perpPositions.map((pos) => {
        const liqDist = calcLiquidationDistancePct(pos.markPrice, pos.liquidationPrice, pos.side);
        const nearLiq = liqDist < 5;
        const posPnl = pos.unrealizedPnlPts >= 0;
        return (
          <div key={pos.id} className="flex flex-col gap-2 bg-background py-3 first:pt-0">
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
              <span>Liq {formatPts(pos.liquidationPrice)}</span>
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
          <div key={pos.id} className="flex flex-col gap-1.5 bg-background py-3 first:pt-0">
            <div className="flex items-center justify-between gap-2">
              <Badge variant={pos.side === "YES" ? "ok" : "destructive"}>{pos.side}</Badge>
              <span className={cn("font-mono text-xs font-bold tabular-nums", posPnl ? "text-ok" : "text-destructive")}>
                {formatPts(pos.unrealizedPnlPts, true)}
              </span>
            </div>
            <p className="line-clamp-2 text-xs font-medium text-foreground">{pos.question}</p>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {pos.shares.toFixed(2)} sh · Avg {pos.avgPricePct.toFixed(0)}% → {pos.currentPricePct.toFixed(0)}%
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
                <Badge variant={market.data.changePercent24h >= 0 ? "ok" : "destructive"} className="font-mono whitespace-nowrap tabular-nums">
                  24h {market.data.changePercent24h >= 0 ? "+" : ""}
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
  serverQuote,
  onPreviewPerpOrder,
  onOpenPerp,
  onRebalancePerp,
  onClosePerp,
  initialPredictionSide,
  predictionSideIntentSeq,
  onSubmitPrediction,
  onOpenResolutionArticle,
  submitting = false,
  orderError,
  showPositionsSidebar = true,
  confirmBeforeSubmit = true,
  className,
  ...props
}: MarketsTradingTerminalProps) {
  const [desktopTab, setDesktopTab] = useState<"chart" | "social" | "trades" | "positions">("chart");
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
        serverQuote={serverQuote}
        onPreviewPerpOrder={onPreviewPerpOrder}
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
        initialSide={initialPredictionSide}
        sideIntentSeq={predictionSideIntentSeq}
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
        "flex min-h-0 flex-1 flex-col bg-background text-foreground",
        fullscreen && "fixed inset-0 z-40 overflow-auto",
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

      <div className="flex min-h-0 flex-1 flex-col pb-32 md:pb-24 lg:flex-row lg:pb-0">
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
              if (next === "chart" || next === "social" || next === "trades" || next === "positions") setDesktopTab(next);
            }}
            className="hidden min-h-0 flex-1 flex-col lg:flex"
          >
            <div className="border-b border-border px-4">
              <TabsList variant="underline" className="border-b-0">
                <TabsTrigger value="chart" className="flex-none">Chart</TabsTrigger>
                <TabsTrigger value="social" className="flex-none">Social</TabsTrigger>
                <TabsTrigger value="trades" className="flex-none">Trades ({trades.length})</TabsTrigger>
                <TabsTrigger value="positions" className={cn("flex-none", showPositionsSidebar && "2xl:hidden")}>
                  Positions ({totalPositions})
                </TabsTrigger>
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
            <TabsContent value="positions" className="mt-0 min-h-0 flex-1 overflow-auto p-4">
              <PositionsSidebarList
                perpPositions={perpPositions}
                predictionPositions={predictionPositions}
                onClosePerp={onClosePerp}
                submitting={submitting}
              />
            </TabsContent>
          </Tabs>
        </div>

        <aside aria-label="Order entry" className="hidden shrink-0 overflow-auto p-4 lg:block lg:w-[340px] xl:w-[360px]">
          {orderPanel}
        </aside>

        {showPositionsSidebar ? (
          <aside aria-label="Open positions" className="hidden shrink-0 border-l border-border 2xl:block 2xl:w-80">
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

      <div
        className={cn(
          "sticky z-20 border-t border-border bg-background/95 p-3 backdrop-blur-sm lg:hidden",
          fullscreen ? "bottom-0" : "bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0",
        )}
      >
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="primary" className="w-full">
              {market.kind === "perp"
                ? activePerpPosition
                  ? `Manage $${market.data.ticker}`
                  : `Trade $${market.data.ticker}`
                : market.data.status === "resolved" || market.data.status === "cancelled" || market.data.status === "expired"
                  ? "View Resolution"
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
