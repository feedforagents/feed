// spec/markets/spotPerp.md, "Spot reserves and prices stay positive, and open interest is non-negative and matches positions"
// spec/markets/spotPerp.md, "Every position obeys the 20x leverage cap and unique ownership, and all balances are non-negative"
// spec/markets/spotPerp.md, "Funding claims are post-cutover, bounded by monotonic lastFundingPeriod, and unique per position and period"
// spec/markets/spotPerp.md, "Only NPCs execute spot trades, perp trades never move spot or index, and funding periods advance monotonically"

lemma CeilDivMulGe(numer: int, denom: int)
  requires numer >= 0 && denom > 0
  ensures shared__money_ceilDiv(numer, denom) >= 0
  ensures shared__money_ceilDiv(numer, denom) * denom >= numer
{
  var a := (numer + denom) - 1;
  var q := a / denom;
  assert shared__money_ceilDiv(numer, denom) == q;
  assert q * denom + (a % denom) == a;
  assert 0 <= a % denom < denom;
}

lemma CanonicalTradingFeeNonNeg(settledNotional: int)
  ensures shared__money_canonicalTradingFee(settledNotional) >= 0
{
  if settledNotional > 0 {
    CeilDivMulGe(settledNotional * shared__money_TRADING_FEE_BPS, shared__money_BPS_DENOMINATOR);
  }
}

lemma FundingPeriodIndexMonotonic(h1: int, h2: int)
  requires 0 <= h1 <= h2
  ensures shared__time_fundingPeriodIndex(h1) <= shared__time_fundingPeriodIndex(h2)
{
  if h1 == 0 {
    assert shared__time_fundingPeriodIndex(0) == 0;
    if h2 > 0 {
      assert shared__time_fundingPeriodIndex(h2) == h2 / shared__time_FUNDING_PERIOD_HOURS;
    }
  } else {
    assert shared__time_fundingPeriodIndex(h1) == h1 / shared__time_FUNDING_PERIOD_HOURS;
    assert shared__time_fundingPeriodIndex(h2) == h2 / shared__time_FUNDING_PERIOD_HOURS;
  }
}

lemma PositionsFilterBridge(m: SpotPerpMarket)
  ensures alwaysPositionsWithin20xAndUnique(m) == (((((((((m.nextPosId >= 0) && (m.currentHour >= 0)) && (m.currentPeriod == shared__time_fundingPeriodIndex(m.currentHour))) && (m.cutoverPeriod >= 1)) && (m.npcSpotBase >= 0)) && (m.liquidationCount >= 0)) && (m.feeLedgerCents >= 0)) && !((exists a :: a in m.accounts && !(((a.balanceCents >= 0) && (|ProofLib.Filter((b: SpotPerpAccount) => (b.id == a.id), m.accounts)| == 1)))))) && !((exists p :: p in m.positions && !(((((((((((((p.posId >= 1) && (p.posId <= m.nextPosId)) && (1 <= p.leverage)) && (p.leverage <= MAX_LEVERAGE)) && (p.sizeCents >= MIN_ORDER_SIZE_CENTS)) && (p.marginCents == shared__money_ceilDiv(p.sizeCents, p.leverage))) && (p.entryPriceCents > 0)) && (p.openedPeriod >= 0)) && (p.lastFundingPeriod >= p.openedPeriod)) && (p.lastFundingPeriod <= m.currentPeriod)) && (|ProofLib.Filter((q: PerpPosition) => (q.posId == p.posId), m.positions)| == 1)) && (|ProofLib.Filter((q: PerpPosition) => (q.owner == p.owner), m.positions)| == 1))))))
{
}

lemma FundingFilterBridge(m: SpotPerpMarket)
  ensures alwaysFundingAccruedAtMostOncePerPeriod(m) == ((!((exists c :: c in m.fundingClaims && !((((((c.posId >= 1) && (c.posId <= m.nextPosId)) && (c.period >= m.cutoverPeriod)) && (c.period <= m.currentPeriod)) && (|ProofLib.Filter((d: FundingClaim) => ((d.posId == c.posId) && (d.period == c.period)), m.fundingClaims)| == 1))))) && !((exists p :: p in m.positions && !(!((exists c :: c in m.fundingClaims && !((!((c.posId == p.posId)) || (c.period <= p.lastFundingPeriod))))))))))
{
}

lemma ClosePerpPositionsBridge(m: SpotPerpMarket, traderId: string, by_: Sender)
  ensures closePerp(m, traderId, by_).positions == ProofLib.Filter((p: PerpPosition) => (p.owner != traderId), m.positions)
{
}

lemma LiquidatePositionsBridge(m: SpotPerpMarket, traderId: string)
  ensures liquidate(m, traderId).positions == ProofLib.Filter((p: PerpPosition) => (p.owner != traderId), m.positions)
{
}

lemma AccrueFundingClaimsBridge(m: SpotPerpMarket, period: int)
  requires period >= m.cutoverPeriod
  ensures var eligible := ProofLib.Filter((p: PerpPosition) => ((period > p.openedPeriod) && (period > p.lastFundingPeriod)), m.positions);
    accrueFunding(m, period).fundingClaims == m.fundingClaims + seq(|eligible|, i_map requires 0 <= i_map < |eligible| => var p := eligible[i_map]; FundingClaim(p.posId, period))
{
}

lemma AccountsDistinctIds(m: SpotPerpMarket)
  requires alwaysPositionsWithin20xAndUnique(m)
  ensures ProofLib.DistinctBy(m.accounts, (a: SpotPerpAccount) => a.id)
{
  PositionsFilterBridge(m);
  forall i, j | 0 <= i < |m.accounts| && 0 <= j < |m.accounts| && i != j
    ensures m.accounts[i].id != m.accounts[j].id
  {
    var a := m.accounts[i];
    assert a in m.accounts;
    ProofLib.FilterCountOneIffUnique((b: SpotPerpAccount) => (b.id == a.id), m.accounts, (b: SpotPerpAccount) => b.id, i);
  }
}

lemma PositionsDistinctPosIds(m: SpotPerpMarket)
  requires alwaysPositionsWithin20xAndUnique(m)
  ensures ProofLib.DistinctBy(m.positions, (p: PerpPosition) => p.posId)
{
  PositionsFilterBridge(m);
  forall i, j | 0 <= i < |m.positions| && 0 <= j < |m.positions| && i != j
    ensures m.positions[i].posId != m.positions[j].posId
  {
    var p := m.positions[i];
    assert p in m.positions;
    ProofLib.FilterCountOneIffUnique((q: PerpPosition) => (q.posId == p.posId), m.positions, (q: PerpPosition) => q.posId, i);
  }
}

lemma PositionsDistinctOwners(m: SpotPerpMarket)
  requires alwaysPositionsWithin20xAndUnique(m)
  ensures ProofLib.DistinctBy(m.positions, (p: PerpPosition) => p.owner)
{
  PositionsFilterBridge(m);
  forall i, j | 0 <= i < |m.positions| && 0 <= j < |m.positions| && i != j
    ensures m.positions[i].owner != m.positions[j].owner
  {
    var p := m.positions[i];
    assert p in m.positions;
    ProofLib.FilterCountOneIffUnique((q: PerpPosition) => (q.owner == p.owner), m.positions, (q: PerpPosition) => q.owner, i);
  }
}

lemma ClaimsDistinct(m: SpotPerpMarket)
  requires alwaysFundingAccruedAtMostOncePerPeriod(m)
  ensures ProofLib.DistinctBy(m.fundingClaims, (c: FundingClaim) => c)
{
  FundingFilterBridge(m);
  forall i, j | 0 <= i < |m.fundingClaims| && 0 <= j < |m.fundingClaims| && i != j
    ensures m.fundingClaims[i] != m.fundingClaims[j]
  {
    var c := m.fundingClaims[i];
    assert c in m.fundingClaims;
    ProofLib.FilterCountOneIffUnique(
      (d: FundingClaim) => ((d.posId == c.posId) && (d.period == c.period)),
      m.fundingClaims,
      (d: FundingClaim) => d,
      i
    );
  }
}

lemma FoldSpotBalanceAbsent(xs: seq<SpotPerpAccount>, acc: int, traderId: string)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != traderId
  ensures Std.Collections.Seq.FoldLeft((bal: int, a: SpotPerpAccount) => (if (a.id == traderId) then a.balanceCents else bal), acc, xs) == acc
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FoldSpotBalanceAbsent(xs[1..], acc, traderId);
  }
}

lemma FoldSpotBalanceAt(xs: seq<SpotPerpAccount>, acc: int, traderId: string, idx: int)
  requires 0 <= idx < |xs| && xs[idx].id == traderId
  requires forall j :: idx < j < |xs| ==> xs[j].id != traderId
  ensures Std.Collections.Seq.FoldLeft((bal: int, a: SpotPerpAccount) => (if (a.id == traderId) then a.balanceCents else bal), acc, xs) == xs[idx].balanceCents
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldSpotBalanceAbsent(xs[1..], xs[0].balanceCents, traderId);
  } else {
    assert xs[1..][idx - 1] == xs[idx];
    assert forall j :: idx - 1 < j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FoldSpotBalanceAt(xs[1..], if xs[0].id == traderId then xs[0].balanceCents else acc, traderId, idx - 1);
  }
}

lemma SpotBalanceForAt(m: SpotPerpMarket, idx: int)
  requires alwaysPositionsWithin20xAndUnique(m)
  requires 0 <= idx < |m.accounts|
  ensures spotBalanceFor(m, m.accounts[idx].id) == m.accounts[idx].balanceCents
{
  AccountsDistinctIds(m);
  FoldSpotBalanceAt(m.accounts, 0, m.accounts[idx].id, idx);
}

lemma CreditBalanceKeepsIdsUnique(m: SpotPerpMarket, traderId: string, deltaCents: int)
  requires alwaysPositionsWithin20xAndUnique(m)
  ensures var accs := creditBalance(m.accounts, traderId, deltaCents);
    forall i :: 0 <= i < |accs| ==> |ProofLib.Filter((b: SpotPerpAccount) => (b.id == accs[i].id), accs)| == 1
{
  PositionsFilterBridge(m);
  var accs := creditBalance(m.accounts, traderId, deltaCents);
  forall i | 0 <= i < |accs|
    ensures |ProofLib.Filter((b: SpotPerpAccount) => (b.id == accs[i].id), accs)| == 1
  {
    var a := m.accounts[i];
    var a' := accs[i];
    assert a in m.accounts;
    ProofLib.FilterLengthPointwise((b: SpotPerpAccount) => (b.id == a'.id), (b: SpotPerpAccount) => (b.id == a.id), accs, m.accounts);
  }
}

lemma FoldLongOINonNeg(init: int, ps: seq<PerpPosition>)
  requires init >= 0
  requires forall p :: p in ps ==> p.sizeCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, p: PerpPosition) => (if p.perpSide.Long? then (acc + p.sizeCents) else acc), init, ps) >= init
  decreases |ps|
{
  if |ps| > 0 {
    assert ps[0] in ps;
    assert forall p :: p in ps[1..] ==> p in ps;
    FoldLongOINonNeg(if ps[0].perpSide.Long? then init + ps[0].sizeCents else init, ps[1..]);
  }
}

lemma FoldShortOINonNeg(init: int, ps: seq<PerpPosition>)
  requires init >= 0
  requires forall p :: p in ps ==> p.sizeCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, p: PerpPosition) => (if p.perpSide.Short? then (acc + p.sizeCents) else acc), init, ps) >= init
  decreases |ps|
{
  if |ps| > 0 {
    assert ps[0] in ps;
    assert forall p :: p in ps[1..] ==> p in ps;
    FoldShortOINonNeg(if ps[0].perpSide.Short? then init + ps[0].sizeCents else init, ps[1..]);
  }
}

lemma FilteredPositionsValid(m: SpotPerpMarket, traderId: string)
  requires alwaysPositionsWithin20xAndUnique(m)
  ensures var rem := ProofLib.Filter((p: PerpPosition) => (p.owner != traderId), m.positions);
    (forall p :: p in rem ==> p in m.positions) &&
    (forall p :: p in rem ==> |ProofLib.Filter((q: PerpPosition) => (q.posId == p.posId), rem)| == 1) &&
    (forall p :: p in rem ==> |ProofLib.Filter((q: PerpPosition) => (q.owner == p.owner), rem)| == 1)
{
  PositionsDistinctPosIds(m);
  PositionsDistinctOwners(m);
  var pred := (p: PerpPosition) => (p.owner != traderId);
  var rem := ProofLib.Filter(pred, m.positions);
  ProofLib.FilterKeepsDistinctBy(pred, m.positions, (p: PerpPosition) => p.posId);
  ProofLib.FilterKeepsDistinctBy(pred, m.positions, (p: PerpPosition) => p.owner);
  forall p | p in rem
    ensures p in m.positions
    ensures |ProofLib.Filter((q: PerpPosition) => (q.posId == p.posId), rem)| == 1
    ensures |ProofLib.Filter((q: PerpPosition) => (q.owner == p.owner), rem)| == 1
  {
    ProofLib.FilterMember(pred, m.positions, p);
    var i :| 0 <= i < |rem| && rem[i] == p;
    ProofLib.FilterCountOneIffUnique((q: PerpPosition) => (q.posId == p.posId), rem, (q: PerpPosition) => q.posId, i);
    ProofLib.FilterCountOneIffUnique((q: PerpPosition) => (q.owner == p.owner), rem, (q: PerpPosition) => q.owner, i);
  }
}

lemma AccrueFundingPreCutover(m: SpotPerpMarket, period: int)
  requires inv(m) && canAccrueFunding(m, period) && period < m.cutoverPeriod
  ensures alwaysOpenInterestMatchesPositions(accrueFunding(m, period))
  ensures alwaysSpotAndPricesConsistent(accrueFunding(m, period))
  ensures alwaysPositionsWithin20xAndUnique(accrueFunding(m, period))
  ensures alwaysFundingAccruedAtMostOncePerPeriod(accrueFunding(m, period))
  ensures stepOnlyNpcTradesSpot(m, "accrueFunding", accrueFunding(m, period))
  ensures stepPerpTradesLeaveSpotAndIndexUnchanged(m, "accrueFunding", accrueFunding(m, period))
  ensures stepFundingPeriodMonotonicAndCutoverGuarded(m, "accrueFunding", accrueFunding(m, period))
  ensures stepOpenFillsAtPostImpactMark(m, "accrueFunding", accrueFunding(m, period))
{
  PositionsDistinctPosIds(m);
}

lemma AccrueFundingOIAndPrices(m: SpotPerpMarket, period: int)
  requires alwaysOpenInterestMatchesPositions(m)
  requires alwaysSpotAndPricesConsistent(m)
  requires canAccrueFunding(m, period) && period >= m.cutoverPeriod
  ensures alwaysOpenInterestMatchesPositions(accrueFunding(m, period))
  ensures alwaysSpotAndPricesConsistent(accrueFunding(m, period))
  ensures stepOnlyNpcTradesSpot(m, "accrueFunding", accrueFunding(m, period))
  ensures stepPerpTradesLeaveSpotAndIndexUnchanged(m, "accrueFunding", accrueFunding(m, period))
  ensures stepOpenFillsAtPostImpactMark(m, "accrueFunding", accrueFunding(m, period))
{
  var after := accrueFunding(m, period);
  ProofLib.FoldLeftPointwise(
    (acc: int, p: PerpPosition) => (if p.perpSide.Long? then (acc + p.sizeCents) else acc),
    (acc: int, p: PerpPosition) => (if p.perpSide.Long? then (acc + p.sizeCents) else acc),
    0, after.positions, m.positions
  );
  ProofLib.FoldLeftPointwise(
    (acc: int, p: PerpPosition) => (if p.perpSide.Short? then (acc + p.sizeCents) else acc),
    (acc: int, p: PerpPosition) => (if p.perpSide.Short? then (acc + p.sizeCents) else acc),
    0, after.positions, m.positions
  );
}

lemma AccrueFundingPositions(m: SpotPerpMarket, period: int)
  requires alwaysPositionsWithin20xAndUnique(m)
  requires canAccrueFunding(m, period) && period >= m.cutoverPeriod
  ensures alwaysPositionsWithin20xAndUnique(accrueFunding(m, period))
  ensures stepFundingPeriodMonotonicAndCutoverGuarded(m, "accrueFunding", accrueFunding(m, period))
{
  var after := accrueFunding(m, period);
  PositionsFilterBridge(m);
  PositionsFilterBridge(after);
  PositionsDistinctPosIds(m);
  forall i | 0 <= i < |after.positions|
    ensures |ProofLib.Filter((q: PerpPosition) => (q.posId == after.positions[i].posId), after.positions)| == 1
    ensures |ProofLib.Filter((q: PerpPosition) => (q.owner == after.positions[i].owner), after.positions)| == 1
  {
    var p := m.positions[i];
    var p' := after.positions[i];
    assert p in m.positions;
    ProofLib.FilterLengthPointwise((q: PerpPosition) => (q.posId == p'.posId), (q: PerpPosition) => (q.posId == p.posId), after.positions, m.positions);
    ProofLib.FilterLengthPointwise((q: PerpPosition) => (q.owner == p'.owner), (q: PerpPosition) => (q.owner == p.owner), after.positions, m.positions);
  }
  forall p', q | p' in after.positions && q in m.positions && q.posId == p'.posId
    ensures p'.lastFundingPeriod >= q.lastFundingPeriod
  {
    var i :| 0 <= i < |after.positions| && after.positions[i] == p';
    var j :| 0 <= j < |m.positions| && m.positions[j] == q;
    assert i == j;
  }
}

lemma AccrueFundingClaims(m: SpotPerpMarket, period: int)
  requires alwaysPositionsWithin20xAndUnique(m)
  requires alwaysFundingAccruedAtMostOncePerPeriod(m)
  requires canAccrueFunding(m, period) && period >= m.cutoverPeriod
  ensures alwaysFundingAccruedAtMostOncePerPeriod(accrueFunding(m, period))
{
  var after := accrueFunding(m, period);
  PositionsDistinctPosIds(m);
  FundingFilterBridge(m);
  FundingFilterBridge(after);
  ClaimsDistinct(m);
  AccrueFundingClaimsBridge(m, period);
  var eligPred := (p: PerpPosition) => ((period > p.openedPeriod) && (period > p.lastFundingPeriod));
  var eligible := ProofLib.Filter(eligPred, m.positions);
  var newClaims := seq(|eligible|, i_map requires 0 <= i_map < |eligible| => var p := eligible[i_map]; FundingClaim(p.posId, period));
  assert after.fundingClaims == m.fundingClaims + newClaims;
  ProofLib.FilterKeepsDistinctBy(eligPred, m.positions, (p: PerpPosition) => p.posId);
  forall i | 0 <= i < |eligible|
    ensures eligible[i] in m.positions
    ensures period > eligible[i].openedPeriod && period > eligible[i].lastFundingPeriod
  {
    ProofLib.FilterMember(eligPred, m.positions, eligible[i]);
  }
  assert ProofLib.DistinctBy(newClaims, (c: FundingClaim) => c);
  forall c1, c2 | c1 in m.fundingClaims && c2 in newClaims
    ensures c1 != c2
  {
    var j :| 0 <= j < |newClaims| && newClaims[j] == c2;
    assert eligible[j] in m.positions;
  }
  ProofLib.DistinctByConcat(m.fundingClaims, newClaims, (c: FundingClaim) => c);
  forall i | 0 <= i < |after.fundingClaims|
    ensures |ProofLib.Filter((d: FundingClaim) => ((d.posId == after.fundingClaims[i].posId) && (d.period == after.fundingClaims[i].period)), after.fundingClaims)| == 1
  {
    var c := after.fundingClaims[i];
    ProofLib.FilterCountOneIffUnique(
      (d: FundingClaim) => ((d.posId == c.posId) && (d.period == c.period)),
      after.fundingClaims,
      (d: FundingClaim) => d,
      i
    );
  }
  forall p', c | p' in after.positions && c in after.fundingClaims && c.posId == p'.posId
    ensures c.period <= p'.lastFundingPeriod
  {
    var i :| 0 <= i < |after.positions| && after.positions[i] == p';
    var p := m.positions[i];
    assert p in m.positions;
    if c in newClaims {
      var j :| 0 <= j < |newClaims| && newClaims[j] == c;
      var eIdx :| 0 <= eIdx < |m.positions| && m.positions[eIdx] == eligible[j];
      assert eIdx == i;
    }
  }
}

lemma tradeSpot_ensures(m: SpotPerpMarket, spotSide: SpotSide, spotAmount: int, by_: Sender)
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysSpotAndPricesConsistent(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysOpenInterestMatchesPositions(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysPositionsWithin20xAndUnique(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepOnlyNpcTradesSpot(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepOpenFillsAtPostImpactMark(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
{
  if inv(m) && canTradeSpot(m, spotSide, spotAmount, by_) {
    var after := tradeSpot(m, spotSide, spotAmount, by_);
    if spotSide.SpotBuy? {
      CeilDivMulGe(m.baseReserve * m.quoteReserve, m.quoteReserve + spotAmount);
    } else {
      CeilDivMulGe(m.baseReserve * m.quoteReserve, m.baseReserve + spotAmount);
    }
    PositionsFilterBridge(m);
    PositionsFilterBridge(after);
    PositionsDistinctPosIds(m);
    var cashDelta := if spotSide.SpotBuy? then (0 - spotAmount) else (m.quoteReserve - after.quoteReserve);
    CreditBalanceKeepsIdsUnique(m, "npc", cashDelta);
    forall i | 0 <= i < |after.accounts|
      ensures after.accounts[i].balanceCents >= 0
    {
      if m.accounts[i].id == "npc" {
        SpotBalanceForAt(m, i);
      }
    }
  }
}

lemma openPerp_ensures(m: SpotPerpMarket, traderId: string, perpSide: PerpSide, perpSizeCents: int, leverage: int, by_: Sender)
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysSpotAndPricesConsistent(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysOpenInterestMatchesPositions(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysPositionsWithin20xAndUnique(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepOnlyNpcTradesSpot(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepOpenFillsAtPostImpactMark(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
{
  if inv(m) && canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) {
    var after := openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_);
    var margin := shared__money_ceilDiv(perpSizeCents, leverage);
    var fee := shared__money_canonicalTradingFee(perpSizeCents);
    var newLong := if perpSide.Long? then m.longOICents + perpSizeCents else m.longOICents;
    var newShort := if perpSide.Short? then m.shortOICents + perpSizeCents else m.shortOICents;
    var postOpenMark := computeMarkPriceCents(m.indexPriceCents, newLong, newShort);
    var newPos := PerpPosition(m.nextPosId + 1, traderId, perpSide, perpSizeCents, leverage, margin, postOpenMark, m.currentPeriod, m.currentPeriod, 0);
    CanonicalTradingFeeNonNeg(perpSizeCents);
    ProofLib.FoldLeftAppend(
      (acc: int, p: PerpPosition) => (if p.perpSide.Long? then (acc + p.sizeCents) else acc),
      0, m.positions, newPos
    );
    ProofLib.FoldLeftAppend(
      (acc: int, p: PerpPosition) => (if p.perpSide.Short? then (acc + p.sizeCents) else acc),
      0, m.positions, newPos
    );
    PositionsFilterBridge(m);
    PositionsFilterBridge(after);
    PositionsDistinctPosIds(m);
    CreditBalanceKeepsIdsUnique(m, traderId, 0 - (margin + fee));
    forall i | 0 <= i < |after.accounts|
      ensures after.accounts[i].balanceCents >= 0
    {
      if m.accounts[i].id == traderId {
        SpotBalanceForAt(m, i);
      }
    }
    forall p | p in after.positions
      ensures |ProofLib.Filter((q: PerpPosition) => (q.posId == p.posId), after.positions)| == 1
      ensures |ProofLib.Filter((q: PerpPosition) => (q.owner == p.owner), after.positions)| == 1
    {
      ProofLib.FilterAppend((q: PerpPosition) => (q.posId == p.posId), m.positions, newPos);
      ProofLib.FilterAppend((q: PerpPosition) => (q.owner == p.owner), m.positions, newPos);
      if p == newPos {
        ProofLib.FilterNone((q: PerpPosition) => (q.posId == p.posId), m.positions);
        ProofLib.FilterNone((q: PerpPosition) => (q.owner == p.owner), m.positions);
      }
    }
    FundingFilterBridge(m);
    FundingFilterBridge(after);
  }
}

lemma closePerp_ensures(m: SpotPerpMarket, traderId: string, by_: Sender)
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysSpotAndPricesConsistent(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysOpenInterestMatchesPositions(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysPositionsWithin20xAndUnique(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepOnlyNpcTradesSpot(m, "closePerp", closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "closePerp", closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "closePerp", closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepOpenFillsAtPostImpactMark(m, "closePerp", closePerp(m, traderId, by_)))
{
  if inv(m) && canClosePerp(m, traderId, by_) {
    var after := closePerp(m, traderId, by_);
    var pos := positionFor(m, traderId);
    var postCloseMark := computeMarkPriceCents(m.indexPriceCents, after.longOICents, after.shortOICents);
    var gross := shared__money_clampMin0(positionEquityAtMark(pos, postCloseMark));
    var fee := shared__money_canonicalTradingFee(pos.sizeCents);
    var netCredit := shared__money_clampMin0(gross - fee);
    CanonicalTradingFeeNonNeg(pos.sizeCents);
    ClosePerpPositionsBridge(m, traderId, by_);
    FilteredPositionsValid(m, traderId);
    PositionsFilterBridge(m);
    PositionsFilterBridge(after);
    PositionsDistinctPosIds(m);
    CreditBalanceKeepsIdsUnique(m, traderId, netCredit);
    FoldLongOINonNeg(0, after.positions);
    FoldShortOINonNeg(0, after.positions);
    FundingFilterBridge(m);
    FundingFilterBridge(after);
  }
}

lemma advanceHours_ensures(m: SpotPerpMarket, deltaHours: int)
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysSpotAndPricesConsistent(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysOpenInterestMatchesPositions(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysPositionsWithin20xAndUnique(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysFundingAccruedAtMostOncePerPeriod(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepOnlyNpcTradesSpot(m, "advanceHours", advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "advanceHours", advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "advanceHours", advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepOpenFillsAtPostImpactMark(m, "advanceHours", advanceHours(m, deltaHours)))
{
  if inv(m) && canAdvanceHours(m, deltaHours) {
    FundingPeriodIndexMonotonic(m.currentHour, m.currentHour + deltaHours);
    PositionsDistinctPosIds(m);
  }
}

lemma accrueFunding_ensures(m: SpotPerpMarket, period: int)
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysSpotAndPricesConsistent(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysOpenInterestMatchesPositions(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysPositionsWithin20xAndUnique(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysFundingAccruedAtMostOncePerPeriod(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepOnlyNpcTradesSpot(m, "accrueFunding", accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "accrueFunding", accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "accrueFunding", accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepOpenFillsAtPostImpactMark(m, "accrueFunding", accrueFunding(m, period)))
{
  hide *;
  reveal inv;
  if inv(m) && canAccrueFunding(m, period) {
    if period < m.cutoverPeriod {
      AccrueFundingPreCutover(m, period);
    } else {
      AccrueFundingOIAndPrices(m, period);
      AccrueFundingPositions(m, period);
      AccrueFundingClaims(m, period);
    }
  }
}

lemma liquidate_ensures(m: SpotPerpMarket, traderId: string)
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysSpotAndPricesConsistent(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysOpenInterestMatchesPositions(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysPositionsWithin20xAndUnique(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysFundingAccruedAtMostOncePerPeriod(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepOnlyNpcTradesSpot(m, "liquidate", liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "liquidate", liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "liquidate", liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepOpenFillsAtPostImpactMark(m, "liquidate", liquidate(m, traderId)))
{
  if inv(m) && canLiquidate(m, traderId) {
    var after := liquidate(m, traderId);
    var pos := positionFor(m, traderId);
    var postLiqMark := computeMarkPriceCents(m.indexPriceCents, after.longOICents, after.shortOICents);
    var payout := shared__money_clampMin0(positionEquityAtMark(pos, postLiqMark));
    LiquidatePositionsBridge(m, traderId);
    FilteredPositionsValid(m, traderId);
    PositionsFilterBridge(m);
    PositionsFilterBridge(after);
    PositionsDistinctPosIds(m);
    CreditBalanceKeepsIdsUnique(m, traderId, payout);
    FoldLongOINonNeg(0, after.positions);
    FoldShortOINonNeg(0, after.positions);
    FundingFilterBridge(m);
    FundingFilterBridge(after);
  }
}

lemma MulLe(x: int, y: int, c: int)
  requires x <= y && c >= 0
  ensures x * c <= y * c
{
  hide *;
}

lemma MulLt(x: int, y: int, c: int)
  requires x < y && c > 0
  ensures x * c < y * c
{
  hide *;
}

lemma DivBounds(a: int, d: int)
  requires a >= 0 && d > 0
  ensures a / d >= 0
  ensures (a / d) * d <= a
  ensures a < (a / d + 1) * d
{
  hide *;
  var q := a / d;
  var r := a % d;
  assert q * d + r == a;
  assert 0 <= r < d;
}

lemma QuotientMonotonic(a1: int, d1: int, a2: int, d2: int)
  requires d1 > 0 && d2 > 0
  requires a1 * d2 <= a2 * d1
  ensures quotient_markets__spotPerp(a1, d1) <= quotient_markets__spotPerp(a2, d2)
{
  hide *;
  reveal quotient_markets__spotPerp, JSFloorDiv, MathAbs;
  if a1 >= 0 && a2 >= 0 {
    DivBounds(a1, d1);
    DivBounds(a2, d2);
    var q1 := a1 / d1;
    var q2 := a2 / d2;
    if q1 > q2 {
      MulLe(q1 * d1, a1, d2);
      MulLt(a2, (q2 + 1) * d2, d1);
      MulLe(q2 + 1, q1, d1 * d2);
      assert (q1 * d1) * d2 == q1 * (d1 * d2);
      assert ((q2 + 1) * d2) * d1 == (q2 + 1) * (d1 * d2);
    }
  } else if a1 < 0 && a2 >= 0 {
    DivBounds(-a1, d1);
    DivBounds(a2, d2);
  } else if a1 >= 0 && a2 < 0 {
    MulLe(0, a1, d2);
    MulLt(a2, 0, d1);
  } else {
    DivBounds(-a1, d1);
    DivBounds(-a2, d2);
    var p1 := (-a1) / d1;
    var p2 := (-a2) / d2;
    if p2 > p1 {
      MulLe(p2 * d2, -a2, d1);
      MulLt(-a1, (p1 + 1) * d1, d2);
      MulLe(p1 + 1, p2, d1 * d2);
      assert (p2 * d2) * d1 == p2 * (d1 * d2);
      assert ((p1 + 1) * d1) * d2 == (p1 + 1) * (d1 * d2);
    }
  }
}

lemma BoundedPremiumBounds(l: int, s: int)
  requires l >= 0 && s >= 0
  ensures -MAX_PREMIUM_BPS <= boundedPremiumBps(l, s) <= MAX_PREMIUM_BPS
{
  if l + s > 0 {
    QuotientMonotonic(-MAX_PREMIUM_BPS, 1, (l - s) * MAX_PREMIUM_BPS, l + s);
    QuotientMonotonic((l - s) * MAX_PREMIUM_BPS, l + s, MAX_PREMIUM_BPS, 1);
  }
}

lemma BoundedPremiumMonotonicLong(l0: int, l1: int, s: int)
  requires 0 <= l0 <= l1 && s >= 0
  ensures boundedPremiumBps(l0, s) <= boundedPremiumBps(l1, s)
{
  if l0 + s == 0 {
    assert l0 == 0 && s == 0;
    assert boundedPremiumBps(l0, s) == 0;
    if l1 > 0 {
      QuotientMonotonic(0, 1, l1 * MAX_PREMIUM_BPS, l1);
    }
  } else {
    assert ((l0 - s) * MAX_PREMIUM_BPS) * (l1 + s) <= ((l1 - s) * MAX_PREMIUM_BPS) * (l0 + s);
    QuotientMonotonic((l0 - s) * MAX_PREMIUM_BPS, l0 + s, (l1 - s) * MAX_PREMIUM_BPS, l1 + s);
  }
}

lemma BoundedPremiumMonotonicShort(l: int, s0: int, s1: int)
  requires l >= 0 && 0 <= s0 <= s1
  ensures boundedPremiumBps(l, s1) <= boundedPremiumBps(l, s0)
{
  if l + s0 == 0 {
    assert l == 0 && s0 == 0;
    assert boundedPremiumBps(l, s0) == 0;
    if s1 > 0 {
      QuotientMonotonic((-s1) * MAX_PREMIUM_BPS, s1, 0, 1);
    }
  } else {
    assert ((l - s1) * MAX_PREMIUM_BPS) * (l + s0) <= ((l - s0) * MAX_PREMIUM_BPS) * (l + s1);
    QuotientMonotonic((l - s1) * MAX_PREMIUM_BPS, l + s1, (l - s0) * MAX_PREMIUM_BPS, l + s0);
  }
}

lemma ComputeMarkMonotonic(indexCents: int, l1: int, s1: int, l2: int, s2: int)
  requires indexCents > 0 && l1 >= 0 && s1 >= 0 && l2 >= 0 && s2 >= 0
  requires boundedPremiumBps(l1, s1) <= boundedPremiumBps(l2, s2)
  ensures computeMarkPriceCents(indexCents, l1, s1) <= computeMarkPriceCents(indexCents, l2, s2)
{
  var p1 := boundedPremiumBps(l1, s1);
  var p2 := boundedPremiumBps(l2, s2);
  BoundedPremiumBounds(l1, s1);
  BoundedPremiumBounds(l2, s2);
  assert (indexCents * (shared__money_BPS_DENOMINATOR + p1)) * shared__money_BPS_DENOMINATOR <= (indexCents * (shared__money_BPS_DENOMINATOR + p2)) * shared__money_BPS_DENOMINATOR;
  QuotientMonotonic(indexCents * (shared__money_BPS_DENOMINATOR + p1), shared__money_BPS_DENOMINATOR, indexCents * (shared__money_BPS_DENOMINATOR + p2), shared__money_BPS_DENOMINATOR);
}

lemma FloorCentsNonPos(numer: int, denom: int)
  requires numer <= 0 && denom > 0
  ensures shared__money_floorCents(numer, denom) <= 0
{
  hide *;
  reveal shared__money_floorCents, shared__money_quotient_shared__money, JSFloorDiv, MathAbs;
  if numer < 0 {
    var a := numer - denom + 1;
    assert a < 0;
    assert (-a) / denom >= 0;
  }
}

lemma CanonicalTradingFeePos(sizeCents: int)
  requires sizeCents >= MIN_ORDER_SIZE_CENTS
  ensures shared__money_canonicalTradingFee(sizeCents) >= 1
{
  CeilDivMulGe(sizeCents * shared__money_TRADING_FEE_BPS, shared__money_BPS_DENOMINATOR);
}

lemma FilterAllKeep(xs: seq<PerpPosition>, traderId: string)
  requires forall p :: p in xs ==> p.owner != traderId
  ensures ProofLib.Filter((p: PerpPosition) => (p.owner != traderId), xs) == xs
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall p :: p in xs[1..] ==> p in xs;
    FilterAllKeep(xs[1..], traderId);
    ProofLib.FilterCons((p: PerpPosition) => (p.owner != traderId), xs);
    assert [xs[0]] + xs[1..] == xs;
  } else {
    ProofLib.FilterNil((p: PerpPosition) => (p.owner != traderId), xs);
  }
}

lemma ComputeMarkPos(indexCents: int, longOI: int, shortOI: int)
  requires indexCents > 0
  ensures computeMarkPriceCents(indexCents, longOI, shortOI) >= 1
{
  hide *;
  reveal computeMarkPriceCents, shared__money_maxInt;
}

lemma lawPerpRoundTripStrictlyDecreasesCash_ensures(indexCents: int, longOI: int, shortOI: int, perpSide: PerpSide, perpSizeCents: int, leverage: int)
  ensures (lawPerpRoundTripStrictlyDecreasesCash(indexCents, longOI, shortOI, perpSide, perpSizeCents, leverage) == true)
{
  hide *;
  reveal lawPerpRoundTripStrictlyDecreasesCash, unrealizedPnlAtMark, positionEquityAtMark, shared__money_clampMin0, MIN_ORDER_SIZE_CENTS, MAX_LEVERAGE;
  if indexCents > 0 && longOI >= 0 && shortOI >= 0 && perpSizeCents >= MIN_ORDER_SIZE_CENTS && leverage >= 1 && leverage <= MAX_LEVERAGE {
    var openLong := if perpSide.Long? then longOI + perpSizeCents else longOI;
    var openShort := if perpSide.Short? then shortOI + perpSizeCents else shortOI;
    var entryPrice := computeMarkPriceCents(indexCents, openLong, openShort);
    var exitPrice := computeMarkPriceCents(indexCents, longOI, shortOI);
    var margin := shared__money_ceilDiv(perpSizeCents, leverage);
    var openFee := shared__money_canonicalTradingFee(perpSizeCents);
    var closeFee := shared__money_canonicalTradingFee(perpSizeCents);
    ComputeMarkPos(indexCents, openLong, openShort);
    CeilDivMulGe(perpSizeCents, leverage);
    CanonicalTradingFeePos(perpSizeCents);
    if perpSide.Long? {
      BoundedPremiumMonotonicLong(longOI, openLong, shortOI);
      ComputeMarkMonotonic(indexCents, longOI, shortOI, openLong, openShort);
      assert exitPrice <= entryPrice;
      MulLe(exitPrice - entryPrice, 0, perpSizeCents);
      assert perpSizeCents * (exitPrice - entryPrice) == (exitPrice - entryPrice) * perpSizeCents;
      FloorCentsNonPos(perpSizeCents * (exitPrice - entryPrice), entryPrice);
    } else {
      BoundedPremiumMonotonicShort(longOI, shortOI, openShort);
      ComputeMarkMonotonic(indexCents, openLong, openShort, longOI, shortOI);
      assert entryPrice <= exitPrice;
      MulLe(entryPrice - exitPrice, 0, perpSizeCents);
      assert perpSizeCents * (entryPrice - exitPrice) == (entryPrice - exitPrice) * perpSizeCents;
      FloorCentsNonPos(perpSizeCents * (entryPrice - exitPrice), entryPrice);
    }
    var pos := PerpPosition(1, "alice", perpSide, perpSizeCents, leverage, margin, entryPrice, 0, 0, 0);
    assert unrealizedPnlAtMark(pos, exitPrice) <= 0;
    assert positionEquityAtMark(pos, exitPrice) <= margin;
    var gross := shared__money_clampMin0(positionEquityAtMark(pos, exitPrice));
    assert gross <= margin;
    var netCredit := shared__money_clampMin0(gross - closeFee);
    assert netCredit < margin + openFee;
  }
}

lemma lawPerpMarketRoundTripStrictlyDecreasesCash_ensures(mkt: SpotPerpMarket, traderId: string, perpSide: PerpSide, perpSizeCents: int, leverage: int, by_: Sender)
  ensures (lawPerpMarketRoundTripStrictlyDecreasesCash(mkt, traderId, perpSide, perpSizeCents, leverage, by_) == true)
{
  hide *;
  reveal lawPerpMarketRoundTripStrictlyDecreasesCash, lawPerpRoundTripStrictlyDecreasesCash, alwaysSpotAndPricesConsistent, alwaysOpenInterestMatchesPositions, canOpenPerp, openPerp, closePerp, positionFor, spotBalanceFor, hasSpotAccount, hasOpenPosition, creditBalance, unrealizedPnlAtMark, positionEquityAtMark, MIN_ORDER_SIZE_CENTS, MAX_LEVERAGE;
  if alwaysSpotAndPricesConsistent(mkt) && alwaysOpenInterestMatchesPositions(mkt) && alwaysPositionsWithin20xAndUnique(mkt) && canOpenPerp(mkt, traderId, perpSide, perpSizeCents, leverage, by_) {
    var afterOpen := openPerp(mkt, traderId, perpSide, perpSizeCents, leverage, by_);
    var afterClose := closePerp(afterOpen, traderId, by_);
    var margin := shared__money_ceilDiv(perpSizeCents, leverage);
    var openFee := shared__money_canonicalTradingFee(perpSizeCents);
    var newLong := if perpSide.Long? then mkt.longOICents + perpSizeCents else mkt.longOICents;
    var newShort := if perpSide.Short? then mkt.shortOICents + perpSizeCents else mkt.shortOICents;
    var postOpenMark := computeMarkPriceCents(mkt.indexPriceCents, newLong, newShort);
    var newPos := PerpPosition(mkt.nextPosId + 1, traderId, perpSide, perpSizeCents, leverage, margin, postOpenMark, mkt.currentPeriod, mkt.currentPeriod, 0);
    assert afterOpen.positions == mkt.positions + [newPos];
    ProofLib.FoldLeftAppend(
      (found: PerpPosition, p: PerpPosition) => (if (p.owner == traderId) then p else found),
      emptyPos,
      mkt.positions,
      newPos
    );
    assert positionFor(afterOpen, traderId) == newPos;
    ClosePerpPositionsBridge(afterOpen, traderId, by_);
    ProofLib.FilterAppend((p: PerpPosition) => (p.owner != traderId), mkt.positions, newPos);
    FilterAllKeep(mkt.positions, traderId);
    assert afterClose.positions == mkt.positions;
    assert afterClose.longOICents == mkt.longOICents;
    assert afterClose.shortOICents == mkt.shortOICents;
    var postCloseMark := computeMarkPriceCents(mkt.indexPriceCents, mkt.longOICents, mkt.shortOICents);
    assert afterClose.markPriceCents == postCloseMark;
    lawPerpRoundTripStrictlyDecreasesCash_ensures(mkt.indexPriceCents, mkt.longOICents, mkt.shortOICents, perpSide, perpSizeCents, leverage);
    var gross := shared__money_clampMin0(positionEquityAtMark(newPos, postCloseMark));
    var closeFee := shared__money_canonicalTradingFee(perpSizeCents);
    var netCredit := shared__money_clampMin0(gross - closeFee);
    assert netCredit < margin + openFee;
    var idx :| 0 <= idx < |mkt.accounts| && mkt.accounts[idx].id == traderId;
    AccountsDistinctIds(mkt);
    SpotBalanceForAt(mkt, idx);
    assert afterOpen.accounts[idx].id == traderId;
    assert afterOpen.accounts[idx].balanceCents == mkt.accounts[idx].balanceCents - (margin + openFee);
    assert afterClose.accounts[idx].id == traderId;
    assert afterClose.accounts[idx].balanceCents == afterOpen.accounts[idx].balanceCents + netCredit;
    assert forall j :: idx < j < |afterClose.accounts| ==> afterClose.accounts[j].id != traderId;
    FoldSpotBalanceAt(afterClose.accounts, 0, traderId, idx);
    assert spotBalanceFor(afterClose, traderId) == mkt.accounts[idx].balanceCents - (margin + openFee) + netCredit;
    assert spotBalanceFor(afterClose, traderId) < spotBalanceFor(mkt, traderId);
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  PositionsFilterBridge(s);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[0].id), s.accounts, 0);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[1].id), s.accounts, 1);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[2].id), s.accounts, 2);
}
