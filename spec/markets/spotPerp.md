# Spot and perpetual markets

"NPCs buy spot, spot drives perps" (PRD §9.3): only NPCs trade the spot CPMM pool (`D-17`), the persisted `indexPriceCents` derives strictly from the spot pool with no random-walk price source, players and NPCs trade perpetuals up to `20x` leverage (`D-17b`) against a whole-cent mark price computed from `index * (1 + boundedPremium(netOI))` with a one-cent floor. Funding accrues at most once per position per UTC 8-hour period on or after the cutover boundary. A position liquidates when its mark-price equity is at or below maintenance margin.

## Domain

### Spot pools, perpetual positions, and sender roles

Only `NpcTrader` may execute `tradeSpot`; `PlayerTrader` is strictly refused spot trades and trades perpetuals instead. `BASE_SCALE = 100` stores spot base reserves in `1/100` tokens so a valid spot pool uses `indexPriceCents = max(1, (quoteReserve * BASE_SCALE) / baseReserve)` in whole cents.

```quint
import money.* from "../shared/money"
import time.* from "../shared/time"

type Sender = NpcTrader | PlayerTrader
type SpotSide = SpotBuy | SpotSell
type PerpSide = Long | Short

type SpotPerpAccount = {
  id: str,
  balanceCents: Cents,
}

type PerpPosition = {
  posId: int,
  owner: str,
  perpSide: PerpSide,
  sizeCents: Cents,
  leverage: int,
  marginCents: Cents,
  entryPriceCents: Cents,
  openedPeriod: int,
  lastFundingPeriod: int,
  fundingPaidCents: int,
}

type FundingClaim = {
  posId: int,
  period: int,
}

type SpotPerpMarket = {
  baseReserve: int,
  quoteReserve: int,
  initialK: int,
  indexPriceCents: Cents,
  markPriceCents: Cents,
  longOICents: Cents,
  shortOICents: Cents,
  currentHour: int,
  currentPeriod: int,
  cutoverPeriod: int,
  nextPosId: int,
  npcSpotBase: int,
  feeLedgerCents: Cents,
  liquidationCount: int,
  lastSpotBy: Sender,
  lastFundingReqPeriod: int,
  positions: List[PerpPosition],
  fundingClaims: List[FundingClaim],
  accounts: List[SpotPerpAccount],
}

pure val BASE_SCALE = 100
pure val INITIAL_BASE_RESERVE = 10000
pure val INITIAL_QUOTE_RESERVE = 1000000
pure val MAX_LEVERAGE = 20
pure val MIN_ORDER_SIZE_CENTS = 1000
pure val MAX_PREMIUM_BPS = 500
pure val MAINTENANCE_MARGIN_BPS = 250
pure val FUNDING_DAMPENER = 10
pure val INITIAL_CUTOVER_PERIOD = 1

pure def computeIndexPriceCents(quoteR: int, baseR: int): Cents =
  if (quoteR <= 0 or baseR <= 0) 0
  else maxInt(1, (quoteR * BASE_SCALE) / baseR)

pure def boundedPremiumBps(longOI: Cents, shortOI: Cents): int =
  val totalOI = longOI + shortOI
  val netOI = longOI - shortOI
  if (totalOI <= 0) 0
  else (netOI * MAX_PREMIUM_BPS) / totalOI

pure def computeMarkPriceCents(indexCents: Cents, longOI: Cents, shortOI: Cents): Cents =
  val premBps = boundedPremiumBps(longOI, shortOI)
  if (indexCents <= 0) 0
  else maxInt(1, (indexCents * (BPS_DENOMINATOR + premBps)) / BPS_DENOMINATOR)

pure val initial: SpotPerpMarket = {
  baseReserve: INITIAL_BASE_RESERVE,
  quoteReserve: INITIAL_QUOTE_RESERVE,
  initialK: INITIAL_BASE_RESERVE * INITIAL_QUOTE_RESERVE,
  indexPriceCents: computeIndexPriceCents(INITIAL_QUOTE_RESERVE, INITIAL_BASE_RESERVE),
  markPriceCents: computeMarkPriceCents(computeIndexPriceCents(INITIAL_QUOTE_RESERVE, INITIAL_BASE_RESERVE), 0, 0),
  longOICents: 0,
  shortOICents: 0,
  currentHour: 0,
  currentPeriod: 0,
  cutoverPeriod: INITIAL_CUTOVER_PERIOD,
  nextPosId: 0,
  npcSpotBase: 10000,
  feeLedgerCents: 0,
  liquidationCount: 0,
  lastSpotBy: NpcTrader,
  lastFundingReqPeriod: -1,
  positions: List(),
  fundingClaims: List(),
  accounts: List(
    { id: "npc", balanceCents: 1000000 },
    { id: "alice", balanceCents: 100000 },
    { id: "bob", balanceCents: 100000 }
  ),
}

pure val traderIdValues = Set("", "alice", "bob", "npc")
pure val spotAmountValues = Set(-1, 0, 1000, 2000, 50000)
pure val perpSizeCentsValues = Set(0, 1000, 5000, 10000)
pure val leverageValues = Set(0, 1, 5, 20, 21)
pure val deltaHoursValues = Set(-1, 1, 8, 16)
pure val periodValues = Set(0, 1, 2, 3)
pure val indexCentsValues = Set(100, 1000, 10000)
pure val longOIValues = Set(0, 1000, 10000)
pure val shortOIValues = Set(0, 1000, 10000)
pure val mktValues = Set(initial)
```

### Account, margin, equity, and funding helpers

```quint
pure def hasSpotAccount(m: SpotPerpMarket, traderId: str): bool =
  m.accounts.some(a => a.id == traderId)

pure def spotBalanceFor(m: SpotPerpMarket, traderId: str): Cents =
  m.accounts.foldl(0, (bal, a) => if (a.id == traderId) a.balanceCents else bal)

pure def senderOwnsTrader(by: Sender, traderId: str): bool =
  (by == NpcTrader and traderId == "npc")
    or (by == PlayerTrader and (traderId == "alice" or traderId == "bob"))

pure def hasOpenPosition(m: SpotPerpMarket, traderId: str): bool =
  m.positions.some(p => p.owner == traderId)

pure val emptyPos: PerpPosition = {
  posId: 0,
  owner: "",
  perpSide: Long,
  sizeCents: 0,
  leverage: 1,
  marginCents: 0,
  entryPriceCents: 1,
  openedPeriod: 0,
  lastFundingPeriod: 0,
  fundingPaidCents: 0,
}

pure val posValues =
  Set(emptyPos).union(Set({
    posId: 1,
    owner: "alice",
    perpSide: Long,
    sizeCents: 10000,
    leverage: 20,
    marginCents: 500,
    entryPriceCents: 10000,
    openedPeriod: 0,
    lastFundingPeriod: 0,
    fundingPaidCents: 0,
  }))

pure def positionFor(m: SpotPerpMarket, traderId: str): PerpPosition =
  m.positions.foldl(emptyPos, (found, p) => if (p.owner == traderId) p else found)

pure def sumLongOI(ps: List[PerpPosition]): Cents =
  ps.foldl(0, (acc, p) => if (p.perpSide == Long) acc + p.sizeCents else acc)

pure def sumShortOI(ps: List[PerpPosition]): Cents =
  ps.foldl(0, (acc, p) => if (p.perpSide == Short) acc + p.sizeCents else acc)

pure def unrealizedPnlAtMark(pos: PerpPosition, markCents: Cents): Cents =
  if (pos.entryPriceCents <= 0) 0
  else if (pos.perpSide == Long)
    floorCents(pos.sizeCents * (markCents - pos.entryPriceCents), pos.entryPriceCents)
  else
    floorCents(pos.sizeCents * (pos.entryPriceCents - markCents), pos.entryPriceCents)

pure def positionEquityAtMark(pos: PerpPosition, markCents: Cents): Cents =
  pos.marginCents + unrealizedPnlAtMark(pos, markCents) - pos.fundingPaidCents

pure def maintenanceMarginCents(sizeCents: Cents): Cents =
  maxInt(1, (sizeCents * MAINTENANCE_MARGIN_BPS) / BPS_DENOMINATOR)

pure def isPositionLiquidatable(m: SpotPerpMarket, pos: PerpPosition): bool =
  positionEquityAtMark(pos, m.markPriceCents) <= maintenanceMarginCents(pos.sizeCents)

pure def creditBalance(accounts: List[SpotPerpAccount], traderId: str, deltaCents: Cents): List[SpotPerpAccount] =
  accounts.listMap(a => if (a.id == traderId) { ...a, balanceCents: a.balanceCents + deltaCents } else a)

pure def fundingDeltaForPosition(pos: PerpPosition, premBps: int): int =
  val absPrem = if (premBps < 0) 0 - premBps else premBps
  val mag = (pos.sizeCents * absPrem) / (BPS_DENOMINATOR * FUNDING_DAMPENER)
  if (premBps > 0) (if (pos.perpSide == Long) mag else 0 - mag)
  else if (premBps < 0) (if (pos.perpSide == Short) mag else 0 - mag)
  else 0

pure def spotNextQuote(quoteR: int, baseR: int, spotSide: SpotSide, spotAmount: int): int =
  if (quoteR <= 0 or baseR <= 0 or spotAmount <= 0) quoteR
  else if (spotSide == SpotBuy) quoteR + spotAmount
  else ceilDiv(baseR * quoteR, baseR + spotAmount)

pure def spotNextBase(quoteR: int, baseR: int, spotSide: SpotSide, spotAmount: int): int =
  if (quoteR <= 0 or baseR <= 0 or spotAmount <= 0) baseR
  else if (spotSide == SpotBuy) ceilDiv(baseR * quoteR, quoteR + spotAmount)
  else baseR + spotAmount
```

## Story: NPC spot trades drive the index price

> As a player watching the world, I want NPC spot trading to move the persistent spot index price while players are blocked from spot trading.

### Only NPCs may trade the spot CPMM pool, updating the persisted index price

```quint
pure def canTradeSpot(m: SpotPerpMarket, spotSide: SpotSide, spotAmount: int, by: Sender): bool =
  val npcBal = spotBalanceFor(m, "npc")
  val nextQ = spotNextQuote(m.quoteReserve, m.baseReserve, spotSide, spotAmount)
  val nextB = spotNextBase(m.quoteReserve, m.baseReserve, spotSide, spotAmount)
  val nextIdx = computeIndexPriceCents(nextQ, nextB)
  if (by != NpcTrader or spotAmount <= 0) false
  else if (spotSide == SpotBuy)
    spotAmount <= npcBal and nextB > 0 and (m.baseReserve - nextB) > 0 and nextIdx > 0
  else
    spotAmount <= m.npcSpotBase and nextQ > 0 and (m.quoteReserve - nextQ) > 0 and nextIdx > 0

pure def tradeSpot(m: SpotPerpMarket, spotSide: SpotSide, spotAmount: int, by: Sender): SpotPerpMarket =
  val nextQ = spotNextQuote(m.quoteReserve, m.baseReserve, spotSide, spotAmount)
  val nextB = spotNextBase(m.quoteReserve, m.baseReserve, spotSide, spotAmount)
  val nextIndex = computeIndexPriceCents(nextQ, nextB)
  val nextMark = computeMarkPriceCents(nextIndex, m.longOICents, m.shortOICents)
  val cashDelta = if (spotSide == SpotBuy) 0 - spotAmount else m.quoteReserve - nextQ
  val baseDelta = if (spotSide == SpotBuy) m.baseReserve - nextB else 0 - spotAmount
  {
    ...m,
    baseReserve: nextB,
    quoteReserve: nextQ,
    indexPriceCents: nextIndex,
    markPriceCents: nextMark,
    npcSpotBase: m.npcSpotBase + baseDelta,
    lastSpotBy: by,
    accounts: creditBalance(m.accounts, "npc", cashDelta),
  }

pure val eval_refuse_canTradeSpot = { spotSide: SpotBuy, spotAmount: 1000, by: PlayerTrader }
```

## Story: Open and close perpetuals up to 20x leverage

> As a trader, I want to open and close perpetual positions up to 20x leverage whose open interest moves the mark premium without changing the underlying spot index.

### Opening a perp enforces the 20x leverage cap and updates only the mark premium

Opening a perpetual adds the position's open interest first and fills the entry at the resulting `postOpenMark` price (adverse to the opener), so opening a position never generates instant unrealized profit from its own open-interest impact.

```quint
pure def canOpenPerp(
  m: SpotPerpMarket,
  traderId: str,
  perpSide: PerpSide,
  perpSizeCents: Cents,
  leverage: int,
  by: Sender
): bool =
  val margin = if (leverage <= 0) 0 else ceilDiv(perpSizeCents, leverage)
  val fee = canonicalTradingFee(perpSizeCents)
  and {
    senderOwnsTrader(by, traderId),
    hasSpotAccount(m, traderId),
    not(hasOpenPosition(m, traderId)),
    perpSizeCents >= MIN_ORDER_SIZE_CENTS,
    leverage >= 1,
    leverage <= MAX_LEVERAGE,
    spotBalanceFor(m, traderId) >= margin + fee,
  }

pure def openPerp(
  m: SpotPerpMarket,
  traderId: str,
  perpSide: PerpSide,
  perpSizeCents: Cents,
  leverage: int,
  by: Sender
): SpotPerpMarket =
  val margin = ceilDiv(perpSizeCents, leverage)
  val fee = canonicalTradingFee(perpSizeCents)
  val newLong = if (perpSide == Long) m.longOICents + perpSizeCents else m.longOICents
  val newShort = if (perpSide == Short) m.shortOICents + perpSizeCents else m.shortOICents
  val postOpenMark = computeMarkPriceCents(m.indexPriceCents, newLong, newShort)
  val newPosId = m.nextPosId + 1
  val newPos: PerpPosition = {
    posId: newPosId,
    owner: traderId,
    perpSide: perpSide,
    sizeCents: perpSizeCents,
    leverage: leverage,
    marginCents: margin,
    entryPriceCents: postOpenMark,
    openedPeriod: m.currentPeriod,
    lastFundingPeriod: m.currentPeriod,
    fundingPaidCents: 0,
  }
  {
    ...m,
    nextPosId: newPosId,
    longOICents: newLong,
    shortOICents: newShort,
    markPriceCents: postOpenMark,
    feeLedgerCents: m.feeLedgerCents + fee,
    positions: m.positions.append(newPos),
    accounts: creditBalance(m.accounts, traderId, 0 - (margin + fee)),
  }

pure val eval_refuse_canOpenPerp = {
  traderId: "alice",
  perpSide: Long,
  perpSizeCents: 1000,
  leverage: 21,
  by: PlayerTrader,
}
```

### Closing a perp settles equity and canonical fees at mark price without touching spot

Closing removes the position's open interest first and settles equity at the resulting `postCloseMark` price (adverse to the closer), preventing a trader from harvesting their own open-interest premium. The canonical fee is computed on the position size and collected up to the amount of positive equity.

```quint
pure def canClosePerp(m: SpotPerpMarket, traderId: str, by: Sender): bool =
  senderOwnsTrader(by, traderId) and hasOpenPosition(m, traderId)

pure def closePerp(m: SpotPerpMarket, traderId: str, by: Sender): SpotPerpMarket =
  val pos = positionFor(m, traderId)
  val remaining = m.positions.select(p => p.owner != traderId)
  val newLong = sumLongOI(remaining)
  val newShort = sumShortOI(remaining)
  val postCloseMark = computeMarkPriceCents(m.indexPriceCents, newLong, newShort)
  val gross = clampMin0(positionEquityAtMark(pos, postCloseMark))
  val fee = canonicalTradingFee(pos.sizeCents)
  val collectedFee = minInt(fee, gross)
  val netCredit = clampMin0(gross - fee)
  {
    ...m,
    longOICents: newLong,
    shortOICents: newShort,
    markPriceCents: postCloseMark,
    feeLedgerCents: m.feeLedgerCents + collectedFee,
    positions: remaining,
    accounts: creditBalance(m.accounts, traderId, netCredit),
  }
```

## Story: 8-hour funding accrual and mark-price liquidation

> As the exchange operator, I want funding to accrue at most once per position per UTC 8h period starting from the cutover boundary, so funding incentives encourage the mark price to converge toward the spot price. I want positions to liquidate when their mark-price equity reaches or falls below maintenance margin.

### UTC time advances across 8-hour funding boundaries, and funding skips pre-cutover or duplicate periods

```quint
pure def canAdvanceHours(m: SpotPerpMarket, deltaHours: int): bool =
  deltaHours > 0

pure def advanceHours(m: SpotPerpMarket, deltaHours: int): SpotPerpMarket =
  val nextHour = m.currentHour + deltaHours
  {
    ...m,
    currentHour: nextHour,
    currentPeriod: fundingPeriodIndex(nextHour),
  }

pure def canAccrueFunding(m: SpotPerpMarket, period: int): bool =
  period >= 0 and period <= m.currentPeriod

pure def accrueFunding(m: SpotPerpMarket, period: int): SpotPerpMarket =
  val premBps = boundedPremiumBps(m.longOICents, m.shortOICents)
  val eligible = m.positions.select(p => period > p.openedPeriod and period > p.lastFundingPeriod)
  val newClaims = eligible.listMap(p => { posId: p.posId, period: period })
  val updatedPositions = m.positions.listMap(p =>
    if (period > p.openedPeriod and period > p.lastFundingPeriod)
      { ...p, lastFundingPeriod: period, fundingPaidCents: p.fundingPaidCents + fundingDeltaForPosition(p, premBps) }
    else p)
  if (period < m.cutoverPeriod)
    { ...m, lastFundingReqPeriod: period }
  else {
    ...m,
    lastFundingReqPeriod: period,
    positions: updatedPositions,
    fundingClaims: m.fundingClaims.concat(newClaims),
  }
```

### A position whose mark-price equity breaches maintenance margin is liquidated

```quint
pure def canLiquidate(m: SpotPerpMarket, traderId: str): bool =
  hasOpenPosition(m, traderId) and isPositionLiquidatable(m, positionFor(m, traderId))

pure def liquidate(m: SpotPerpMarket, traderId: str): SpotPerpMarket =
  val pos = positionFor(m, traderId)
  val remaining = m.positions.select(p => p.owner != traderId)
  val newLong = sumLongOI(remaining)
  val newShort = sumShortOI(remaining)
  val postLiqMark = computeMarkPriceCents(m.indexPriceCents, newLong, newShort)
  val payout = clampMin0(positionEquityAtMark(pos, postLiqMark))
  {
    ...m,
    longOICents: newLong,
    shortOICents: newShort,
    markPriceCents: postLiqMark,
    liquidationCount: m.liquidationCount + 1,
    positions: remaining,
    accounts: creditBalance(m.accounts, traderId, payout),
  }
```

## Invariants, step rules, and reachability

### Spot reserves and prices stay positive, and open interest is non-negative and matches positions

```quint
pure def alwaysSpotAndPricesConsistent(m: SpotPerpMarket): bool =
  m.baseReserve > 0
    and m.quoteReserve > 0
    and m.initialK > 0
    and m.baseReserve * m.quoteReserve >= m.initialK
    and m.indexPriceCents == computeIndexPriceCents(m.quoteReserve, m.baseReserve)
    and m.indexPriceCents > 0
    and m.markPriceCents == computeMarkPriceCents(m.indexPriceCents, m.longOICents, m.shortOICents)
    and m.markPriceCents > 0

pure def alwaysOpenInterestMatchesPositions(m: SpotPerpMarket): bool =
  m.longOICents == sumLongOI(m.positions)
    and m.shortOICents == sumShortOI(m.positions)
    and m.longOICents >= 0
    and m.shortOICents >= 0
```

### Every position obeys the 20x leverage cap and unique ownership, and all balances are non-negative

```quint
pure def alwaysPositionsWithin20xAndUnique(m: SpotPerpMarket): bool =
  m.nextPosId >= 0
    and m.currentHour >= 0
    and m.currentPeriod == fundingPeriodIndex(m.currentHour)
    and m.cutoverPeriod >= 1
    and m.npcSpotBase >= 0
    and m.liquidationCount >= 0
    and m.feeLedgerCents >= 0
    and m.accounts.every(a =>
      a.balanceCents >= 0 and m.accounts.select(b => b.id == a.id).length() == 1)
    and m.positions.every(p => and {
      p.posId >= 1,
      p.posId <= m.nextPosId,
      1 <= p.leverage,
      p.leverage <= MAX_LEVERAGE,
      p.sizeCents >= MIN_ORDER_SIZE_CENTS,
      p.marginCents == ceilDiv(p.sizeCents, p.leverage),
      p.entryPriceCents > 0,
      p.openedPeriod >= 0,
      p.lastFundingPeriod >= p.openedPeriod,
      p.lastFundingPeriod <= m.currentPeriod,
      m.positions.select(q => q.posId == p.posId).length() == 1,
      m.positions.select(q => q.owner == p.owner).length() == 1,
    })
```

### Funding claims are post-cutover, bounded by monotonic lastFundingPeriod, and unique per position and period

```quint
pure def alwaysFundingAccruedAtMostOncePerPeriod(m: SpotPerpMarket): bool =
  m.fundingClaims.every(c => and {
    c.posId >= 1,
    c.posId <= m.nextPosId,
    c.period >= m.cutoverPeriod,
    c.period <= m.currentPeriod,
    m.fundingClaims.select(d => d.posId == c.posId and d.period == c.period).length() == 1,
  })
    and m.positions.every(p =>
      m.fundingClaims.every(c => c.posId == p.posId implies c.period <= p.lastFundingPeriod))
```

### Only NPCs execute spot trades, perp trades never move spot or index, and funding periods advance monotonically

```quint
pure def stepOnlyNpcTradesSpot(before: SpotPerpMarket, via: str, after: SpotPerpMarket): bool =
  via == "tradeSpot" implies after.lastSpotBy == NpcTrader

pure def stepPerpTradesLeaveSpotAndIndexUnchanged(before: SpotPerpMarket, via: str, after: SpotPerpMarket): bool =
  (via == "openPerp" or via == "closePerp") implies
    (after.indexPriceCents == before.indexPriceCents
      and after.baseReserve == before.baseReserve
      and after.quoteReserve == before.quoteReserve)

pure def stepFundingPeriodMonotonicAndCutoverGuarded(before: SpotPerpMarket, via: str, after: SpotPerpMarket): bool =
  after.positions.every(p => before.positions.every(q =>
    q.posId == p.posId implies p.lastFundingPeriod >= q.lastFundingPeriod))
    and ((via == "accrueFunding" and after.lastFundingReqPeriod < after.cutoverPeriod) implies
      (after.positions == before.positions and after.fundingClaims == before.fundingClaims))

pure def stepOpenFillsAtPostImpactMark(before: SpotPerpMarket, via: str, after: SpotPerpMarket): bool =
  via == "openPerp" implies
    after.positions.every(p => p.posId == after.nextPosId implies p.entryPriceCents == after.markPriceCents)
```

### Zero-time open and close round-trips on an unchanged index price strictly decrease trader cash

Opening at the post-open mark and closing at the post-close mark ensures self-impact is always adverse, so a zero-time open-and-close round-trip on an unchanged spot index price cannot create risk-free profit and strictly reduces trader cash due to fees and adverse OI impact.

```quint
pure def lawPerpRoundTripStrictlyDecreasesCash(
  indexCents: Cents,
  longOI: Cents,
  shortOI: Cents,
  perpSide: PerpSide,
  perpSizeCents: Cents,
  leverage: int
): bool =
  val openLong = if (perpSide == Long) longOI + perpSizeCents else longOI
  val openShort = if (perpSide == Short) shortOI + perpSizeCents else shortOI
  val entryPrice = computeMarkPriceCents(indexCents, openLong, openShort)
  val exitPrice = computeMarkPriceCents(indexCents, longOI, shortOI)
  val margin = ceilDiv(perpSizeCents, leverage)
  val openFee = canonicalTradingFee(perpSizeCents)
  val pos: PerpPosition = {
    posId: 1,
    owner: "alice",
    perpSide: perpSide,
    sizeCents: perpSizeCents,
    leverage: leverage,
    marginCents: margin,
    entryPriceCents: entryPrice,
    openedPeriod: 0,
    lastFundingPeriod: 0,
    fundingPaidCents: 0,
  }
  val gross = clampMin0(positionEquityAtMark(pos, exitPrice))
  val closeFee = canonicalTradingFee(perpSizeCents)
  val netCredit = clampMin0(gross - closeFee)
  (indexCents > 0 and longOI >= 0 and shortOI >= 0
    and perpSizeCents >= MIN_ORDER_SIZE_CENTS
    and leverage >= 1 and leverage <= MAX_LEVERAGE) implies
    (netCredit < margin + openFee)

pure def lawPerpMarketRoundTripStrictlyDecreasesCash(
  mkt: SpotPerpMarket,
  traderId: str,
  perpSide: PerpSide,
  perpSizeCents: Cents,
  leverage: int,
  by: Sender
): bool =
  val afterOpen = openPerp(mkt, traderId, perpSide, perpSizeCents, leverage, by)
  val afterClose = closePerp(afterOpen, traderId, by)
  (alwaysSpotAndPricesConsistent(mkt)
    and alwaysOpenInterestMatchesPositions(mkt)
    and alwaysPositionsWithin20xAndUnique(mkt)
    and canOpenPerp(mkt, traderId, perpSide, perpSizeCents, leverage, by)) implies
    (spotBalanceFor(afterClose, traderId) < spotBalanceFor(mkt, traderId))
```

### Reachable journeys cover NPC spot moving index, 20x player perps, 8h funding accrual, and mark-price liquidation

```quint
pure def sometimesNpcSpotMovesIndex(m: SpotPerpMarket): bool =
  m.indexPriceCents != initial.indexPriceCents

pure def sometimesPlayerOpens20xPerp(m: SpotPerpMarket): bool =
  m.positions.some(p => p.owner == "alice" and p.leverage == MAX_LEVERAGE)

pure def sometimesFundingAccruedOncePer8h(m: SpotPerpMarket): bool =
  m.fundingClaims.length() >= 1

pure def sometimesPositionLiquidated(m: SpotPerpMarket): bool =
  m.liquidationCount >= 1

pure val eval_witness_sometimesNpcSpotMovesIndex =
  ("tradeSpot", SpotBuy, 50000, NpcTrader)

pure val eval_witness_sometimesPlayerOpens20xPerp =
  ("openPerp", "alice", Long, 10000, 20, PlayerTrader)

pure val eval_witness_sometimesFundingAccruedOncePer8h =
  (("openPerp", "alice", Long, 10000, 20, PlayerTrader), ("advanceHours", 8, PlayerTrader), ("accrueFunding", 1, PlayerTrader))

pure val eval_witness_sometimesPositionLiquidated =
  (("openPerp", "alice", Long, 10000, 20, PlayerTrader), ("tradeSpot", SpotSell, 2000, NpcTrader), ("liquidate", "alice", PlayerTrader))
```
