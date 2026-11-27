// spec/markets/prediction.md, "Pool reserves remain strictly positive and satisfy the constant-product bound"
// spec/markets/prediction.md, "Account balances, shares, liquidity, and costs never go negative"
// spec/markets/prediction.md, "The fee ledger always equals the exact sum of charged fees"

lemma DivNonNegAndBound(a: int, b: int)
  requires a >= 0 && b > 0
  ensures a / b >= 0
  ensures (a / b) * b <= a
{
  hide *;
  var q := a / b;
  var r := a % b;
  assert q * b + r == a;
  assert 0 <= r < b;
  if q < 0 {
    assert q <= -1;
    assert q * b <= -b;
    assert q * b + r < 0;
  }
}

lemma CeilDivMulGe(numer: int, denom: int)
  requires numer >= 0 && denom > 0
  ensures shared__money_ceilDiv(numer, denom) >= 0
  ensures shared__money_ceilDiv(numer, denom) * denom >= numer
{
  hide *;
  reveal shared__money_ceilDiv, shared__money_quotient_shared__money, JSFloorDiv, MathAbs;
  var a := (numer + denom) - 1;
  DivNonNegAndBound(a, denom);
  var q := a / denom;
  assert shared__money_ceilDiv(numer, denom) == q;
  assert q * denom + (a % denom) == a;
  assert 0 <= a % denom < denom;
}

lemma CanonicalTradingFeeNonNeg(settledNotional: int)
  ensures shared__money_canonicalTradingFee(settledNotional) >= 0
{
  hide *;
  reveal shared__money_canonicalTradingFee, shared__money_canonicalTradingFeeAtBps, shared__money_TRADING_FEE_BPS, shared__money_BPS_DENOMINATOR;
  if settledNotional > 0 {
    CeilDivMulGe(settledNotional * shared__money_TRADING_FEE_BPS, shared__money_BPS_DENOMINATOR);
  }
}

lemma FloorCentsBounds(numer: int, denom: int)
  requires numer >= 0 && denom > 0
  ensures shared__money_floorCents(numer, denom) >= 0
  ensures shared__money_floorCents(numer, denom) * denom <= numer
{
  hide *;
  reveal shared__money_floorCents, shared__money_quotient_shared__money, JSFloorDiv, MathAbs;
  DivNonNegAndBound(numer, denom);
  assert shared__money_floorCents(numer, denom) == numer / denom;
}

lemma QuotientBounds(a: int, b: int)
  requires a >= 0 && b > 0
  ensures quotient_markets__prediction(a, b) >= 0
  ensures quotient_markets__prediction(a, b) * b <= a
{
  hide *;
  reveal quotient_markets__prediction, JSFloorDiv, MathAbs;
  DivNonNegAndBound(a, b);
  assert quotient_markets__prediction(a, b) == a / b;
}

lemma BalancesFilterBridge(m: PredictionMarket)
  ensures alwaysBalancesAndPositionsNonNegative(m) == ((((((((m.liquidityCents >= 0) && (m.totalPayoutCents >= 0)) && (m.totalRefundedCents >= 0)) && (m.replayCount >= 0)) && (m.totalSells >= 0)) && (m.now >= 0)) && (!((!m.phase.PendingOpen?)) || (m.closeAt > 0))) && !((exists a :: a in m.accounts && !(((((((a.balanceCents >= 0) && (a.yesShares >= 0)) && (a.noShares >= 0)) && (a.yesCostCents >= 0)) && (a.noCostCents >= 0)) && (|ProofLib.Filter((b: TraderAccount) => (b.id == a.id), m.accounts)| == 1))))))
{
  hide *;
  reveal alwaysBalancesAndPositionsNonNegative, ProofLib.Filter;
}

lemma AccountsDistinctIds(m: PredictionMarket)
  requires alwaysBalancesAndPositionsNonNegative(m)
  ensures ProofLib.DistinctBy(m.accounts, (a: TraderAccount) => a.id)
{
  BalancesFilterBridge(m);
  forall i, j | 0 <= i < |m.accounts| && 0 <= j < |m.accounts| && i != j
    ensures m.accounts[i].id != m.accounts[j].id
  {
    var a := m.accounts[i];
    assert a in m.accounts;
    ProofLib.FilterCountOneIffUnique((b: TraderAccount) => (b.id == a.id), m.accounts, (b: TraderAccount) => b.id, i);
  }
}

lemma FoldAccountForAbsent(xs: seq<TraderAccount>, acc: TraderAccount, traderId: string)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != traderId
  ensures Std.Collections.Seq.FoldLeft((found: TraderAccount, a: TraderAccount) => (if (a.id == traderId) then a else found), acc, xs) == acc
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FoldAccountForAbsent(xs[1..], acc, traderId);
  }
}

lemma FoldAccountForAt(xs: seq<TraderAccount>, acc: TraderAccount, traderId: string, idx: int)
  requires 0 <= idx < |xs| && xs[idx].id == traderId
  requires forall j :: idx < j < |xs| ==> xs[j].id != traderId
  ensures Std.Collections.Seq.FoldLeft((found: TraderAccount, a: TraderAccount) => (if (a.id == traderId) then a else found), acc, xs) == xs[idx]
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldAccountForAbsent(xs[1..], xs[0], traderId);
  } else {
    assert xs[1..][idx - 1] == xs[idx];
    assert forall j :: idx - 1 < j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldAccountForAt(xs[1..], if xs[0].id == traderId then xs[0] else acc, traderId, idx - 1);
  }
}

lemma AccountForAt(m: PredictionMarket, idx: int)
  requires alwaysBalancesAndPositionsNonNegative(m)
  requires 0 <= idx < |m.accounts|
  ensures accountFor(m, m.accounts[idx].id) == m.accounts[idx]
{
  AccountsDistinctIds(m);
  FoldAccountForAt(m.accounts, emptyAccount(m.accounts[idx].id), m.accounts[idx].id, idx);
}

lemma FoldPayoutsNonNeg(init: int, xs: seq<TraderAccount>, winner: Side)
  requires init >= 0
  requires forall a :: a in xs ==> a.yesShares >= 0 && a.noShares >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => (if a.settledOnClose then acc else (acc + (if winner.Yes? then a.yesShares else a.noShares))), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall a :: a in xs[1..] ==> a in xs;
    var shares := if winner.Yes? then xs[0].yesShares else xs[0].noShares;
    var next := if xs[0].settledOnClose then init else (init + shares);
    FoldPayoutsNonNeg(next, xs[1..], winner);
  }
}

lemma FoldRefundsNonNeg(init: int, xs: seq<TraderAccount>)
  requires init >= 0
  requires forall a :: a in xs ==> a.yesCostCents >= 0 && a.noCostCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => (if a.settledOnClose then acc else ((acc + a.yesCostCents) + a.noCostCents)), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall a :: a in xs[1..] ==> a in xs;
    var next := if xs[0].settledOnClose then init else ((init + xs[0].yesCostCents) + xs[0].noCostCents);
    FoldRefundsNonNeg(next, xs[1..]);
  }
}

lemma SellPreservesConstantProduct(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysConstantProductPreserved(sell(m, traderId, side, sellShares))
{
  hide *;
  reveal canSell, sell, alwaysConstantProductPreserved;
}

lemma InvImpliesBalances(m: PredictionMarket)
  requires inv(m)
  ensures alwaysBalancesAndPositionsNonNegative(m)
{
  hide *;
  reveal inv;
}

lemma SellAccountPreservesNonNeg(a: TraderAccount, side: Side, sellShares: int, netCredit: int)
  requires a.balanceCents >= 0 && a.yesShares >= 0 && a.noShares >= 0 && a.yesCostCents >= 0 && a.noCostCents >= 0
  requires netCredit >= 0
  ensures var a' := sellAccountUpdate(a, side, sellShares, netCredit);
    a'.id == a.id && a'.balanceCents >= 0 && a'.yesShares >= 0 && a'.noShares >= 0 && a'.yesCostCents >= 0 && a'.noCostCents >= 0
{
  hide *;
  reveal sellAccountUpdate, heldSharesFor, heldCostFor, shared__money_clampMin0;
  var held := heldSharesFor(a, side);
  var prevCost := heldCostFor(a, side);
  var remaining := shared__money_clampMin0(held - sellShares);
  if held > 0 && remaining > 0 {
    QuotientBounds(prevCost * remaining, held);
  }
}

lemma SellPreservesBalances(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysBalancesAndPositionsNonNegative(sell(m, traderId, side, sellShares))
{
  hide *;
  reveal canSell, sell, shared__money_sellNetProceeds, shared__money_clampMin0;
  InvImpliesBalances(m);
  var after := sell(m, traderId, side, sellShares);
  var settledCents := cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares);
  var netCredit := shared__money_sellNetProceeds(settledCents);
  CanonicalTradingFeeNonNeg(settledCents);
  assert netCredit >= 0;
  BalancesFilterBridge(m);
  BalancesFilterBridge(after);
  forall i | 0 <= i < |after.accounts|
    ensures |ProofLib.Filter((b: TraderAccount) => (b.id == after.accounts[i].id), after.accounts)| == 1
    ensures after.accounts[i].balanceCents >= 0
    ensures after.accounts[i].yesShares >= 0 && after.accounts[i].noShares >= 0
    ensures after.accounts[i].yesCostCents >= 0 && after.accounts[i].noCostCents >= 0
  {
    var a := m.accounts[i];
    var a' := after.accounts[i];
    assert a in m.accounts;
    if a.id == traderId {
      SellAccountPreservesNonNeg(a, side, sellShares, netCredit);
    }
    forall j | 0 <= j < |m.accounts|
      ensures after.accounts[j].id == m.accounts[j].id
    {
      if m.accounts[j].id == traderId {
        assert m.accounts[j] in m.accounts;
        SellAccountPreservesNonNeg(m.accounts[j], side, sellShares, netCredit);
      }
    }
    ProofLib.FilterLengthPointwise((b: TraderAccount) => (b.id == a'.id), (b: TraderAccount) => (b.id == a.id), after.accounts, m.accounts);
  }
}

lemma SellPreservesFees(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysFeeLedgerReconciles(sell(m, traderId, side, sellShares))
{
  hide *;
  reveal inv, alwaysFeeLedgerReconciles, canSell, sell;
  var settledCents := cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares);
  var fee := shared__money_canonicalTradingFee(settledCents);
  CanonicalTradingFeeNonNeg(settledCents);
  ProofLib.FoldLeftAppend((acc: int, f: int) => (acc + f), 0, m.chargedFees, fee);
}

lemma SellPreservesRest(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysReservesPositive(sell(m, traderId, side, sellShares))
  ensures alwaysHiddenOutcomeNeverVisibleBeforeResolution(sell(m, traderId, side, sellShares))
  ensures alwaysSettledAccountsHaveZeroOpenShares(sell(m, traderId, side, sellShares))
  ensures stepNoTradesOutsideOpenWindow(m, "sell", sell(m, traderId, side, sellShares))
  ensures stepManualHoldBlocksResolution(m, "sell", sell(m, traderId, side, sellShares))
  ensures stepDuplicateResolutionIsIdempotent(m, "sell", sell(m, traderId, side, sellShares))
  ensures stepTerminalPhasesStayTerminal(m, sell(m, traderId, side, sellShares))
{
  hide *;
  reveal inv, alwaysReservesPositive, alwaysHiddenOutcomeNeverVisibleBeforeResolution, alwaysSettledAccountsHaveZeroOpenShares, stepNoTradesOutsideOpenWindow, stepManualHoldBlocksResolution, stepDuplicateResolutionIsIdempotent, stepTerminalPhasesStayTerminal, canSell, sell, sellAccountUpdate;
}

lemma buy_ensures(m: PredictionMarket, traderId: string, side: Side, amountCents: int)
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysReservesPositive(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysConstantProductPreserved(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysBalancesAndPositionsNonNegative(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysFeeLedgerReconciles(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysSettledAccountsHaveZeroOpenShares(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepNoTradesOutsideOpenWindow(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepManualHoldBlocksResolution(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepDuplicateResolutionIsIdempotent(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepTerminalPhasesStayTerminal(m, buy(m, traderId, side, amountCents)))
{
  if inv(m) && canBuy(m, traderId, side, amountCents) {
    var after := buy(m, traderId, side, amountCents);
    var fee := shared__money_canonicalTradingFee(amountCents);
    var netCents := shared__money_buyNetAfterFee(amountCents);
    CanonicalTradingFeeNonNeg(amountCents);
    assert netCents <= amountCents;
    if side.Yes? {
      CeilDivMulGe(m.yesReserve * m.noReserve, m.noReserve + netCents);
    } else {
      CeilDivMulGe(m.yesReserve * m.noReserve, m.yesReserve + netCents);
    }
    BalancesFilterBridge(m);
    BalancesFilterBridge(after);
    AccountsDistinctIds(m);
    ProofLib.FoldLeftAppend((acc: int, f: int) => (acc + f), 0, m.chargedFees, fee);
    forall i | 0 <= i < |after.accounts|
      ensures |ProofLib.Filter((b: TraderAccount) => (b.id == after.accounts[i].id), after.accounts)| == 1
      ensures m.accounts[i].id == traderId ==> m.accounts[i] == accountFor(m, traderId)
    {
      var a := m.accounts[i];
      var a' := after.accounts[i];
      assert a in m.accounts;
      ProofLib.FilterLengthPointwise((b: TraderAccount) => (b.id == a'.id), (b: TraderAccount) => (b.id == a.id), after.accounts, m.accounts);
      if a.id == traderId {
        AccountForAt(m, i);
      }
    }
  }
}

lemma sell_ensures(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysReservesPositive(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysConstantProductPreserved(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysBalancesAndPositionsNonNegative(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysFeeLedgerReconciles(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysSettledAccountsHaveZeroOpenShares(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepNoTradesOutsideOpenWindow(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepManualHoldBlocksResolution(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepDuplicateResolutionIsIdempotent(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepTerminalPhasesStayTerminal(m, sell(m, traderId, side, sellShares)))
{
  hide *;
  if inv(m) && canSell(m, traderId, side, sellShares) {
    SellPreservesConstantProduct(m, traderId, side, sellShares);
    SellPreservesBalances(m, traderId, side, sellShares);
    SellPreservesFees(m, traderId, side, sellShares);
    SellPreservesRest(m, traderId, side, sellShares);
  }
}

lemma replayResolution_ensures(m: PredictionMarket)
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysReservesPositive(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysConstantProductPreserved(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysBalancesAndPositionsNonNegative(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysFeeLedgerReconciles(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysSettledAccountsHaveZeroOpenShares(replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> stepNoTradesOutsideOpenWindow(m, "replayResolution", replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> stepManualHoldBlocksResolution(m, "replayResolution", replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> stepDuplicateResolutionIsIdempotent(m, "replayResolution", replayResolution(m)))
  ensures (inv(m) ==> canReplayResolution(m) ==> stepTerminalPhasesStayTerminal(m, replayResolution(m)))
{
  if inv(m) && canReplayResolution(m) {
    var after := replayResolution(m);
    assert after.accounts == m.accounts;
  }
}

lemma resolveMarket_ensures(m: PredictionMarket)
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysReservesPositive(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysConstantProductPreserved(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysBalancesAndPositionsNonNegative(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysFeeLedgerReconciles(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysSettledAccountsHaveZeroOpenShares(resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> stepNoTradesOutsideOpenWindow(m, "resolveMarket", resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> stepManualHoldBlocksResolution(m, "resolveMarket", resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> stepDuplicateResolutionIsIdempotent(m, "resolveMarket", resolveMarket(m)))
  ensures (inv(m) ==> canResolveMarket(m) ==> stepTerminalPhasesStayTerminal(m, resolveMarket(m)))
{
  if inv(m) && canResolveMarket(m) {
    var after := resolveMarket(m);
    var winner := declassifyOutcome(m.secretOutcome);
    BalancesFilterBridge(m);
    BalancesFilterBridge(after);
    FoldPayoutsNonNeg(0, m.accounts, winner);
    forall i | 0 <= i < |after.accounts|
      ensures |ProofLib.Filter((b: TraderAccount) => (b.id == after.accounts[i].id), after.accounts)| == 1
      ensures after.accounts[i].balanceCents >= 0
    {
      var a := m.accounts[i];
      var a' := after.accounts[i];
      assert a in m.accounts;
      ProofLib.FilterLengthPointwise((b: TraderAccount) => (b.id == a'.id), (b: TraderAccount) => (b.id == a.id), after.accounts, m.accounts);
    }
  }
}

lemma cancelMarket_ensures(m: PredictionMarket)
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysReservesPositive(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysConstantProductPreserved(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysBalancesAndPositionsNonNegative(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysFeeLedgerReconciles(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysSettledAccountsHaveZeroOpenShares(cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> stepNoTradesOutsideOpenWindow(m, "cancelMarket", cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> stepManualHoldBlocksResolution(m, "cancelMarket", cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> stepDuplicateResolutionIsIdempotent(m, "cancelMarket", cancelMarket(m)))
  ensures (inv(m) ==> canCancelMarket(m) ==> stepTerminalPhasesStayTerminal(m, cancelMarket(m)))
{
  if inv(m) && canCancelMarket(m) {
    var after := cancelMarket(m);
    BalancesFilterBridge(m);
    BalancesFilterBridge(after);
    FoldRefundsNonNeg(0, m.accounts);
    forall i | 0 <= i < |after.accounts|
      ensures |ProofLib.Filter((b: TraderAccount) => (b.id == after.accounts[i].id), after.accounts)| == 1
    {
      var a := m.accounts[i];
      var a' := after.accounts[i];
      assert a in m.accounts;
      ProofLib.FilterLengthPointwise((b: TraderAccount) => (b.id == a'.id), (b: TraderAccount) => (b.id == a.id), after.accounts, m.accounts);
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  BalancesFilterBridge(s);
  ProofLib.FilterOne((b: TraderAccount) => (b.id == s.accounts[0].id), s.accounts, 0);
  ProofLib.FilterOne((b: TraderAccount) => (b.id == s.accounts[1].id), s.accounts, 1);
  assert s.accounts[1..] == [s.accounts[1]];
  assert [s.accounts[1]][1..] == [];
}
