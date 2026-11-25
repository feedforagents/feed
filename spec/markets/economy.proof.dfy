// spec/markets/economy.md, "Initial grants are fixed at 100 pts, balances stay non-negative, and net profit excludes only the starting grant"

lemma EconomyFilterBridge(e: EconomyState)
  ensures alwaysEconomyInvariantsHold(e) == !((exists p :: p in e.players && !(((((((p.cashCents >= 0) && (p.positionValueCents >= 0)) && (p.verified == (p.grantClaimed && (p.startingGrantCents == INITIAL_GRANT_CENTS)))) && (!(p.verified) || (netProfitCents(p) == (equityCents(p) - INITIAL_GRANT_CENTS)))) && (!(!(p.verified)) || (((!(p.grantClaimed) && (p.cashCents == 0)) && (p.positionValueCents == 0)) && (p.startingGrantCents == 0)))) && (|ProofLib.Filter((q: PlayerLedger) => (q.id == p.id), e.players)| == 1)))))
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

lemma verifyAndGrant_ensures(e: EconomyState, playerId: string)
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> alwaysEconomyInvariantsHold(verifyAndGrant(e, playerId)))
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> stepNoRefillsOrCapitalInjectionsWhenBroke(e, verifyAndGrant(e, playerId)))
  ensures (inv(e) ==> canVerifyAndGrant(e, playerId) ==> stepStartingGrantFixedAt100Pts(e, verifyAndGrant(e, playerId)))
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
      ensures (exists b :: b in e.players && (((b.id == a.id) && (!(b.grantClaimed) || (a.grantClaimed && (a.startingGrantCents == INITIAL_GRANT_CENTS)))) && (!(!(b.grantClaimed)) || ((a.startingGrantCents == 0) || (a.startingGrantCents == INITIAL_GRANT_CENTS)))))
    {
      var i :| 0 <= i < |after.players| && after.players[i] == a;
      assert e.players[i] in e.players;
    }
  }
}

lemma playTrade_ensures(e: EconomyState, playerId: string, cashDeltaCents: int, newPosValueCents: int)
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents) ==> alwaysEconomyInvariantsHold(playTrade(e, playerId, cashDeltaCents, newPosValueCents)))
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents) ==> stepNoRefillsOrCapitalInjectionsWhenBroke(e, playTrade(e, playerId, cashDeltaCents, newPosValueCents)))
  ensures (inv(e) ==> canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents) ==> stepStartingGrantFixedAt100Pts(e, playTrade(e, playerId, cashDeltaCents, newPosValueCents)))
{
  if inv(e) && canPlayTrade(e, playerId, cashDeltaCents, newPosValueCents) {
    var after := playTrade(e, playerId, cashDeltaCents, newPosValueCents);
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
      ensures (exists b :: b in e.players && (((b.id == a.id) && (!(b.grantClaimed) || (a.grantClaimed && (a.startingGrantCents == INITIAL_GRANT_CENTS)))) && (!(!(b.grantClaimed)) || ((a.startingGrantCents == 0) || (a.startingGrantCents == INITIAL_GRANT_CENTS)))))
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
  assert s.players[1..] == [s.players[1]];
  assert [s.players[1]][1..] == [];
  assert forall p :: p in s.players ==> p == s.players[0] || p == s.players[1];
  assert netProfitCents(s.players[1]) == equityCents(s.players[1]) - INITIAL_GRANT_CENTS;
}
