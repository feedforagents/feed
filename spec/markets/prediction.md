# Prediction markets

Complete-set Constant Product Market Maker (CPMM) YES/NO prediction markets with `100 cents = 1 pt` precision, canonical `10 bps` round-up trading fees, scheduled expiry closing, manual review holds, hidden outcome secrecy until resolution, idempotent `1 pt` per winning share redemption (`D-14`), and cost-basis cancellation refunds.

## Domain

### Market phases, secrecy, and account state

Outcomes are predetermined at market creation as a `SecretOutcome` (`SecretYes | SecretNo`) and cannot enter any public field, feed post, or proof publication before resolution. Shares use `SUBCENTS_PER_CENT = 100` (`1 share = 10,000 share units = 100 cents` on win), so cash credits settle downward to whole `Cents` via `floorCents`.

```quint
import money.* from "../shared/money"
import time.* from "../shared/time"

type Side = Yes | No
type SecretOutcome = SecretYes | SecretNo
type PublicOutcome = PendingOutcome | WonYes | WonNo | CancelledOutcome
type MarketPhase = PendingOpen | Trading | AwaitingProof | ManualReviewHold | Resolved | Cancelled

type TraderAccount = {
  id: str,
  balanceCents: Cents,
  yesShares: int,
  noShares: int,
  yesCostCents: Cents,
  noCostCents: Cents,
  settledOnClose: bool,
  realizedPnlCents: Cents,
}

type PredictionMarket = {
  phase: MarketPhase,
  slot: MarketSlot,
  now: int,
  closeAt: int,
  yesReserve: int,
  noReserve: int,
  initialK: int,
  liquidityCents: Cents,
  feeLedgerCents: Cents,
  chargedFees: List[Cents],
  totalSells: int,
  totalPayoutCents: Cents,
  totalRefundedCents: Cents,
  replayCount: int,
  secretOutcome: SecretOutcome,
  publicOutcome: PublicOutcome,
  proofReady: bool,
  proofPublished: bool,
  manualApproved: bool,
  accounts: List[TraderAccount],
}

pure val SUBCENTS_PER_CENT = 100
pure val INITIAL_RESERVE_UNITS = 500000
pure val INITIAL_LIQUIDITY_CENTS = 10000
pure val MIN_TRADE_CENTS = 100
pure val MIN_SELL_SHARE_UNITS = 100
pure val MAX_ODDS_MOVE_BPS = 2000
pure val ODDS_HARD_FLOOR_BPS = 200
pure val ODDS_HARD_CEILING_BPS = 9800
pure val MANUAL_REVIEW_THRESHOLD_BPS = 7000
pure val MAX_SQRT_OPERAND = 94906265

pure val SQRT_BITS = List(
  33554432, 16777216, 8388608, 4194304, 2097152, 1048576, 524288, 262144,
  131072, 65536, 32768, 16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64,
  32, 16, 8, 4, 2, 1
)

pure val initial: PredictionMarket = {
  phase: PendingOpen,
  slot: Slot15m,
  now: 0,
  closeAt: 0,
  yesReserve: INITIAL_RESERVE_UNITS,
  noReserve: INITIAL_RESERVE_UNITS,
  initialK: INITIAL_RESERVE_UNITS * INITIAL_RESERVE_UNITS,
  liquidityCents: INITIAL_LIQUIDITY_CENTS,
  feeLedgerCents: 0,
  chargedFees: List(),
  totalSells: 0,
  totalPayoutCents: 0,
  totalRefundedCents: 0,
  replayCount: 0,
  secretOutcome: SecretYes,
  publicOutcome: PendingOutcome,
  proofReady: false,
  proofPublished: false,
  manualApproved: false,
  accounts: List(
    { id: "alice", balanceCents: 10000, yesShares: 0, noShares: 0, yesCostCents: 0, noCostCents: 0, settledOnClose: false, realizedPnlCents: 0 },
    { id: "bob", balanceCents: 10000, yesShares: 0, noShares: 0, yesCostCents: 0, noCostCents: 0, settledOnClose: false, realizedPnlCents: 0 }
  ),
}

pure val traderIdValues = Set("", "alice", "bob")
pure val amountCentsValues = Set(-1, 0, 100, 500, 2000)
pure val sellSharesValues = Set(0, 100, 300, 1000, 5000, 10000)
pure val deltaMinutesValues = Set(-1, 5, 15, 60)
pure val confidenceBpsValues = Set(5000, 9000)
pure val acctValues =
  Set({ id: "alice", balanceCents: 10000, yesShares: 0, noShares: 0, yesCostCents: 0, noCostCents: 0, settledOnClose: false, realizedPnlCents: 0 })
    .union(Set({ id: "alice", balanceCents: 5000, yesShares: 1000, noShares: 0, yesCostCents: 500, noCostCents: 0, settledOnClose: false, realizedPnlCents: 0 }))
```

### CPMM pricing, square-root proceeds, and account helpers

CPMM buys mint complete sets from net cash after fee (`netUnits = netCents * SUBCENTS_PER_CENT`), preserving `yesReserve * noReserve >= initialK` via ceiling division. Sells redeem complete sets using the rationalized quadratic root floored via integer square root (`isqrt`), bounded below `oppReserve`.

```quint
pure def absInt(x: int): int = if (x < 0) 0 - x else x

pure def isqrt(d: int): int =
  if (d <= 0) 0
  else SQRT_BITS.foldl(0, (acc, bit) =>
    if (acc + bit <= MAX_SQRT_OPERAND and (acc + bit) * (acc + bit) <= d) acc + bit else acc)

pure def hasTrader(m: PredictionMarket, traderId: str): bool =
  m.accounts.some(a => a.id == traderId)

pure def emptyAccount(traderId: str): TraderAccount =
  { id: traderId, balanceCents: 0, yesShares: 0, noShares: 0, yesCostCents: 0, noCostCents: 0, settledOnClose: false, realizedPnlCents: 0 }

pure def accountFor(m: PredictionMarket, traderId: str): TraderAccount =
  m.accounts.foldl(emptyAccount(traderId), (found, a) => if (a.id == traderId) a else found)

pure def yesOddsBps(yesR: int, noR: int): int =
  val total = yesR + noR
  if (total <= 0) 5000 else (noR * BPS_DENOMINATOR) / total

pure def buyNextYesReserve(yesR: int, noR: int, side: Side, netUnits: int): int =
  if (yesR <= 0 or noR <= 0 or netUnits <= 0) yesR
  else if (side == Yes) ceilDiv(yesR * noR, noR + netUnits)
  else yesR + netUnits

pure def buyNextNoReserve(yesR: int, noR: int, side: Side, netUnits: int): int =
  if (yesR <= 0 or noR <= 0 or netUnits <= 0) noR
  else if (side == Yes) noR + netUnits
  else ceilDiv(yesR * noR, yesR + netUnits)

pure def buySharesBought(yesR: int, noR: int, side: Side, netUnits: int): int =
  if (yesR <= 0 or noR <= 0 or netUnits <= 0) 0
  else if (side == Yes) yesR - buyNextYesReserve(yesR, noR, Yes, netUnits) + netUnits
  else noR - buyNextNoReserve(yesR, noR, No, netUnits) + netUnits

pure def cpmmSellGrossUnits(yesR: int, noR: int, side: Side, sellShares: int): int =
  val sideR = if (side == Yes) yesR else noR
  val oppR = if (side == Yes) noR else yesR
  val total = sideR + oppR + sellShares
  val diff = sideR + oppR - sellShares
  val disc = diff * diff + 4 * sideR * sellShares
  val rootFloor = isqrt(disc)
  val rootCeil = if (rootFloor * rootFloor >= disc) rootFloor else rootFloor + 1
  val denom = total + rootCeil
  val rawUnits = if (denom <= 0) 0 else (2 * sellShares * oppR) / denom
  if (yesR <= 0 or noR <= 0 or sellShares <= 0) 0
  else minInt(clampMin0(rawUnits), minInt(oppR - 1, sellShares))

pure def heldSharesFor(acct: TraderAccount, side: Side): int =
  if (side == Yes) acct.yesShares else acct.noShares

pure def heldCostFor(acct: TraderAccount, side: Side): Cents =
  if (side == Yes) acct.yesCostCents else acct.noCostCents

pure def declassifyOutcome(secretVal: SecretOutcome): Side =
  if (secretVal == SecretYes) Yes else No

pure def sellAccountUpdate(acct: TraderAccount, side: Side, sellShares: int, netCredit: Cents): TraderAccount =
  val held = heldSharesFor(acct, side)
  val prevCost = heldCostFor(acct, side)
  val remaining = clampMin0(held - sellShares)
  val remCost = if (held <= 0 or remaining <= 0) 0 else (prevCost * remaining) / held
  val allocCost = prevCost - remCost
  {
    ...acct,
    balanceCents: acct.balanceCents + netCredit,
    yesShares: if (side == Yes) remaining else acct.yesShares,
    noShares: if (side == No) remaining else acct.noShares,
    yesCostCents: if (side == Yes) remCost else acct.yesCostCents,
    noCostCents: if (side == No) remCost else acct.noCostCents,
    realizedPnlCents: acct.realizedPnlCents + netCredit - allocCost,
  }

pure def settleWinnerAccount(acct: TraderAccount, winner: Side): TraderAccount =
  val winningShares = if (winner == Yes) acct.yesShares else acct.noShares
  val payout = floorCents(winningShares, SUBCENTS_PER_CENT)
  val cost = acct.yesCostCents + acct.noCostCents
  if (acct.settledOnClose) acct
  else {
    ...acct,
    balanceCents: acct.balanceCents + payout,
    yesShares: 0,
    noShares: 0,
    yesCostCents: 0,
    noCostCents: 0,
    settledOnClose: true,
    realizedPnlCents: acct.realizedPnlCents + payout - cost,
  }

pure def refundCancelledAccount(acct: TraderAccount): TraderAccount =
  val refund = acct.yesCostCents + acct.noCostCents
  if (acct.settledOnClose) acct
  else {
    ...acct,
    balanceCents: acct.balanceCents + refund,
    yesShares: 0,
    noShares: 0,
    yesCostCents: 0,
    noCostCents: 0,
    settledOnClose: true,
  }
```

## Story: Open and trade a prediction market

> As a trader, I want to buy and sell YES/NO shares against a CPMM pool before expiry with transparent cent-settled quotes and fees.

### A market opens with a valid slot schedule and private outcome

```quint
pure def canOpenMarket(m: PredictionMarket): bool =
  m.phase == PendingOpen

pure def openMarket(m: PredictionMarket, slot: MarketSlot, secretOutcome: SecretOutcome): PredictionMarket =
  {
    ...m,
    phase: Trading,
    slot: slot,
    closeAt: m.now + slotDurationMinutes(slot),
    secretOutcome: secretOutcome,
    publicOutcome: PendingOutcome,
    proofReady: false,
    proofPublished: false,
    manualApproved: false,
  }
```

### Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact

The canonical `10 bps` fee is computed on the gross input (`amountCents`), recorded in `feeLedgerCents`, and the remaining `netCents` mints complete sets and swaps along the CPMM curve.

```quint
pure def canBuy(m: PredictionMarket, traderId: str, side: Side, amountCents: Cents): bool =
  val acct = accountFor(m, traderId)
  val fee = canonicalTradingFee(amountCents)
  val netCents = buyNetAfterFee(amountCents)
  val netUnits = netCents * SUBCENTS_PER_CENT
  val nextYes = buyNextYesReserve(m.yesReserve, m.noReserve, side, netUnits)
  val nextNo = buyNextNoReserve(m.yesReserve, m.noReserve, side, netUnits)
  val sharesOut = buySharesBought(m.yesReserve, m.noReserve, side, netUnits)
  val oldOdds = yesOddsBps(m.yesReserve, m.noReserve)
  val newOdds = yesOddsBps(nextYes, nextNo)
  and {
    m.phase == Trading,
    m.now < m.closeAt,
    hasTrader(m, traderId),
    amountCents >= MIN_TRADE_CENTS,
    acct.balanceCents >= amountCents,
    fee >= 0,
    netCents > 0,
    nextYes > 0,
    nextNo > 0,
    sharesOut > 0,
    newOdds >= ODDS_HARD_FLOOR_BPS,
    newOdds <= ODDS_HARD_CEILING_BPS,
    absInt(newOdds - oldOdds) <= MAX_ODDS_MOVE_BPS,
  }

pure def buy(m: PredictionMarket, traderId: str, side: Side, amountCents: Cents): PredictionMarket =
  val fee = canonicalTradingFee(amountCents)
  val netCents = buyNetAfterFee(amountCents)
  val netUnits = netCents * SUBCENTS_PER_CENT
  val nextYes = buyNextYesReserve(m.yesReserve, m.noReserve, side, netUnits)
  val nextNo = buyNextNoReserve(m.yesReserve, m.noReserve, side, netUnits)
  val sharesOut = buySharesBought(m.yesReserve, m.noReserve, side, netUnits)
  {
    ...m,
    yesReserve: nextYes,
    noReserve: nextNo,
    liquidityCents: m.liquidityCents + netCents,
    feeLedgerCents: m.feeLedgerCents + fee,
    chargedFees: m.chargedFees.append(fee),
    accounts: m.accounts.listMap(a =>
      if (a.id != traderId) a
      else {
        ...a,
        balanceCents: a.balanceCents - amountCents,
        yesShares: if (side == Yes) a.yesShares + sharesOut else a.yesShares,
        noShares: if (side == No) a.noShares + sharesOut else a.noShares,
        yesCostCents: if (side == Yes) a.yesCostCents + amountCents else a.yesCostCents,
        noCostCents: if (side == No) a.noCostCents + amountCents else a.noCostCents,
      }),
  }

pure val eval_refuse_canBuy = { traderId: "alice", side: Yes, amountCents: -1 }
```

### Selling shares floors gross proceeds to whole cents before charging the canonical fee

Sub-cent remainders stay in house liquidity; if settled proceeds are `1 cent`, the `1 cent` round-up fee yields `0` net credit.

```quint
pure def canSell(m: PredictionMarket, traderId: str, side: Side, sellShares: int): bool =
  val acct = accountFor(m, traderId)
  val held = heldSharesFor(acct, side)
  val grossUnits = cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares)
  val settledCents = floorCents(grossUnits, SUBCENTS_PER_CENT)
  val nextYes = if (side == Yes) m.yesReserve + sellShares - grossUnits else m.yesReserve - grossUnits
  val nextNo = if (side == Yes) m.noReserve - grossUnits else m.noReserve + sellShares - grossUnits
  and {
    m.phase == Trading,
    m.now < m.closeAt,
    hasTrader(m, traderId),
    sellShares >= MIN_SELL_SHARE_UNITS,
    held >= sellShares,
    grossUnits > 0,
    settledCents > 0,
    settledCents <= m.liquidityCents,
    nextYes > 0,
    nextNo > 0,
  }

pure def sell(m: PredictionMarket, traderId: str, side: Side, sellShares: int): PredictionMarket =
  val grossUnits = cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares)
  val settledCents = floorCents(grossUnits, SUBCENTS_PER_CENT)
  val fee = canonicalTradingFee(settledCents)
  val netCredit = sellNetProceeds(settledCents)
  val nextYes = if (side == Yes) m.yesReserve + sellShares - grossUnits else m.yesReserve - grossUnits
  val nextNo = if (side == Yes) m.noReserve - grossUnits else m.noReserve + sellShares - grossUnits
  {
    ...m,
    yesReserve: nextYes,
    noReserve: nextNo,
    liquidityCents: m.liquidityCents - settledCents,
    feeLedgerCents: m.feeLedgerCents + fee,
    chargedFees: m.chargedFees.append(fee),
    totalSells: m.totalSells + 1,
    accounts: m.accounts.listMap(a =>
      if (a.id != traderId) a else sellAccountUpdate(a, side, sellShares, netCredit)),
  }
```

## Story: Close on schedule, review, resolve, or cancel

> As the operator, I want expired markets to stop trading, hold low-confidence resolutions for manual review, keep outcomes and proofs private until settlement, redeem winning shares at 1 pt each idempotently, and refund cancelled markets at cost basis.

### Time advances monotonically, and expiry closes trading into pending proof generation

```quint
pure def canAdvanceClock(m: PredictionMarket, deltaMinutes: int): bool =
  deltaMinutes > 0

pure def advanceClock(m: PredictionMarket, deltaMinutes: int): PredictionMarket =
  { ...m, now: m.now + deltaMinutes }

pure def canCloseAtExpiry(m: PredictionMarket): bool =
  m.phase == Trading and m.now >= m.closeAt

pure def closeAtExpiry(m: PredictionMarket): PredictionMarket =
  { ...m, phase: AwaitingProof }
```

### Proof generation keeps proofs private and holds low-confidence markets for manual review

```quint
pure def canGenerateProof(m: PredictionMarket, confidenceBps: int): bool =
  m.phase == AwaitingProof and not(m.proofReady) and confidenceBps >= 0 and confidenceBps <= BPS_DENOMINATOR

pure def generateProof(m: PredictionMarket, confidenceBps: int): PredictionMarket =
  val needsHold = confidenceBps < MANUAL_REVIEW_THRESHOLD_BPS
  {
    ...m,
    proofReady: true,
    phase: if (needsHold) ManualReviewHold else AwaitingProof,
  }

pure def canApproveManualReview(m: PredictionMarket): bool =
  m.phase == ManualReviewHold

pure def approveManualReview(m: PredictionMarket): PredictionMarket =
  { ...m, phase: AwaitingProof, manualApproved: true }
```

### Resolution declassifies the hidden outcome, publishes the proof, and pays 1 pt (100 cents) per winning share idempotently

Duplicate delivery (`replayResolution`) re-runs settlement and leaves balances, payouts, and proof publication unchanged.

```quint
pure def canResolveMarket(m: PredictionMarket): bool =
  m.phase == AwaitingProof and m.proofReady and m.now >= m.closeAt

pure def resolveMarket(m: PredictionMarket): PredictionMarket =
  val winner = declassifyOutcome(m.secretOutcome)
  val afterAccounts = m.accounts.listMap(a => settleWinnerAccount(a, winner))
  val payouts = m.accounts.foldl(0, (acc, a) =>
    if (a.settledOnClose) acc
    else acc + floorCents(if (winner == Yes) a.yesShares else a.noShares, SUBCENTS_PER_CENT))
  {
    ...m,
    phase: Resolved,
    publicOutcome: if (winner == Yes) WonYes else WonNo,
    proofPublished: true,
    totalPayoutCents: m.totalPayoutCents + payouts,
    liquidityCents: clampMin0(m.liquidityCents - payouts),
    accounts: afterAccounts,
  }

pure def canReplayResolution(m: PredictionMarket): bool =
  m.phase == Resolved

pure def replayResolution(m: PredictionMarket): PredictionMarket =
  val winner = if (m.publicOutcome == WonYes) Yes else No
  {
    ...m,
    replayCount: m.replayCount + 1,
    accounts: m.accounts.listMap(a => settleWinnerAccount(a, winner)),
  }
```

### Cancelled markets refund every open position at cost basis without publishing an outcome

```quint
pure def canCancelMarket(m: PredictionMarket): bool =
  m.phase == Trading or m.phase == AwaitingProof or m.phase == ManualReviewHold

pure def cancelMarket(m: PredictionMarket): PredictionMarket =
  val refunds = m.accounts.foldl(0, (acc, a) =>
    if (a.settledOnClose) acc else acc + a.yesCostCents + a.noCostCents)
  {
    ...m,
    phase: Cancelled,
    publicOutcome: CancelledOutcome,
    totalRefundedCents: m.totalRefundedCents + refunds,
    liquidityCents: clampMin0(m.liquidityCents - refunds),
    accounts: m.accounts.listMap(a => refundCancelledAccount(a)),
  }
```

## Invariants, step properties, and reachability

### Pool reserves remain strictly positive and satisfy the constant-product bound

```quint
pure def alwaysReservesPositive(m: PredictionMarket): bool =
  m.yesReserve > 0 and m.noReserve > 0 and m.initialK > 0

pure def alwaysConstantProductPreserved(m: PredictionMarket): bool =
  m.yesReserve * m.noReserve >= m.initialK
```

### Account balances, shares, liquidity, and costs never go negative

```quint
pure def alwaysBalancesAndPositionsNonNegative(m: PredictionMarket): bool =
  m.liquidityCents >= 0
    and m.totalPayoutCents >= 0
    and m.totalRefundedCents >= 0
    and m.replayCount >= 0
    and m.totalSells >= 0
    and m.now >= 0
    and (m.phase != PendingOpen implies m.closeAt > 0)
    and m.accounts.every(a => and {
      a.balanceCents >= 0,
      a.yesShares >= 0,
      a.noShares >= 0,
      a.yesCostCents >= 0,
      a.noCostCents >= 0,
      m.accounts.select(b => b.id == a.id).length() == 1,
    })
```

### The fee ledger always equals the exact sum of charged fees

```quint
pure def alwaysFeeLedgerReconciles(m: PredictionMarket): bool =
  m.feeLedgerCents >= 0
    and m.chargedFees.every(f => f >= 0)
    and m.feeLedgerCents == m.chargedFees.foldl(0, (acc, f) => acc + f)
```

### Hidden outcome and prepared proof are never visible before resolution

```quint
pure def alwaysHiddenOutcomeNeverVisibleBeforeResolution(m: PredictionMarket): bool =
  (m.phase != Resolved implies
    (m.publicOutcome != WonYes and m.publicOutcome != WonNo and not(m.proofPublished)))
    and (m.phase == Resolved implies
      ((m.publicOutcome == WonYes or m.publicOutcome == WonNo)
        and m.proofPublished
        and m.proofReady
        and m.now >= m.closeAt))
    and (m.phase == Cancelled implies m.publicOutcome == CancelledOutcome)
```

### Closed and settled states leave zero open shares and prevent duplicate settlement

Discovered inductively: tracking `settledOnClose` ensures duplicate resolution delivery can never issue a second payout.

```quint
pure def alwaysSettledAccountsHaveZeroOpenShares(m: PredictionMarket): bool =
  ((m.phase == Resolved or m.phase == Cancelled) implies
    m.accounts.every(a =>
      a.yesShares == 0 and a.noShares == 0 and a.yesCostCents == 0 and a.noCostCents == 0 and a.settledOnClose))
    and ((m.phase != Resolved and m.phase != Cancelled) implies
      m.accounts.every(a => not(a.settledOnClose)))
```

### Discovered by the proof: Active share and cash supply stays within the integer square-root range

Because `isqrt` evaluates a fixed 26-bit binary search (`sum(SQRT_BITS) = 67,108,863`), the constant-product bound on `sell` holds inductively only when active reserves plus trader shares and cash stay within `isqrt`'s exact range; neither `buy` nor `sell` ever increases this total.

```quint
pure def alwaysActiveSupplyWithinSqrtRange(m: PredictionMarket): bool =
  (m.phase != Resolved and m.phase != Cancelled) implies
    and {
      m.yesReserve + m.accounts.foldl(0, (acc, a) => acc + a.yesShares + a.balanceCents * SUBCENTS_PER_CENT) <= 20000000,
      m.noReserve + m.accounts.foldl(0, (acc, a) => acc + a.noShares + a.balanceCents * SUBCENTS_PER_CENT) <= 20000000,
    }
```

### Resolved, cancelled, held, and expired markets allow no trades, and duplicate resolution pays nothing extra

```quint
pure def stepNoTradesOutsideOpenWindow(before: PredictionMarket, via: str, after: PredictionMarket): bool =
  (before.phase != Trading or before.now >= before.closeAt) implies
    (via != "buy" and via != "sell")

pure def stepManualHoldBlocksResolution(before: PredictionMarket, via: str, after: PredictionMarket): bool =
  before.phase == ManualReviewHold implies via != "resolveMarket"

pure def stepDuplicateResolutionIsIdempotent(before: PredictionMarket, via: str, after: PredictionMarket): bool =
  via == "replayResolution" implies
    (after.accounts == before.accounts
      and after.totalPayoutCents == before.totalPayoutCents
      and after.liquidityCents == before.liquidityCents
      and after.proofPublished == before.proofPublished)

pure def stepTerminalPhasesStayTerminal(before: PredictionMarket, after: PredictionMarket): bool =
  (before.phase == Resolved implies after.phase == Resolved)
    and (before.phase == Cancelled implies after.phase == Cancelled)
```

### Reachable journeys cover buys, sells, 1 pt/share resolution, duplicate safety, manual hold, and cancellation

```quint
pure def sometimesBought(m: PredictionMarket): bool =
  m.accounts.some(a => a.yesShares > 0 or a.noShares > 0)

pure def sometimesSold(m: PredictionMarket): bool =
  m.totalSells >= 1

pure def sometimesResolvedWithOnePtPerShare(m: PredictionMarket): bool =
  m.phase == Resolved and m.totalPayoutCents >= 100 and m.proofPublished

pure def sometimesManualHoldPreserved(m: PredictionMarket): bool =
  m.phase == ManualReviewHold and not(m.proofPublished) and m.publicOutcome == PendingOutcome

pure def sometimesCancelledRefunded(m: PredictionMarket): bool =
  m.phase == Cancelled and m.totalRefundedCents >= 100

pure def sometimesDuplicateResolutionReplayed(m: PredictionMarket): bool =
  m.phase == Resolved and m.replayCount >= 1

pure val eval_witness_sometimesBought =
  (("openMarket", Slot15m, SecretYes), ("buy", "alice", Yes, 500))

pure val eval_witness_sometimesSold =
  (("openMarket", Slot15m, SecretYes), ("buy", "alice", Yes, 500), ("sell", "alice", Yes, 5000))

pure val eval_witness_sometimesManualHoldPreserved =
  (("openMarket", Slot15m, SecretYes), ("advanceClock", 15), "closeAtExpiry", ("generateProof", 5000))

pure val eval_witness_sometimesResolvedWithOnePtPerShare =
  (("openMarket", Slot15m, SecretYes), ("buy", "alice", Yes, 500), ("advanceClock", 15), "closeAtExpiry", ("generateProof", 9000), "resolveMarket")

pure val eval_witness_sometimesCancelledRefunded =
  (("openMarket", Slot15m, SecretYes), ("buy", "alice", Yes, 500), "cancelMarket")

pure val eval_witness_sometimesDuplicateResolutionReplayed =
  (("openMarket", Slot15m, SecretYes), ("buy", "alice", Yes, 500), ("advanceClock", 15), "closeAtExpiry", ("generateProof", 9000), "resolveMarket", "replayResolution")
```
