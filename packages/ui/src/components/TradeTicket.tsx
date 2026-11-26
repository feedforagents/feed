import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import { formatPts } from "../lib/hosts.ts";
import { Alert } from "./Alert.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";

export interface TradeTicketSellPreview {
  /** Gross CPMM sell proceeds before fee in integer cents. */
  grossProceedsCents: number;
  /** Canonical trading fee in integer cents. */
  feeCents: number;
  /** Net proceeds credited to the trader in integer cents. */
  netProceedsCents: number;
  /** Optional adverse price impact in basis points. */
  priceImpactBps?: number;
}

export interface TradeTicketPerpPreview {
  /** Estimated execution fill price in integer cents (`100` = `1.00 pt`). */
  entryPriceCents: number;
  /** Estimated liquidation price in integer cents. */
  liquidationPriceCents: number;
  /** Estimated opening fee in integer cents. */
  feeCents: number;
  /** Adverse price impact in basis points (`100` = `1.00%`). */
  priceImpactBps: number;
}

export type TradeTicketOrder =
  | {
      marketKind: "prediction";
      action: "Buy" | "Sell";
      side: "YES" | "NO";
      amountPts: number;
      shareUnits?: number;
    }
  | {
      marketKind: "perp";
      side: "Long" | "Short";
      marginPts: number;
      leverage: number;
    };

export type TradeTicketProps = Omit<ComponentProps<"form">, "onSubmit" | "children"> & {
  /** Selects prediction YES/NO ticket or 1x-20x perpetual ticket. */
  marketKind: "prediction" | "perp";
  /** Market question or contract name shown in the ticket header. */
  marketTitle: string;
  /** Available virtual points balance string. */
  balancePts: string;
  /** Current YES implied probability (2..98) for prediction markets. */
  yesOddsPct?: number;
  /** CPMM YES reserve in integer cent-shares (`100` = `1.00` whole share). */
  yesShares?: number;
  /** CPMM NO reserve in integer cent-shares (`100` = `1.00` whole share). */
  noShares?: number;
  /** Viewer's held YES shares in integer cent-shares (`100` = `1.00` whole share). */
  heldYesShares?: number;
  /** Viewer's held NO shares in integer cent-shares (`100` = `1.00` whole share). */
  heldNoShares?: number;
  /** Optional server-computed sell quote overriding local CPMM estimate. */
  sellPreview?: TradeTicketSellPreview;
  /** Optional perp ticker such as `SAMALT`. */
  ticker?: string;
  /** Current perp mark price string. */
  markPricePts?: string;
  /** Current NPC-derived spot index price string. */
  indexPricePts?: string;
  /** Optional server-computed perp fill, liquidation price, fee, and price impact preview. */
  perpPreview?: TradeTicketPerpPreview;
  /** Existing open perp direction on this ticker, adjusting submit button copy for add or rebalance. */
  existingPerpSide?: "Long" | "Short" | null;
  /** Maximum perp leverage allowed (defaults to 20). */
  maxLeverage?: number;
  /** Canonical fee in basis points (defaults to 10 bps). */
  feeBps?: number;
  /** Initial order action for prediction tickets. */
  defaultAction?: "Buy" | "Sell";
  /** Initial side selection. */
  defaultSide?: "YES" | "NO" | "Long" | "Short";
  /** Initial points or whole-shares amount string. */
  defaultAmount?: string;
  /** Initial leverage for perp tickets (clamped to `1..maxLeverage`). */
  defaultLeverage?: number;
  /** Called when perp direction, margin, or leverage changes so the caller can refresh `perpPreview`. */
  onPerpParamsChange?: (params: { side: "Long" | "Short"; marginPts: number; leverage: number }) => void;
  /** Called when prediction action, side, or amount changes so the caller can refresh `sellPreview`. */
  onPredictionParamsChange?: (params: { action: "Buy" | "Sell"; side: "YES" | "NO"; amountPts: number; shareUnits: number }) => void;
  /** Called when a valid order is submitted. */
  onSubmit: (order: TradeTicketOrder) => void;
  /** Disables submission and shows a spinner while executing. */
  loading?: boolean;
  /** Disables all ticket controls. */
  disabled?: boolean;
  /** Optional server or validation error message. */
  error?: string;
};

const leveragePresets = [1, 5, 10, 20];
const CENT_SHARES_PER_SHARE = 100;

function PerpLeverageControl({
  leverageId,
  leverage,
  maxLeverage,
  blocked,
  onChange,
}: {
  readonly leverageId: string;
  readonly leverage: number;
  readonly maxLeverage: number;
  readonly blocked: boolean;
  readonly onChange: (nextLeverage: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={leverageId}>Leverage</Label>
        <Badge variant="outline" className="font-mono tabular-nums">
          {leverage}x
        </Badge>
      </div>
      <input
        id={leverageId}
        type="range"
        min={1}
        max={maxLeverage}
        step={1}
        value={leverage}
        disabled={blocked}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-primary disabled:opacity-50"
      />
      <div className="grid grid-cols-4 gap-1.5">
        {leveragePresets.filter((preset) => preset <= maxLeverage).map((preset) => (
          <Button
            key={preset}
            type="button"
            variant={leverage === preset ? "primary" : "outline"}
            size="sm"
            disabled={blocked}
            onClick={() => onChange(preset)}
            className="font-mono tabular-nums"
          >
            {preset}x
          </Button>
        ))}
      </div>
    </div>
  );
}

function bigIntSqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

function estimatePredictionBuyCentShares(
  yesShares: number,
  noShares: number,
  side: "YES" | "NO",
  amountCents: number,
  feeBps: number,
): number {
  if (yesShares <= 0 || noShares <= 0 || amountCents <= 0) return 0;
  const feeCents = feeBps > 0 ? Math.ceil((amountCents * feeBps) / 10000) : 0;
  const netCents = amountCents - feeCents;
  if (netCents <= 0) return 0;
  const y = BigInt(yesShares);
  const n = BigInt(noShares);
  const net = BigInt(netCents);
  const denom = side === "YES" ? n + net : y + net;
  const nextReserve = (y * n + denom - 1n) / denom;
  const bought = (side === "YES" ? y : n) - nextReserve + net;
  return bought > 0n ? Number(bought) : 0;
}

function estimatePredictionSellGrossCents(
  yesShares: number,
  noShares: number,
  side: "YES" | "NO",
  sellCentShares: number,
): number {
  if (yesShares <= 0 || noShares <= 0 || sellCentShares <= 0) return 0;
  const sideR = BigInt(side === "YES" ? yesShares : noShares);
  const oppR = BigInt(side === "YES" ? noShares : yesShares);
  const s = BigInt(sellCentShares);
  const total = sideR + oppR + s;
  const diff = sideR + oppR - s;
  const disc = diff * diff + 4n * sideR * s;
  const rootFloor = bigIntSqrt(disc);
  const rootCeil = rootFloor * rootFloor >= disc ? rootFloor : rootFloor + 1n;
  const denom = total + rootCeil;
  if (denom <= 0n) return 0;
  const raw = (2n * s * oppR) / denom;
  const maxOut = oppR - 1n < s ? oppR - 1n : s;
  const clamped = raw < 0n ? 0n : raw > maxOut ? maxOut : raw;
  return Number(clamped);
}

function TradeTicketSummary({
  marketKind,
  action,
  validAmount,
  estimatedBuyWholeShares,
  activePricePct,
  sellNetCents,
  notionalPts,
  markPricePts,
  indexPricePts,
  perpPreview,
  feeBps,
  estimatedFeePts,
}: {
  readonly marketKind: "prediction" | "perp";
  readonly action: "Buy" | "Sell";
  readonly validAmount: boolean;
  readonly estimatedBuyWholeShares: number;
  readonly activePricePct: number;
  readonly sellNetCents: number;
  readonly notionalPts: number;
  readonly markPricePts?: string;
  readonly indexPricePts?: string;
  readonly perpPreview?: TradeTicketPerpPreview;
  readonly feeBps: number;
  readonly estimatedFeePts: number;
}) {
  return (
    <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted p-3 text-xs">
      {marketKind === "prediction" ? (
        action === "Buy" ? (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Est. shares</dt>
            <dd className="font-mono font-medium text-foreground tabular-nums">
              {validAmount ? `~${estimatedBuyWholeShares.toFixed(2)} shares` : "—"}
            </dd>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Implied price</dt>
              <dd className="font-mono font-medium text-foreground tabular-nums">{activePricePct}%</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Est. net proceeds</dt>
              <dd className="font-mono font-medium text-foreground tabular-nums">
                {validAmount ? `${(sellNetCents / 100).toFixed(2)} pts` : "—"}
              </dd>
            </div>
          </>
        )
      ) : (
        <>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Notional size</dt>
            <dd className="font-mono font-medium text-foreground tabular-nums">{validAmount ? `${notionalPts.toFixed(2)} pts` : "—"}</dd>
          </div>
          {markPricePts || indexPricePts ? (
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Mark / Index</dt>
              <dd className="font-mono text-foreground tabular-nums">
                {markPricePts ?? "—"} / {indexPricePts ?? "—"}
              </dd>
            </div>
          ) : null}
          {perpPreview ? (
            <>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Est. fill</dt>
                <dd className="font-mono font-medium text-foreground tabular-nums">
                  {formatPts(perpPreview.entryPriceCents / 100)}
                  {perpPreview.priceImpactBps > 0 ? ` (${(perpPreview.priceImpactBps / 100).toFixed(2)}%)` : ""}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Liq. price</dt>
                <dd className="font-mono font-medium text-warn tabular-nums">{formatPts(perpPreview.liquidationPriceCents / 100)}</dd>
              </div>
            </>
          ) : null}
        </>
      )}
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
        <dd className="font-mono text-foreground tabular-nums">{validAmount ? `${estimatedFeePts.toFixed(2)} pts` : "—"}</dd>
      </div>
    </dl>
  );
}

function TradeTicketDirectionControls({
  marketKind,
  action,
  predSide,
  perpSide,
  yesOddsPct,
  blocked,
  onActionChange,
  onPredSideChange,
  onPerpSideChange,
}: {
  readonly marketKind: "prediction" | "perp";
  readonly action: "Buy" | "Sell";
  readonly predSide: "YES" | "NO";
  readonly perpSide: "Long" | "Short";
  readonly yesOddsPct: number;
  readonly blocked: boolean;
  readonly onActionChange: (next: "Buy" | "Sell") => void;
  readonly onPredSideChange: (next: "YES" | "NO") => void;
  readonly onPerpSideChange: (next: "Long" | "Short") => void;
}) {
  if (marketKind === "prediction") {
    return (
      <>
        <SegmentedControl
          aria-label="Order action"
          value={action}
          disabled={blocked}
          onValueChange={(next) => onActionChange(next === "Sell" ? "Sell" : "Buy")}
          options={[
            { value: "Buy", label: "Buy" },
            { value: "Sell", label: "Sell" },
          ]}
        />
        <SegmentedControl
          aria-label="Prediction side"
          value={predSide}
          disabled={blocked}
          onValueChange={(next) => onPredSideChange(next === "NO" ? "NO" : "YES")}
          options={[
            { value: "YES", label: `YES ${yesOddsPct}%` },
            { value: "NO", label: `NO ${100 - yesOddsPct}%` },
          ]}
        />
      </>
    );
  }
  return (
    <SegmentedControl
      aria-label="Perp direction"
      value={perpSide}
      disabled={blocked}
      onValueChange={(next) => onPerpSideChange(next === "Short" ? "Short" : "Long")}
      options={[
        { value: "Long", label: "Long" },
        { value: "Short", label: "Short" },
      ]}
    />
  );
}

function computeTradeTicketQuotes({
  marketKind,
  action,
  predSide,
  numericAmount,
  validAmount,
  leverage,
  yesOddsPct,
  yesShares,
  noShares,
  feeBps,
  sellPreview,
  perpPreview,
}: {
  readonly marketKind: "prediction" | "perp";
  readonly action: "Buy" | "Sell";
  readonly predSide: "YES" | "NO";
  readonly numericAmount: number;
  readonly validAmount: boolean;
  readonly leverage: number;
  readonly yesOddsPct: number;
  readonly yesShares?: number;
  readonly noShares?: number;
  readonly feeBps: number;
  readonly sellPreview?: TradeTicketSellPreview;
  readonly perpPreview?: TradeTicketPerpPreview;
}) {
  const activePricePct = predSide === "YES" ? yesOddsPct : 100 - yesOddsPct;
  const amountCents = validAmount ? Math.round(numericAmount * CENT_SHARES_PER_SHARE) : 0;
  const notionalPts = marketKind === "perp" && validAmount ? (amountCents * leverage) / 100 : numericAmount;
  const perpBelowMinimum = marketKind === "perp" && validAmount && amountCents * leverage < 1000;
  const hasExactCpmmInputs =
    validAmount &&
    yesShares !== undefined &&
    noShares !== undefined &&
    yesShares > 0 &&
    noShares > 0 &&
    Number.isSafeInteger(amountCents) &&
    Number.isSafeInteger(feeBps) &&
    Number.isSafeInteger(yesShares) &&
    Number.isSafeInteger(noShares);

  const notionalCents = marketKind === "perp" && validAmount ? Math.round(amountCents * leverage) : amountCents;
  const buyFeePts = validAmount && feeBps > 0 ? Math.ceil((notionalCents * feeBps) / 10000) / 100 : 0;
  const estimatedBuyWholeShares =
    validAmount && activePricePct > 0
      ? hasExactCpmmInputs
        ? estimatePredictionBuyCentShares(yesShares, noShares, predSide, amountCents, feeBps) / CENT_SHARES_PER_SHARE
        : (Math.max(0, numericAmount - buyFeePts) * 100) / activePricePct
      : 0;

  const sellGrossCents =
    marketKind === "prediction" && action === "Sell" && validAmount
      ? sellPreview
        ? sellPreview.grossProceedsCents
        : hasExactCpmmInputs
          ? estimatePredictionSellGrossCents(yesShares, noShares, predSide, amountCents)
          : Math.floor((amountCents * activePricePct) / 100)
      : 0;
  const sellFeeCents =
    marketKind === "prediction" && action === "Sell" && validAmount
      ? sellPreview
        ? sellPreview.feeCents
        : sellGrossCents > 0 && feeBps > 0
          ? Math.ceil((sellGrossCents * feeBps) / 10000)
          : 0
      : 0;
  const sellNetCents =
    marketKind === "prediction" && action === "Sell" && validAmount
      ? sellPreview
        ? sellPreview.netProceedsCents
        : Math.max(0, sellGrossCents - sellFeeCents)
      : 0;

  const estimatedFeePts =
    marketKind === "perp" && perpPreview
      ? perpPreview.feeCents / 100
      : marketKind === "prediction" && action === "Sell"
        ? sellFeeCents / 100
        : buyFeePts;

  return {
    activePricePct,
    amountCents,
    notionalPts,
    perpBelowMinimum,
    estimatedBuyWholeShares,
    sellNetCents,
    estimatedFeePts,
  };
}

/** Order ticket for prediction YES/NO shares and 1x-20x perpetuals with cent-share precision and perp previews. */
export function TradeTicket({
  marketKind,
  marketTitle,
  balancePts,
  yesOddsPct = 50,
  yesShares,
  noShares,
  heldYesShares,
  heldNoShares,
  sellPreview,
  ticker,
  markPricePts,
  indexPricePts,
  perpPreview,
  existingPerpSide = null,
  maxLeverage = 20,
  feeBps = 10,
  defaultAction = "Buy",
  defaultSide,
  defaultAmount = "10",
  defaultLeverage = 5,
  onPerpParamsChange,
  onPredictionParamsChange,
  onSubmit,
  loading = false,
  disabled = false,
  error,
  className,
  ...props
}: TradeTicketProps) {
  const amountId = useId();
  const leverageId = useId();
  const cappedMaxLev = Math.min(20, Math.max(1, maxLeverage));

  const [action, setAction] = useState<"Buy" | "Sell">(defaultAction);
  const [predSide, setPredSide] = useState<"YES" | "NO">(defaultSide === "NO" ? "NO" : "YES");
  const [perpSide, setPerpSide] = useState<"Long" | "Short">(defaultSide === "Short" ? "Short" : "Long");
  const [amount, setAmount] = useState(defaultAmount);
  const [leverage, setLeverage] = useState(Math.min(cappedMaxLev, Math.max(1, defaultLeverage)));

  const blocked = disabled || loading;
  const numericAmount = Number(amount);
  const validAmount = Number.isFinite(numericAmount) && numericAmount > 0;
  const {
    activePricePct,
    amountCents,
    notionalPts,
    perpBelowMinimum,
    estimatedBuyWholeShares,
    sellNetCents,
    estimatedFeePts,
  } = computeTradeTicketQuotes({
    marketKind,
    action,
    predSide,
    numericAmount,
    validAmount,
    leverage,
    yesOddsPct,
    yesShares,
    noShares,
    feeBps,
    sellPreview,
    perpPreview,
  });

  const activeHeldCentShares = predSide === "YES" ? heldYesShares : heldNoShares;
  const activeHeldWholeShares =
    activeHeldCentShares !== undefined && activeHeldCentShares > 0 ? activeHeldCentShares / CENT_SHARES_PER_SHARE : 0;

  const notifyPerpChange = (nextSide: "Long" | "Short", nextAmountText: string, nextLeverage: number) => {
    if (marketKind !== "perp" || !onPerpParamsChange) return;
    const parsed = Number(nextAmountText);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onPerpParamsChange({ side: nextSide, marginPts: parsed, leverage: nextLeverage });
  };

  const notifyPredictionChange = (nextAction: "Buy" | "Sell", nextSide: "YES" | "NO", nextAmountText: string) => {
    if (marketKind !== "prediction" || !onPredictionParamsChange) return;
    const parsed = Number(nextAmountText);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    onPredictionParamsChange({
      action: nextAction,
      side: nextSide,
      amountPts: parsed,
      shareUnits: Math.round(parsed * CENT_SHARES_PER_SHARE),
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !validAmount || perpBelowMinimum) return;
    if (marketKind === "prediction") {
      if (action === "Sell") {
        onSubmit({ marketKind: "prediction", action, side: predSide, amountPts: numericAmount, shareUnits: amountCents });
        return;
      }
      onSubmit({ marketKind: "prediction", action, side: predSide, amountPts: numericAmount });
      return;
    }
    onSubmit({ marketKind: "perp", side: perpSide, marginPts: numericAmount, leverage });
  };

  const perpSubmitLabel = existingPerpSide
    ? existingPerpSide === perpSide
      ? `Add ${perpSide} ${leverage}x`
      : `Rebalance ${perpSide} ${leverage}x`
    : `Open ${perpSide} ${leverage}x`;

  const isBearishAction =
    marketKind === "perp"
      ? perpSide === "Short"
      : action === "Sell" || predSide === "NO";

  return (
    <form onSubmit={handleSubmit} className={className} {...props}>
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4 text-foreground">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm leading-none font-semibold">{marketKind === "perp" && ticker ? `$${ticker} Perp` : "Trade Market"}</h3>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {balancePts}</span>
          </div>
          <p className="text-xs text-muted-foreground">{marketTitle}</p>
        </div>

        <div className="flex flex-col gap-3">
          <TradeTicketDirectionControls
            marketKind={marketKind}
            action={action}
            predSide={predSide}
            perpSide={perpSide}
            yesOddsPct={yesOddsPct}
            blocked={blocked}
            onActionChange={(resolved) => {
              setAction(resolved);
              notifyPredictionChange(resolved, predSide, amount);
            }}
            onPredSideChange={(resolved) => {
              setPredSide(resolved);
              notifyPredictionChange(action, resolved, amount);
            }}
            onPerpSideChange={(resolved) => {
              setPerpSide(resolved);
              notifyPerpChange(resolved, amount, leverage);
            }}
          />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={amountId}>
                {marketKind === "prediction" ? (action === "Buy" ? "Amount (pts)" : "Shares to sell") : "Margin (pts)"}
              </Label>
              {marketKind === "prediction" && action === "Sell" && activeHeldWholeShares > 0 ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">Held {activeHeldWholeShares.toFixed(2)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    onClick={() => {
                      const maxText = activeHeldWholeShares.toFixed(2);
                      setAmount(maxText);
                      notifyPredictionChange(action, predSide, maxText);
                    }}
                    className="h-6 px-1.5 font-mono text-xs"
                  >
                    Max
                  </Button>
                </div>
              ) : null}
            </div>
            <Input
              id={amountId}
              type="number"
              min={marketKind === "perp" ? "0.01" : "1"}
              step="any"
              value={amount}
              disabled={blocked}
              invalid={!validAmount && amount !== ""}
              onChange={(event) => {
                setAmount(event.target.value);
                notifyPerpChange(perpSide, event.target.value, leverage);
                notifyPredictionChange(action, predSide, event.target.value);
              }}
              className="font-mono tabular-nums"
            />
          </div>

          {marketKind === "perp" ? (
            <PerpLeverageControl
              leverageId={leverageId}
              leverage={leverage}
              maxLeverage={cappedMaxLev}
              blocked={blocked}
              onChange={(nextLev) => {
                setLeverage(nextLev);
                notifyPerpChange(perpSide, amount, nextLev);
              }}
            />
          ) : null}

          <TradeTicketSummary
            marketKind={marketKind}
            action={action}
            validAmount={validAmount}
            estimatedBuyWholeShares={estimatedBuyWholeShares}
            activePricePct={activePricePct}
            sellNetCents={sellNetCents}
            notionalPts={notionalPts}
            markPricePts={markPricePts}
            indexPricePts={indexPricePts}
            perpPreview={perpPreview}
            feeBps={feeBps}
            estimatedFeePts={estimatedFeePts}
          />

          {perpBelowMinimum ? (
            <Alert variant="destructive">Notional size must be at least 10 pts (margin × leverage).</Alert>
          ) : null}
          {error ? <Alert variant="destructive">{error}</Alert> : null}
        </div>

        <div className="flex flex-col items-stretch gap-2">
          <Button
            type="submit"
            variant={isBearishAction ? "destructive" : "primary"}
            loading={loading}
            disabled={blocked || !validAmount || perpBelowMinimum}
            className={cn(
              "w-full",
              !isBearishAction && "bg-ok-solid text-ok-solid-foreground hover:bg-ok-solid/90",
            )}
          >
            {marketKind === "prediction" ? `${action} ${predSide}` : perpSubmitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
