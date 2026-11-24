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
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysOpenInterestMatchesPositions(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysSpotAndPricesConsistent(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysPositionsWithin20xAndUnique(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepOnlyNpcTradesSpot(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
  ensures (inv(m) ==> canTradeSpot(m, spotSide, spotAmount, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "tradeSpot", tradeSpot(m, spotSide, spotAmount, by_)))
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
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysOpenInterestMatchesPositions(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysSpotAndPricesConsistent(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysPositionsWithin20xAndUnique(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepOnlyNpcTradesSpot(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
  ensures (inv(m) ==> canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "openPerp", openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_)))
{
  if inv(m) && canOpenPerp(m, traderId, perpSide, perpSizeCents, leverage, by_) {
    var after := openPerp(m, traderId, perpSide, perpSizeCents, leverage, by_);
    var margin := shared__money_ceilDiv(perpSizeCents, leverage);
    var fee := shared__money_canonicalTradingFee(perpSizeCents);
    var newPos := PerpPosition(m.nextPosId + 1, traderId, perpSide, perpSizeCents, leverage, margin, m.markPriceCents, m.currentPeriod, m.currentPeriod, 0);
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
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysOpenInterestMatchesPositions(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysSpotAndPricesConsistent(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysPositionsWithin20xAndUnique(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> alwaysFundingAccruedAtMostOncePerPeriod(closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepOnlyNpcTradesSpot(m, "closePerp", closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "closePerp", closePerp(m, traderId, by_)))
  ensures (inv(m) ==> canClosePerp(m, traderId, by_) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "closePerp", closePerp(m, traderId, by_)))
{
  if inv(m) && canClosePerp(m, traderId, by_) {
    var after := closePerp(m, traderId, by_);
    var pos := positionFor(m, traderId);
    var gross := shared__money_clampMin0(positionEquityAtMark(pos, m.markPriceCents));
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
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysOpenInterestMatchesPositions(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysSpotAndPricesConsistent(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysPositionsWithin20xAndUnique(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> alwaysFundingAccruedAtMostOncePerPeriod(advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepOnlyNpcTradesSpot(m, "advanceHours", advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "advanceHours", advanceHours(m, deltaHours)))
  ensures (inv(m) ==> canAdvanceHours(m, deltaHours) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "advanceHours", advanceHours(m, deltaHours)))
{
  if inv(m) && canAdvanceHours(m, deltaHours) {
    FundingPeriodIndexMonotonic(m.currentHour, m.currentHour + deltaHours);
    PositionsDistinctPosIds(m);
  }
}

lemma accrueFunding_ensures(m: SpotPerpMarket, period: int)
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysOpenInterestMatchesPositions(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysSpotAndPricesConsistent(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysPositionsWithin20xAndUnique(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> alwaysFundingAccruedAtMostOncePerPeriod(accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepOnlyNpcTradesSpot(m, "accrueFunding", accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "accrueFunding", accrueFunding(m, period)))
  ensures (inv(m) ==> canAccrueFunding(m, period) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "accrueFunding", accrueFunding(m, period)))
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
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysOpenInterestMatchesPositions(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysSpotAndPricesConsistent(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysPositionsWithin20xAndUnique(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> alwaysFundingAccruedAtMostOncePerPeriod(liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepOnlyNpcTradesSpot(m, "liquidate", liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepPerpTradesLeaveSpotAndIndexUnchanged(m, "liquidate", liquidate(m, traderId)))
  ensures (inv(m) ==> canLiquidate(m, traderId) ==> stepFundingPeriodMonotonicAndCutoverGuarded(m, "liquidate", liquidate(m, traderId)))
{
  if inv(m) && canLiquidate(m, traderId) {
    var after := liquidate(m, traderId);
    var pos := positionFor(m, traderId);
    var payout := shared__money_clampMin0(positionEquityAtMark(pos, m.markPriceCents));
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

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  PositionsFilterBridge(s);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[0].id), s.accounts, 0);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[1].id), s.accounts, 1);
  ProofLib.FilterOne((b: SpotPerpAccount) => (b.id == s.accounts[2].id), s.accounts, 2);
}
