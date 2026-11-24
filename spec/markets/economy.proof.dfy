// spec/markets/economy.md, "Initial grants are single-use, balances stay non-negative, and blocked purchases never commit"

lemma EconomyFilterBridge(e: EconomyState)
  ensures alwaysEconomyInvariantsHold(e) == ((((e.washingtonFreePlayCount >= 0) && !(e.lastPurchaseWasWashington)) && !(e.lastPurchaseWasMcp)) && !((exists p :: p in e.players && !(((((((p.cashCents >= 0) && (p.positionValueCents >= 0)) && (p.purchasedCents >= 0)) && (p.verified == (p.grantClaimed && (p.startingGrantCents == INITIAL_GRANT_CENTS)))) && (!(!(p.verified)) || ((((!(p.grantClaimed) && (p.cashCents == 0)) && (p.positionValueCents == 0)) && (p.startingGrantCents == 0)) && (p.purchasedCents == 0)))) && (|ProofLib.Filter((q: PlayerLedger) => (q.id == p.id), e.players)| == 1))))))
{
}

lemma EconomyDistinctIds(e: EconomyState)
  requires alwaysEconomyInvariantsHold(e)
  ensures ProofLib.DistinctBy(e.players, (p: PlayerLedger) => p.id)
{
  EconomyFilterBridge(e);
  forall i, j | 0 <= i < |e.players| && 0 <= j < |e.players| && i != j
    ensures e.players[i].id != e.players[j].id
  {
    var p := e.players[i];
    assert p in e.players;
    ProofLib.FilterCountOneIffUnique((q: PlayerLedger) => (q.id == p.id), e.players, (q: PlayerLedger) => q.id, i);
  }
}

lemma FoldPlayerForAbsent(xs: seq<PlayerLedger>, acc: PlayerLedger, playerId: string)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != playerId
  ensures Std.Collections.Seq.FoldLeft((found: PlayerLedger, p: PlayerLedger) => (if (p.id == playerId) then p else found), acc, xs) == acc
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FoldPlayerForAbsent(xs[1..], acc, playerId);
  }
}

lemma FoldPlayerForAt(xs: seq<PlayerLedger>, acc: PlayerLedger, playerId: string, idx: int)
  requires 0 <= idx < |xs| && xs[idx].id == playerId
  requires forall j :: idx < j < |xs| ==> xs[j].id != playerId
  ensures Std.Collections.Seq.FoldLeft((found: PlayerLedger, p: PlayerLedger) => (if (p.id == playerId) then p else found), acc, xs) == xs[idx]
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldPlayerForAbsent(xs[1..], xs[0], playerId);
  } else {
    assert xs[1..][idx - 1] == xs[idx];
    assert forall j :: idx - 1 < j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldPlayerForAt(xs[1..], if xs[0].id == playerId then xs[0] else acc, playerId, idx - 1);
  }
}

lemma PlayerForAt(e: EconomyState, idx: int)
  requires alwaysEconomyInvariantsHold(e)
  requires 0 <= idx < |e.players|
  ensures playerFor(e, e.players[idx].id) == e.players[idx]
{
  EconomyDistinctIds(e);
  FoldPlayerForAt(e.players, emptyPlayer, e.players[idx].id, idx);
}

lemma LeaderboardFilterBridge(e: EconomyState, playerId: string)
  ensures leaderboardRank(e, playerId) == (var local_0 := playerFor(e, playerId); if !(local_0.verified) then 0 else (1 + |ProofLib.Filter((q: PlayerLedger) => (q.verified && (netProfitCents(q) > netProfitCents(local_0))), e.players)|))
{
}

lemma verifyAndGrant_ensures(e: EconomyState, playerId: string)
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> alwaysEconomyInvariantsHold(verifyAndGrant(e, playerId)))
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> stepNoFreeRefillsWhenBroke(e, "verifyAndGrant", verifyAndGrant(e, playerId)))
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> stepStartingGrantGrantedAtMostOnce(e, verifyAndGrant(e, playerId)))
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> stepPurchaseNeverChangesNetProfitOrRank(e, "verifyAndGrant", verifyAndGrant(e, playerId)))
{
  if inv(e) && canVerifyAndGrant(e, playerId) {
    var after := verifyAndGrant(e, playerId);
    EconomyFilterBridge(e);
    EconomyFilterBridge(after);
    forall i | 0 <= i < |after.players|
      ensures |ProofLib.Filter((q: PlayerLedger) => (q.id == after.players[i].id), after.players)| == 1
      ensures after.players[i].id == e.players[i].id
      ensures e.players[i].id == playerId ==> e.players[i] == playerFor(e, playerId)
    {
      var b := e.players[i];
      var a := after.players[i];
      assert b in e.players;
      ProofLib.FilterLengthPointwise((q: PlayerLedger) => (q.id == a.id), (q: PlayerLedger) => (q.id == b.id), after.players, e.players);
      if b.id == playerId {
        PlayerForAt(e, i);
      }
    }
    forall a | a in after.players
      ensures (exists b :: b in e.players && ((b.id == a.id) && (!((b.verified && (equityCents(b) == 0))) || (equityCents(a) == 0))))
    {
      var i :| 0 <= i < |after.players| && after.players[i] == a;
      assert e.players[i] in e.players;
    }
  }
}

lemma buyPoints_ensures(e: EconomyState, playerId: string, pack: PurchasePack, channel: PurchaseChannel, geo: GeoCheck)
  ensures (inv(e) ==> canBuyPoints(e, playerId, pack, channel, geo) ==> alwaysEconomyInvariantsHold(buyPoints(e, playerId, pack, channel, geo)))
  ensures (inv(e) ==> canBuyPoints(e, playerId, pack, channel, geo) ==> stepNoFreeRefillsWhenBroke(e, "buyPoints", buyPoints(e, playerId, pack, channel, geo)))
  ensures (inv(e) ==> canBuyPoints(e, playerId, pack, channel, geo) ==> stepStartingGrantGrantedAtMostOnce(e, buyPoints(e, playerId, pack, channel, geo)))
  ensures (inv(e) ==> canBuyPoints(e, playerId, pack, channel, geo) ==> stepPurchaseNeverChangesNetProfitOrRank(e, "buyPoints", buyPoints(e, playerId, pack, channel, geo)))
{
  if inv(e) && canBuyPoints(e, playerId, pack, channel, geo) {
    var after := buyPoints(e, playerId, pack, channel, geo);
    EconomyFilterBridge(e);
    EconomyFilterBridge(after);
    forall i | 0 <= i < |after.players|
      ensures |ProofLib.Filter((q: PlayerLedger) => (q.id == after.players[i].id), after.players)| == 1
      ensures after.players[i].id == e.players[i].id
      ensures netProfitCents(after.players[i]) == netProfitCents(e.players[i])
      ensures after.players[i].verified == e.players[i].verified
      ensures e.players[i].id == playerId ==> e.players[i] == playerFor(e, playerId)
    {
      var b := e.players[i];
      var a := after.players[i];
      assert b in e.players;
      ProofLib.FilterLengthPointwise((q: PlayerLedger) => (q.id == a.id), (q: PlayerLedger) => (q.id == b.id), after.players, e.players);
      if b.id == playerId {
        PlayerForAt(e, i);
      }
    }
    assert alwaysEconomyInvariantsHold(after);
    forall a | a in after.players
      ensures (exists b :: b in e.players && (((b.id == a.id) && (netProfitCents(a) == netProfitCents(b))) && (leaderboardRank(after, a.id) == leaderboardRank(e, a.id))))
    {
      var i :| 0 <= i < |after.players| && after.players[i] == a;
      var b := e.players[i];
      assert b in e.players;
      PlayerForAt(e, i);
      PlayerForAt(after, i);
      LeaderboardFilterBridge(e, a.id);
      LeaderboardFilterBridge(after, a.id);
      var ta := playerFor(after, a.id);
      var tb := playerFor(e, a.id);
      assert ta == a && tb == b;
      ProofLib.FilterLengthPointwise(
        (q: PlayerLedger) => (q.verified && (netProfitCents(q) > netProfitCents(ta))),
        (q: PlayerLedger) => (q.verified && (netProfitCents(q) > netProfitCents(tb))),
        after.players,
        e.players
      );
    }
  }
}

lemma playTrade_ensures(e: EconomyState, playerId: string, cashDeltaCents: int, newPosValueCents: int, geo: GeoCheck)
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents, geo) ==> alwaysEconomyInvariantsHold(playTrade(e, playerId, cashDeltaCents, newPosValueCents, geo)))
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents, geo) ==> stepNoFreeRefillsWhenBroke(e, "playTrade", playTrade(e, playerId, cashDeltaCents, newPosValueCents, geo)))
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents, geo) ==> stepStartingGrantGrantedAtMostOnce(e, playTrade(e, playerId, cashDeltaCents, newPosValueCents, geo)))
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents, geo) ==> stepPurchaseNeverChangesNetProfitOrRank(e, "playTrade", playTrade(e, playerId, cashDeltaCents, newPosValueCents, geo)))
{
  if inv(e) && canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents, geo) {
    var after := playTrade(e, playerId, cashDeltaCents, newPosValueCents, geo);
    EconomyFilterBridge(e);
    EconomyFilterBridge(after);
    forall i | 0 <= i < |after.players|
      ensures |ProofLib.Filter((q: PlayerLedger) => (q.id == after.players[i].id), after.players)| == 1
      ensures after.players[i].id == e.players[i].id
      ensures e.players[i].id == playerId ==> e.players[i] == playerFor(e, playerId)
    {
      var b := e.players[i];
      var a := after.players[i];
      assert b in e.players;
      ProofLib.FilterLengthPointwise((q: PlayerLedger) => (q.id == a.id), (q: PlayerLedger) => (q.id == b.id), after.players, e.players);
      if b.id == playerId {
        PlayerForAt(e, i);
      }
    }
    forall a | a in after.players
      ensures (exists b :: b in e.players && ((b.id == a.id) && (!((b.verified && (equityCents(b) == 0))) || (equityCents(a) == 0))))
    {
      var i :| 0 <= i < |after.players| && after.players[i] == a;
      assert e.players[i] in e.players;
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  EconomyFilterBridge(s);
  ProofLib.FilterOne((q: PlayerLedger) => (q.id == s.players[0].id), s.players, 0);
  ProofLib.FilterOne((q: PlayerLedger) => (q.id == s.players[1].id), s.players, 1);
}
