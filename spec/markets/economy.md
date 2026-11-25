# Economy and net-profit leaderboard

Single virtual currency `pts` (`100 cents = 1 pt`) with a fixed one-time `100 pts` (`10000 cents`, equivalent to `$100` virtual starting capital) initial grant on verified phone sign-up, strictly no buying, selling, depositing, withdrawing, or refilling capital (`D-15`, `D-18`), and net-profit leaderboard ranking (`netProfitCents = equityCents - startingGrantCents`, `D-15b`).

## Domain

### Fixed virtual capital and player ledgers

```quint
import money.* from "../shared/money"

type PlayerLedger = {
  id: str,
  verified: bool,
  grantClaimed: bool,
  cashCents: Cents,
  positionValueCents: Cents,
  startingGrantCents: Cents,
}

type EconomyState = {
  players: List[PlayerLedger],
}

pure val INITIAL_GRANT_PTS = 100
pure val INITIAL_GRANT_CENTS = 10000

pure val initial: EconomyState = {
  players: List(
    { id: "alice", verified: false, grantClaimed: false, cashCents: 0, positionValueCents: 0, startingGrantCents: 0 },
    { id: "bob", verified: true, grantClaimed: true, cashCents: INITIAL_GRANT_CENTS, positionValueCents: 0, startingGrantCents: INITIAL_GRANT_CENTS }
  ),
}

pure val playerIdValues = Set("", "alice", "bob")
pure val cashDeltaCentsValues = Set(-10000, -5000, 0, 2000)
pure val newPosValueCentsValues = Set(-1, 0, 2000, 5000)
```

### Equity, net profit, and leaderboard rank helpers

Net profit is `equity - startingGrant`, where `equity = cashCents + positionValueCents`.

```quint
pure def hasPlayer(e: EconomyState, playerId: str): bool =
  e.players.some(p => p.id == playerId)

pure val emptyPlayer: PlayerLedger = {
  id: "",
  verified: false,
  grantClaimed: false,
  cashCents: 0,
  positionValueCents: 0,
  startingGrantCents: 0,
}

pure def playerFor(e: EconomyState, playerId: str): PlayerLedger =
  e.players.foldl(emptyPlayer, (found, p) => if (p.id == playerId) p else found)

pure def equityCents(p: PlayerLedger): Cents =
  p.cashCents + p.positionValueCents

pure def netProfitCents(p: PlayerLedger): Cents =
  equityCents(p) - p.startingGrantCents

pure def leaderboardRank(e: EconomyState, playerId: str): int =
  val target = playerFor(e, playerId)
  if (not(target.verified)) 0
  else 1 + e.players.select(q => q.verified and netProfitCents(q) > netProfitCents(target)).length()
```

## Story: Verify account and claim initial grant once

> As a new player, I want a fixed 100 pts ($100 virtual capital) granted once upon verified phone sign-up, with no buying, selling, depositing, withdrawing, or refilling capital if I go broke.

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

## Story: Trade with fixed starting capital and rank by net profit

> As a verified player, I want to trade freely with my fixed 100 pts starting capital and climb the net-profit leaderboard through trading skill alone, with no capital purchases or refills.

### Verified players with positive equity can trade and may go broke with no refill path

Verified accounts with zero equity have zero cash and zero position value. Because no purchase, deposit, withdrawal, or refill transition exists, a broke account remains at zero equity.

```quint
pure def canPlayTrade(
  e: EconomyState,
  playerId: str,
  cashDeltaCents: Cents,
  newPosValueCents: Cents
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
  newPosValueCents: Cents
): EconomyState =
  {
    ...e,
    players: e.players.listMap(p =>
      if (p.id != playerId) p
      else { ...p, cashCents: p.cashCents + cashDeltaCents, positionValueCents: newPosValueCents }),
  }
```

## Invariants, step rules, and reachability

### Initial grants are fixed at 100 pts, balances stay non-negative, and net profit excludes only the starting grant

```quint
pure def alwaysEconomyInvariantsHold(e: EconomyState): bool =
  e.players.every(p => and {
    p.cashCents >= 0,
    p.positionValueCents >= 0,
    p.verified iff (p.grantClaimed and p.startingGrantCents == INITIAL_GRANT_CENTS),
    p.verified implies netProfitCents(p) == equityCents(p) - INITIAL_GRANT_CENTS,
    not(p.verified) implies
      (not(p.grantClaimed) and p.cashCents == 0 and p.positionValueCents == 0 and p.startingGrantCents == 0),
    e.players.select(q => q.id == p.id).length() == 1,
  })
```

### No purchase, deposit, or refill can restore a broke account or alter a claimed starting grant

```quint
pure def stepNoRefillsOrCapitalInjectionsWhenBroke(before: EconomyState, after: EconomyState): bool =
  after.players.every(a => before.players.some(b =>
    b.id == a.id and ((b.verified and equityCents(b) == 0) implies equityCents(a) == 0)))

pure def stepStartingGrantFixedAt100Pts(before: EconomyState, after: EconomyState): bool =
  after.players.every(a => before.players.some(b =>
    b.id == a.id
      and (b.grantClaimed implies (a.grantClaimed and a.startingGrantCents == INITIAL_GRANT_CENTS))
      and (not(b.grantClaimed) implies (a.startingGrantCents == 0 or a.startingGrantCents == INITIAL_GRANT_CENTS))))
```

### Reachable journeys cover sign-up grants, going broke with no refill, and profit ranking

```quint
pure def sometimesVerifiedGrantClaimed(e: EconomyState): bool =
  playerFor(e, "alice").verified and playerFor(e, "alice").cashCents == INITIAL_GRANT_CENTS

pure def sometimesBrokeWithNoRefill(e: EconomyState): bool =
  val b = playerFor(e, "bob")
  b.verified and equityCents(b) == 0

pure def sometimesNetProfitPositive(e: EconomyState): bool =
  netProfitCents(playerFor(e, "bob")) > 0

pure val eval_witness_sometimesVerifiedGrantClaimed =
  ("verifyAndGrant", "alice")

pure val eval_witness_sometimesBrokeWithNoRefill =
  ("playTrade", "bob", -10000, 0)

pure val eval_witness_sometimesNetProfitPositive =
  ("playTrade", "bob", 2000, 0)
```
