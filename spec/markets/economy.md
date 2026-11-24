# Economy and net-profit leaderboard

Single virtual currency `pts` (`100 cents = 1 pt`), a one-time `100 pts` (`10000 cents`) initial grant on verified phone sign-up with no free refills when broke (`D-15`), web-only Stripe Checkout point packs (`$5` = 500 pts, `$20` = 2000 pts, `$50` = 5000 pts at `100 pts/$1`), strict Washington purchase blocking (`billingWashington or ipWashington`) while free play stays open, and net-profit leaderboard ranking unaffected by purchases (`D-15b`).

## Domain

### Currency packs, purchase channels, geolocation, and player ledgers

```quint
import money.* from "../shared/money"

type PurchasePack = Pack5 | Pack20 | Pack50
type PurchaseChannel = WebCheckout | McpTool

type GeoCheck = {
  billingWashington: bool,
  ipWashington: bool,
}

type PlayerLedger = {
  id: str,
  verified: bool,
  grantClaimed: bool,
  cashCents: Cents,
  positionValueCents: Cents,
  startingGrantCents: Cents,
  purchasedCents: Cents,
}

type EconomyState = {
  players: List[PlayerLedger],
  washingtonFreePlayCount: int,
  lastPurchaseWasWashington: bool,
  lastPurchaseWasMcp: bool,
}

pure val INITIAL_GRANT_PTS = 100
pure val INITIAL_GRANT_CENTS = 10000
pure val PTS_PER_DOLLAR = 100

pure val initial: EconomyState = {
  players: List(
    { id: "alice", verified: false, grantClaimed: false, cashCents: 0, positionValueCents: 0, startingGrantCents: 0, purchasedCents: 0 },
    { id: "bob", verified: true, grantClaimed: true, cashCents: INITIAL_GRANT_CENTS, positionValueCents: 0, startingGrantCents: INITIAL_GRANT_CENTS, purchasedCents: 0 }
  ),
  washingtonFreePlayCount: 0,
  lastPurchaseWasWashington: false,
  lastPurchaseWasMcp: false,
}

pure val playerIdValues = Set("", "alice", "bob")
pure val geoValues =
  Set({ billingWashington: false, ipWashington: false })
    .union(Set({ billingWashington: true, ipWashington: false }))
    .union(Set({ billingWashington: false, ipWashington: true }))
pure val cashDeltaCentsValues = Set(-10000, -5000, 0, 2000)
pure val newPosValueCentsValues = Set(-1, 0, 2000, 5000)
```

### Pack pricing, equity, net profit, and leaderboard rank helpers

Net profit is `equity - startingGrant - purchasedPts`, where `equity = cashCents + positionValueCents`.

```quint
pure def packUsd(pack: PurchasePack): int =
  match pack {
    | Pack5 => 5
    | Pack20 => 20
    | Pack50 => 50
  }

pure def packPts(pack: PurchasePack): int =
  packUsd(pack) * PTS_PER_DOLLAR

pure def packCents(pack: PurchasePack): Cents =
  ptsToCents(packPts(pack))

pure def isWashingtonBlocked(geo: GeoCheck): bool =
  geo.billingWashington or geo.ipWashington

pure def hasPlayer(e: EconomyState, playerId: str): bool =
  e.players.some(p => p.id == playerId)

pure val emptyPlayer: PlayerLedger = {
  id: "",
  verified: false,
  grantClaimed: false,
  cashCents: 0,
  positionValueCents: 0,
  startingGrantCents: 0,
  purchasedCents: 0,
}

pure def playerFor(e: EconomyState, playerId: str): PlayerLedger =
  e.players.foldl(emptyPlayer, (found, p) => if (p.id == playerId) p else found)

pure def equityCents(p: PlayerLedger): Cents =
  p.cashCents + p.positionValueCents

pure def netProfitCents(p: PlayerLedger): Cents =
  equityCents(p) - p.startingGrantCents - p.purchasedCents

pure def leaderboardRank(e: EconomyState, playerId: str): int =
  val target = playerFor(e, playerId)
  if (not(target.verified)) 0
  else 1 + e.players.select(q => q.verified and netProfitCents(q) > netProfitCents(target)).length()
```

## Story: Verify account and claim initial grant once

> As a new player, I want 100 pts granted once upon verified phone sign-up, with no free refills if I go broke.

### Unverified accounts receive 100 pts (10000 cents) exactly once at verification

```quint
pure def canVerifyAndGrant(e: EconomyState, playerId: str): bool =
  val p = playerFor(e, playerId)
  hasPlayer(e, playerId) and not(p.verified) and not(p.grantClaimed)

pure def verifyAndGrant(e: EconomyState, playerId: str): EconomyState =
  {
    ...e,
    players: e.players.listMap(p =>
      if (p.id != playerId) p
      else {
        ...p,
        verified: true,
        grantClaimed: true,
        cashCents: INITIAL_GRANT_CENTS,
        startingGrantCents: INITIAL_GRANT_CENTS,
      }),
  }
```

## Story: Buy points on web outside Washington, and play anywhere

> As a player, I want to buy point packs on feed.fun outside Washington while free play remains open everywhere, and never gain leaderboard profit or rank from buying points.

### Stripe Checkout packs are web-only and strictly blocked for Washington billing addresses or IPs

```quint
pure def canBuyPoints(
  e: EconomyState,
  playerId: str,
  pack: PurchasePack,
  channel: PurchaseChannel,
  geo: GeoCheck
): bool =
  val p = playerFor(e, playerId)
  hasPlayer(e, playerId)
    and p.verified
    and channel == WebCheckout
    and not(isWashingtonBlocked(geo))

pure def buyPoints(
  e: EconomyState,
  playerId: str,
  pack: PurchasePack,
  channel: PurchaseChannel,
  geo: GeoCheck
): EconomyState =
  val added = packCents(pack)
  {
    ...e,
    lastPurchaseWasWashington: isWashingtonBlocked(geo),
    lastPurchaseWasMcp: channel == McpTool,
    players: e.players.listMap(p =>
      if (p.id != playerId) p
      else {
        ...p,
        cashCents: p.cashCents + added,
        purchasedCents: p.purchasedCents + added,
      }),
  }

pure val eval_refuse_canBuyPoints = {
  playerId: "bob",
  pack: Pack5,
  channel: WebCheckout,
  geo: { billingWashington: true, ipWashington: false },
}
```

### Verified players with positive equity can trade freely in any location, including Washington, and may go broke

Verified accounts with no equity have zero cash and zero position value. Only a valid purchase outside Washington can restore their funds.

```quint
pure def canPlayTrade(
  e: EconomyState,
  playerId: str,
  cashDeltaCents: Cents,
  newPosValueCents: Cents,
  geo: GeoCheck
): bool =
  val p = playerFor(e, playerId)
  and {
    hasPlayer(e, playerId),
    p.verified,
    equityCents(p) > 0,
    newPosValueCents >= 0,
    p.cashCents + cashDeltaCents >= 0,
  }

pure def playTrade(
  e: EconomyState,
  playerId: str,
  cashDeltaCents: Cents,
  newPosValueCents: Cents,
  geo: GeoCheck
): EconomyState =
  {
    ...e,
    washingtonFreePlayCount: e.washingtonFreePlayCount + (if (isWashingtonBlocked(geo)) 1 else 0),
    players: e.players.listMap(p =>
      if (p.id != playerId) p
      else { ...p, cashCents: p.cashCents + cashDeltaCents, positionValueCents: newPosValueCents }),
  }
```

## Invariants, step rules, and reachability

### Initial grants are single-use, balances stay non-negative, and blocked purchases never commit

```quint
pure def alwaysEconomyInvariantsHold(e: EconomyState): bool =
  e.washingtonFreePlayCount >= 0
    and not(e.lastPurchaseWasWashington)
    and not(e.lastPurchaseWasMcp)
    and e.players.every(p => and {
      p.cashCents >= 0,
      p.positionValueCents >= 0,
      p.purchasedCents >= 0,
      p.verified iff (p.grantClaimed and p.startingGrantCents == INITIAL_GRANT_CENTS),
      not(p.verified) implies
        (not(p.grantClaimed) and p.cashCents == 0 and p.positionValueCents == 0 and p.startingGrantCents == 0 and p.purchasedCents == 0),
      e.players.select(q => q.id == p.id).length() == 1,
    })
```

### Buying points never changes net profit or leaderboard rank, and broke players receive no free refills

```quint
pure def stepPurchaseNeverChangesNetProfitOrRank(before: EconomyState, via: str, after: EconomyState): bool =
  via == "buyPoints" implies
    after.players.every(a => before.players.some(b =>
      b.id == a.id
        and netProfitCents(a) == netProfitCents(b)
        and leaderboardRank(after, a.id) == leaderboardRank(before, a.id)))

pure def stepNoFreeRefillsWhenBroke(before: EconomyState, via: str, after: EconomyState): bool =
  via != "buyPoints" implies
    after.players.every(a => before.players.some(b =>
      b.id == a.id and ((b.verified and equityCents(b) == 0) implies equityCents(a) == 0)))

pure def stepStartingGrantGrantedAtMostOnce(before: EconomyState, after: EconomyState): bool =
  after.players.every(a => before.players.some(b =>
    b.id == a.id and (b.grantClaimed implies (a.grantClaimed and a.startingGrantCents == b.startingGrantCents))))
```

### Reachable journeys cover sign-up grants, web purchases, Washington free play, going broke, and profit ranking

```quint
pure def sometimesVerifiedGrantClaimed(e: EconomyState): bool =
  playerFor(e, "alice").verified and playerFor(e, "alice").cashCents == INITIAL_GRANT_CENTS

pure def sometimesPointsPurchased(e: EconomyState): bool =
  playerFor(e, "bob").purchasedCents >= 50000

pure def sometimesBrokeWithNoRefill(e: EconomyState): bool =
  val b = playerFor(e, "bob")
  b.verified and equityCents(b) == 0

pure def sometimesWashingtonFreePlay(e: EconomyState): bool =
  e.washingtonFreePlayCount >= 1

pure def sometimesNetProfitPositive(e: EconomyState): bool =
  netProfitCents(playerFor(e, "bob")) > 0

pure val eval_witness_sometimesVerifiedGrantClaimed =
  ("verifyAndGrant", "alice")

pure val eval_witness_sometimesPointsPurchased =
  ("buyPoints", "bob", Pack20, WebCheckout, { billingWashington: false, ipWashington: false })

pure val eval_witness_sometimesBrokeWithNoRefill =
  ("playTrade", "bob", -10000, 0, { billingWashington: false, ipWashington: false })

pure val eval_witness_sometimesWashingtonFreePlay =
  ("playTrade", "bob", 2000, 0, { billingWashington: true, ipWashington: false })

pure val eval_witness_sometimesNetProfitPositive =
  ("playTrade", "bob", 2000, 0, { billingWashington: false, ipWashington: false })
```
