import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { estimatePredictionBuyShares } from "@repo/markets/quote";
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
  const notionalPts = marketKind === "perp" && validAmount ? numericAmount * leverage : numericAmount;
  const estimatedFeePts = validAmount ? Math.max(0.01, (notionalPts * feeBps) / 10000) : 0;
  const activePricePct = predSide === "YES" ? yesOddsPct : 100 - yesOddsPct;
  const amountCents = numericAmount * 100;
  const poolReserves =
    yesShares !== undefined && noShares !== undefined && yesShares > 0 && noShares > 0 ? { yes: yesShares, no: noShares } : null;
  const exactQuote =
    validAmount &&
    poolReserves !== null &&
    Number.isSafeInteger(amountCents) &&
    Number.isSafeInteger(feeBps) &&
    Number.isSafeInteger(poolReserves.yes) &&
    Number.isSafeInteger(poolReserves.no);
  const estimatedShares =
    validAmount && activePricePct > 0
      ? exactQuote && poolReserves !== null
        ? estimatePredictionBuyShares({
            yesShares: poolReserves.yes,
            noShares: poolReserves.no,
            side: predSide === "YES" ? "yes" : "no",
            amountCents,
            feeBps,
          })
        : (amountCents * 100) / activePricePct
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
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{action === "Buy" ? "Est. shares" : "Implied price"}</dt>
                <dd className="font-mono font-medium text-foreground tabular-nums">
                  {action === "Buy" ? `${estimatedShares.toFixed(2)} shares` : `${activePricePct}%`}
                </dd>
              </div>
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
