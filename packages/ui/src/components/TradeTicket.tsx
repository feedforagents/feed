import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Alert } from "./Alert.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";

export type TradeTicketOrder =
  | {
      marketKind: "prediction";
      action: "Buy" | "Sell";
      side: "YES" | "NO";
      amountPts: number;
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
  /** CPMM YES reserve in credited shares, when the market view carries it. */
  yesShares?: number;
  /** CPMM NO reserve in credited shares, when the market view carries it. */
  noShares?: number;
  /** Optional perp ticker such as `SAMALT`. */
  ticker?: string;
  /** Current perp mark price string. */
  markPricePts?: string;
  /** Current NPC-derived spot index price string. */
  indexPricePts?: string;
  /** Maximum perp leverage allowed (defaults to 20). */
  maxLeverage?: number;
  /** Canonical fee in basis points (defaults to 10 bps). */
  feeBps?: number;
  /** Initial order action for prediction tickets. */
  defaultAction?: "Buy" | "Sell";
  /** Initial side selection. */
  defaultSide?: "YES" | "NO" | "Long" | "Short";
  /** Initial points amount string. */
  defaultAmount?: string;
  /** Initial leverage for perp tickets (clamped to `1..maxLeverage`). */
  defaultLeverage?: number;
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

function estimatePredictionBuyShares(
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

function bigIntSqrt(value: bigint): bigint {
  if (value <= 0n) return 0n;
  let x = value;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + value / x) >> 1n;
  }
  return x;
}

function estimatePredictionSellGrossCents(
  yesShares: number,
  noShares: number,
  side: "YES" | "NO",
  sellShares: number,
): number {
  if (yesShares <= 0 || noShares <= 0 || sellShares <= 0) return 0;
  const sideReserve = BigInt(side === "YES" ? yesShares : noShares);
  const oppReserve = BigInt(side === "YES" ? noShares : yesShares);
  const sell = BigInt(sellShares);
  const total = sideReserve + oppReserve + sell;
  const diff = sideReserve + oppReserve - sell;
  const discriminant = diff * diff + 4n * sideReserve * sell;
  const rootFloor = bigIntSqrt(discriminant);
  const rootCeil = rootFloor * rootFloor >= discriminant ? rootFloor : rootFloor + 1n;
  const denom = total + rootCeil;
  if (denom <= 0n) return 0;
  const rawGross = Number((2n * sell * oppReserve) / denom);
  return Math.max(0, Math.min(rawGross, Math.min(Number(oppReserve) - 1, sellShares)));
}

/** Order ticket for prediction YES/NO shares and 1x-20x perpetuals with mandatory virtual-points disclosure. */
export function TradeTicket({
  marketKind,
  marketTitle,
  balancePts,
  yesOddsPct = 50,
  yesShares,
  noShares,
  ticker,
  markPricePts,
  indexPricePts,
  maxLeverage = 20,
  feeBps = 10,
  defaultAction = "Buy",
  defaultSide,
  defaultAmount = "10",
  defaultLeverage = 5,
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
  const activePricePct = predSide === "YES" ? yesOddsPct : 100 - yesOddsPct;
  const notionalPts = marketKind === "perp" && validAmount ? numericAmount * leverage : numericAmount;
  const sellUnits = Math.max(1, Math.round(numericAmount));
  const hasSellCpmmInputs =
    validAmount &&
    yesShares !== undefined &&
    noShares !== undefined &&
    yesShares > 0 &&
    noShares > 0 &&
    Number.isSafeInteger(sellUnits) &&
    Number.isSafeInteger(yesShares) &&
    Number.isSafeInteger(noShares);
  const sellSettledCents =
    marketKind === "prediction" && action === "Sell" && validAmount
      ? hasSellCpmmInputs
        ? estimatePredictionSellGrossCents(yesShares, noShares, predSide, sellUnits)
        : Math.floor((sellUnits * activePricePct) / 100)
      : 0;
  const estimatedFeePts = validAmount
    ? marketKind === "prediction" && action === "Sell"
      ? Math.max(0.01, Math.ceil((sellSettledCents * feeBps) / 10000) / 100)
      : Math.max(0.01, (notionalPts * feeBps) / 10000)
    : 0;
  const sellProceedsPts =
    marketKind === "prediction" && action === "Sell" && validAmount
      ? Math.max(0, sellSettledCents - Math.round(estimatedFeePts * 100)) / 100
      : 0;
  const amountCents = Math.round(numericAmount * 100);
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
  const estimatedShares =
    validAmount && activePricePct > 0
      ? hasExactCpmmInputs
        ? estimatePredictionBuyShares(yesShares, noShares, predSide, amountCents, feeBps)
        : (numericAmount * 10000) / activePricePct
      : 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !validAmount) return;
    if (marketKind === "prediction") {
      onSubmit({ marketKind: "prediction", action, side: predSide, amountPts: numericAmount });
      return;
    }
    onSubmit({ marketKind: "perp", side: perpSide, marginPts: numericAmount, leverage });
  };

  return (
    <form onSubmit={handleSubmit} className={className} {...props}>
      <Card className="gap-4 p-5">
        <CardHeader className="gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">{marketKind === "perp" && ticker ? `$${ticker} Perp` : "Trade Market"}</CardTitle>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">Avail {balancePts}</span>
          </div>
          <p className="text-xs text-muted-foreground">{marketTitle}</p>
        </CardHeader>

        <CardContent className="gap-3">
          {marketKind === "prediction" ? (
            <>
              <SegmentedControl
                aria-label="Order action"
                value={action}
                disabled={blocked}
                onValueChange={(next) => setAction(next === "Sell" ? "Sell" : "Buy")}
                options={[
                  { value: "Buy", label: "Buy" },
                  { value: "Sell", label: "Sell" },
                ]}
              />
              <SegmentedControl
                aria-label="Prediction side"
                value={predSide}
                disabled={blocked}
                onValueChange={(next) => setPredSide(next === "NO" ? "NO" : "YES")}
                options={[
                  { value: "YES", label: `YES ${yesOddsPct}%` },
                  { value: "NO", label: `NO ${100 - yesOddsPct}%` },
                ]}
              />
            </>
          ) : (
            <SegmentedControl
              aria-label="Perp direction"
              value={perpSide}
              disabled={blocked}
              onValueChange={(next) => setPerpSide(next === "Short" ? "Short" : "Long")}
              options={[
                { value: "Long", label: "Long" },
                { value: "Short", label: "Short" },
              ]}
            />
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={amountId}>
              {marketKind === "prediction" ? (action === "Buy" ? "Amount (pts)" : "Shares to sell") : "Margin (pts)"}
            </Label>
            <Input
              id={amountId}
              type="number"
              min="1"
              step="any"
              value={amount}
              disabled={blocked}
              invalid={!validAmount && amount !== ""}
              onChange={(event) => setAmount(event.target.value)}
              className="font-mono tabular-nums"
            />
          </div>

          {marketKind === "perp" ? (
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
                max={cappedMaxLev}
                step={1}
                value={leverage}
                disabled={blocked}
                onChange={(event) => setLeverage(Number(event.target.value))}
                className="w-full accent-primary disabled:opacity-50"
              />
              <div className="grid grid-cols-4 gap-1.5">
                {leveragePresets.filter((preset) => preset <= cappedMaxLev).map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant={leverage === preset ? "primary" : "outline"}
                    size="sm"
                    disabled={blocked}
                    onClick={() => setLeverage(preset)}
                    className="font-mono tabular-nums"
                  >
                    {preset}x
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-muted p-3 text-xs">
            {marketKind === "prediction" ? (
              <>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">{action === "Buy" ? "Est. shares" : "Implied price"}</dt>
                  <dd className="font-mono font-medium text-foreground tabular-nums">
                    {action === "Buy" ? `${estimatedShares.toFixed(2)} shares` : `${activePricePct}%`}
                  </dd>
                </div>
                {action === "Sell" ? (
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Est. proceeds</dt>
                    <dd className="font-mono font-medium text-foreground tabular-nums">
                      {validAmount ? `${sellProceedsPts.toFixed(2)} pts` : "—"}
                    </dd>
                  </div>
                ) : null}
              </>
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
              </>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Fee ({feeBps} bps)</dt>
              <dd className="font-mono text-foreground tabular-nums">{validAmount ? `${estimatedFeePts.toFixed(2)} pts` : "—"}</dd>
            </div>
          </dl>

          {error ? <Alert variant="destructive">{error}</Alert> : null}
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-2">
          <Button
            type="submit"
            variant={marketKind === "perp" && perpSide === "Short" ? "destructive" : "primary"}
            loading={loading}
            disabled={blocked || !validAmount}
            className="w-full"
          >
            {marketKind === "prediction" ? `${action} ${predSide}` : `Open ${perpSide} ${leverage}x`}
          </Button>
          <p className={cn("text-center text-xs text-muted-foreground")}>Virtual points — no cash value</p>
        </CardFooter>
      </Card>
    </form>
  );
}
