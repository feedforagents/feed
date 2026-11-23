# Shared money and fee precision

Single currency arithmetic in whole integer `Cents` (`100 cents = 1 pt`), with downward cent settlement (`floorCents`), the canonical `0.1%` (`10 bps`) round-up trading fee, and partition non-amplification laws guaranteeing that splitting trades or settlements never creates points or extra shares.

## Currency units and integer bounds

### One point equals one hundred cents, and integer bounds clamp cleanly

All cash balances, charges, proceeds, and fee ledger totals are stored in whole integer `Cents`.

```quint
type Cents = int

pure val CENTS_PER_PT = 100
pure val TRADING_FEE_BPS = 10
pure val BPS_DENOMINATOR = 10000

pure def clampMin0(x: int): int = if (x < 0) 0 else x
pure def minInt(a: int, b: int): int = if (a <= b) a else b
pure def maxInt(a: int, b: int): int = if (a >= b) a else b
pure def ptsToCents(pts: int): Cents = pts * CENTS_PER_PT
```

## Settlement rounding

### Cash proceeds floor to whole cents, and ceiling division rounds up safely

Quint `/` rounds towards zero; `floorCents` rounds `numer / denom` towards negative infinity when `denom > 0`, returning `0` on non-positive denominators. Positive ceiling division `ceilDiv` rounds upward for fees and CPMM pool reserves.

```quint
pure val denomValues = Set(1, 2, 10, 100)

pure def floorCents(numer: int, denom: int): Cents =
  if (denom <= 0) 0
  else if (numer >= 0) numer / denom
  else (numer - denom + 1) / denom

pure def ceilDiv(numer: int, denom: int): int =
  if (denom <= 0) 0
  else if (numer >= 0) (numer + denom - 1) / denom
  else numer / denom

pure def floorNonNegCents(numer: int, denom: int): Cents =
  clampMin0(floorCents(numer, denom))
```

### Splitting non-negative amounts never increases floored cents

```quint
pure def lawFloorCentsPartitionNeverAmplifies(a: int, b: int, denom: int): bool =
  (a >= 0 and b >= 0 and denom > 0) implies
    floorCents(a, denom) + floorCents(b, denom) <= floorCents(a + b, denom)
```

## Canonical trading fee

### Every trade pays a 0.1% fee rounded up to whole cents on the settled amount

At `10 bps` (`0.1%`), zero settled notional yields zero fee, a `1 pt` (`100 cents`) settled trade pays `1 cent` (`0.01 pt`), and a `1 cent` settled sale nets `0` after its `1 cent` fee. Trader buy charges are `settled + fee`; net cash after fee on gross input is `max(0, settled - fee)`; seller net proceeds are `max(0, settled - fee)`.

```quint
pure val settledCentsValues = Set(0, 1, 50, 100, 1000, 1001, 2000)

pure def canonicalTradingFeeAtBps(settledNotional: Cents, feeBps: int): Cents =
  if (settledNotional <= 0 or feeBps <= 0) 0
  else ceilDiv(settledNotional * feeBps, BPS_DENOMINATOR)

pure def canonicalTradingFee(settledNotional: Cents): Cents =
  canonicalTradingFeeAtBps(settledNotional, TRADING_FEE_BPS)

pure def buyTotalCharge(settledNotional: Cents): Cents =
  val settledAmount = clampMin0(settledNotional)
  if (settledAmount == 0) 0 else settledAmount + canonicalTradingFee(settledAmount)

pure def buyNetAfterFee(grossCash: Cents): Cents =
  val settledAmount = clampMin0(grossCash)
  clampMin0(settledAmount - canonicalTradingFee(settledAmount))

pure def sellNetProceeds(settledProceeds: Cents): Cents =
  val settledAmount = clampMin0(settledProceeds)
  clampMin0(settledAmount - canonicalTradingFee(settledAmount))

pure def lawZeroNotionalPaysZeroFee(feeBps: int): bool =
  canonicalTradingFeeAtBps(0, feeBps) == 0 and buyTotalCharge(0) == 0 and sellNetProceeds(0) == 0

pure def lawSmallTradeFeesStayVisible(settledCents: Cents): bool =
  (settledCents == 100 implies canonicalTradingFee(settledCents) == 1)
    and (settledCents == 1 implies (canonicalTradingFee(settledCents) == 1 and sellNetProceeds(settledCents) == 0))

pure def lawBuyChargeMatchesSettledPlusFee(settledCents: Cents): bool =
  settledCents > 0 implies buyTotalCharge(settledCents) == settledCents + canonicalTradingFee(settledCents)
```

## Partition non-amplification

### Splitting sales or gross cash proceeds never increases total trader credit

Per-leg flooring combined with per-leg round-up fees ensures splitting a sale or cash input into two legs never yields more net cents than executing the combined trade as one leg.

```quint
pure def lawSellProceedsPartitionNonAmplifying(grossA: int, grossB: int, denom: int): bool =
  (grossA >= 0 and grossB >= 0 and denom > 0) implies
    sellNetProceeds(floorCents(grossA, denom)) + sellNetProceeds(floorCents(grossB, denom))
      <= sellNetProceeds(floorCents(grossA + grossB, denom))

pure def lawBuyNetPartitionNonAmplifying(cashA: int, cashB: int, denom: int): bool =
  (cashA >= 0 and cashB >= 0 and denom > 0) implies
    buyNetAfterFee(floorCents(cashA, denom)) + buyNetAfterFee(floorCents(cashB, denom))
      <= buyNetAfterFee(floorCents(cashA + cashB, denom))
```

### Splitting cash inputs never increases total CPMM shares received

Under complete-set CPMM pricing where the pool reserve updates upward by ceiling division (`k <= newSide * newOpp`), splitting a cash buy across two orders never produces more shares than buying the combined cash amount in one trade.

```quint
pure val sideReserveValues = Set(100, 1000, 10000)
pure val oppReserveValues = Set(100, 1000, 10000)
pure val legCashAValues = Set(0, 1, 100, 500, 1000)
pure val legCashBValues = Set(0, 1, 100, 500, 1000)

pure def cpmmNextSideReserve(sideReserve: int, oppReserve: int, netAmount: int): int =
  if (sideReserve <= 0 or oppReserve <= 0 or netAmount <= 0) sideReserve
  else ceilDiv(sideReserve * oppReserve, oppReserve + netAmount)

pure def cpmmBuySharesOut(sideReserve: int, oppReserve: int, netAmount: int): int =
  if (sideReserve <= 0 or oppReserve <= 0 or netAmount <= 0) 0
  else sideReserve - cpmmNextSideReserve(sideReserve, oppReserve, netAmount) + netAmount

pure def lawSplitBuyNeverIncreasesShares(sideReserve: int, oppReserve: int, legCashA: Cents, legCashB: Cents): bool =
  val netA = buyNetAfterFee(legCashA)
  val netB = buyNetAfterFee(legCashB)
  val netWhole = buyNetAfterFee(legCashA + legCashB)
  val midSide = cpmmNextSideReserve(sideReserve, oppReserve, netA)
  val midOpp = oppReserve + netA
  val splitShares = cpmmBuySharesOut(sideReserve, oppReserve, netA) + cpmmBuySharesOut(midSide, midOpp, netB)
  val wholeShares = cpmmBuySharesOut(sideReserve, oppReserve, netWhole)
  (sideReserve > 0 and oppReserve > 0 and legCashA >= 0 and legCashB >= 0) implies
    splitShares <= wholeShares
```
