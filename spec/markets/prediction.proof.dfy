// spec/markets/prediction.md, "Pool reserves remain strictly positive and satisfy the constant-product bound"
// spec/markets/prediction.md, "Account balances, shares, liquidity, and costs never go negative"
// spec/markets/prediction.md, "The fee ledger always equals the exact sum of charged fees"
// spec/markets/prediction.md, "Discovered by the proof: Active share and cash supply stays within the integer square-root range"

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

lemma FoldYesSupplyOffset(xs: seq<TraderAccount>, init1: int, init2: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init2, xs) - Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init1, xs) == init2 - init1
  decreases |xs|
{
  if |xs| > 0 {
    var step := xs[0].yesShares + (xs[0].balanceCents * SUBCENTS_PER_CENT);
    FoldYesSupplyOffset(xs[1..], init1 + step, init2 + step);
  }
}

lemma FoldYesSupplyDelta(xs: seq<TraderAccount>, ys: seq<TraderAccount>, init: int, idx: int)
  requires |xs| == |ys| && 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, ys) - Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) == (ys[idx].yesShares + (ys[idx].balanceCents * SUBCENTS_PER_CENT)) - (xs[idx].yesShares + (xs[idx].balanceCents * SUBCENTS_PER_CENT))
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    FoldYesSupplyOffset(xs[1..], (init + xs[0].yesShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT), (init + ys[0].yesShares) + (ys[0].balanceCents * SUBCENTS_PER_CENT));
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| && i != idx - 1 ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    assert xs[1..][idx - 1] == xs[idx] && ys[1..][idx - 1] == ys[idx];
    FoldYesSupplyDelta(xs[1..], ys[1..], (init + xs[0].yesShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT), idx - 1);
  }
}

lemma FoldYesSupplyGe(xs: seq<TraderAccount>, init: int)
  requires forall a :: a in xs ==> a.yesShares >= 0 && a.balanceCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) >= init
  ensures forall i :: 0 <= i < |xs| ==> Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.yesShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) >= init + xs[i].yesShares
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall a :: a in xs[1..] ==> a in xs;
    var next := (init + xs[0].yesShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT);
    FoldYesSupplyGe(xs[1..], next);
    assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma FoldNoSupplyOffset(xs: seq<TraderAccount>, init1: int, init2: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init2, xs) - Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init1, xs) == init2 - init1
  decreases |xs|
{
  if |xs| > 0 {
    var step := xs[0].noShares + (xs[0].balanceCents * SUBCENTS_PER_CENT);
    FoldNoSupplyOffset(xs[1..], init1 + step, init2 + step);
  }
}

lemma FoldNoSupplyDelta(xs: seq<TraderAccount>, ys: seq<TraderAccount>, init: int, idx: int)
  requires |xs| == |ys| && 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, ys) - Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) == (ys[idx].noShares + (ys[idx].balanceCents * SUBCENTS_PER_CENT)) - (xs[idx].noShares + (xs[idx].balanceCents * SUBCENTS_PER_CENT))
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    FoldNoSupplyOffset(xs[1..], (init + xs[0].noShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT), (init + ys[0].noShares) + (ys[0].balanceCents * SUBCENTS_PER_CENT));
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| && i != idx - 1 ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    assert xs[1..][idx - 1] == xs[idx] && ys[1..][idx - 1] == ys[idx];
    FoldNoSupplyDelta(xs[1..], ys[1..], (init + xs[0].noShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT), idx - 1);
  }
}

lemma FoldNoSupplyGe(xs: seq<TraderAccount>, init: int)
  requires forall a :: a in xs ==> a.noShares >= 0 && a.balanceCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) >= init
  ensures forall i :: 0 <= i < |xs| ==> Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => ((acc + a.noShares) + (a.balanceCents * SUBCENTS_PER_CENT)), init, xs) >= init + xs[i].noShares
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall a :: a in xs[1..] ==> a in xs;
    var next := (init + xs[0].noShares) + (xs[0].balanceCents * SUBCENTS_PER_CENT);
    FoldNoSupplyGe(xs[1..], next);
    assert forall i :: 1 <= i < |xs| ==> xs[i] == xs[1..][i - 1];
  }
}

lemma IsqrtFoldSpec(bits: seq<int>, acc: int, d: int, bit: int)
  requires |bits| > 0
  requires bit >= 1 && bits[0] == bit
  requires forall i {:trigger bits[i]} :: 0 <= i < |bits| - 1 ==> bits[i] == 2 * bits[i + 1]
  requires bits[|bits| - 1] == 1
  requires 0 <= acc && acc + 2 * bit - 1 <= MAX_SQRT_OPERAND
  requires acc * acc <= d < (acc + 2 * bit) * (acc + 2 * bit)
  ensures var r := Std.Collections.Seq.FoldLeft((acc: int, bit: int) => (if (((acc + bit) <= MAX_SQRT_OPERAND) && (((acc + bit) * (acc + bit)) <= d)) then (acc + bit) else acc), acc, bits);
    r >= 0 && r * r <= d < (r + 1) * (r + 1)
  decreases |bits|
{
  var nextAcc := if (((acc + bit) <= MAX_SQRT_OPERAND) && (((acc + bit) * (acc + bit)) <= d)) then (acc + bit) else acc;
  if |bits| == 1 {
    assert bit == 1;
  } else {
    var nextBit := bits[1];
    assert bit == 2 * nextBit;
    var tail := bits[1..];
    assert forall i {:trigger tail[i]} :: 0 <= i < |tail| - 1 ==> tail[i] == bits[i + 1] && tail[i + 1] == bits[i + 2];
    IsqrtFoldSpec(tail, nextAcc, d, nextBit);
  }
}

lemma IsqrtSpec(d: int)
  requires 0 <= d < 67108864 * 67108864
  ensures isqrt(d) >= 0 && isqrt(d) * isqrt(d) <= d < (isqrt(d) + 1) * (isqrt(d) + 1)
{
  if d > 0 {
    IsqrtFoldSpec(SQRT_BITS, 0, d, 33554432);
  }
}

lemma QuadRootIneq(B: int, C: int, rC: int, g: int)
  requires B > 0 && C > 0 && rC >= 0 && g >= 0
  requires g * (B + rC) <= 2 * C
  requires rC * rC >= B * B - 4 * C
  ensures g * g - B * g + C >= 0
{
  hide *;
  var lhs := g * rC;
  var rhs := 2 * C - g * B;
  assert 0 <= lhs <= rhs;
  assert lhs * lhs <= rhs * rhs;
  assert lhs * lhs == (g * g) * (rC * rC);
  assert (g * g) * (B * B - 4 * C) <= (g * g) * (rC * rC);
  assert (g * g) * (B * B - 4 * C) <= rhs * rhs;
  assert rhs * rhs - (g * g) * (B * B - 4 * C) == 4 * C * (g * g - B * g + C);
}

lemma DiscIdentity(sR: int, oR: int, sellShares: int)
  requires sR > 0 && oR > 0 && sellShares > 0
  requires sR + oR + sellShares <= 67108863
  ensures var B := (sR + oR) + sellShares;
    var diff := (sR + oR) - sellShares;
    var disc := (diff * diff) + ((4 * sR) * sellShares);
    var C := sellShares * oR;
    disc == B * B - 4 * C && 0 <= disc < 67108864 * 67108864 && (2 * sellShares) * oR == 2 * C
{
  hide *;
  var B := (sR + oR) + sellShares;
  var diff := (sR + oR) - sellShares;
  var disc := (diff * diff) + ((4 * sR) * sellShares);
  var C := sellShares * oR;
  assert disc == B * B - 4 * C;
  assert 0 <= disc < B * B;
  assert B * B < 67108864 * 67108864;
}

lemma MulMonoRight(a: int, b: int, c: int)
  requires a <= b && c >= 0
  ensures a * c <= b * c
{
  hide *;
  assert (b - a) * c >= 0;
}

lemma SellKAlgebra(sR: int, oR: int, sellShares: int, g: int)
  ensures var B := (sR + oR) + sellShares;
    var C := sellShares * oR;
    ((sR + sellShares) - g) * (oR - g) == sR * oR + (g * g - B * g + C)
{
  hide *;
}

lemma CeilSqrtGe(rF: int, disc: int)
  requires rF >= 0 && rF * rF <= disc < (rF + 1) * (rF + 1)
  ensures var rC := if (rF * rF) >= disc then rF else (rF + 1);
    rC >= 0 && rC * rC >= disc
{
  hide *;
}

lemma CpmmSellGrossBound(yesR: int, noR: int, side: Side, sellShares: int, rF: int, rC: int)
  requires yesR > 0 && noR > 0 && sellShares > 0
  requires yesR + noR + sellShares <= 67108863
  requires var sR := if side.Yes? then yesR else noR;
    var oR := if side.Yes? then noR else yesR;
    var diff := (sR + oR) - sellShares;
    var disc := (diff * diff) + ((4 * sR) * sellShares);
    rF == isqrt(disc) && rF >= 0 && rF * rF <= disc < (rF + 1) * (rF + 1) && rC == (if (rF * rF) >= disc then rF else (rF + 1))
  ensures var sR := if side.Yes? then yesR else noR;
    var oR := if side.Yes? then noR else yesR;
    var B := (sR + oR) + sellShares;
    var g := cpmmSellGrossUnits(yesR, noR, side, sellShares);
    rC >= 0 && g >= 0 && g * (B + rC) <= (2 * sellShares) * oR
{
  hide *;
  reveal cpmmSellGrossUnits, shared__money_minInt, shared__money_clampMin0;
  var sR := if side.Yes? then yesR else noR;
  var oR := if side.Yes? then noR else yesR;
  var B := (sR + oR) + sellShares;
  var diff := (sR + oR) - sellShares;
  var disc := (diff * diff) + ((4 * sR) * sellShares);
  CeilSqrtGe(rF, disc);
  var denom := B + rC;
  QuotientBounds((2 * sellShares) * oR, denom);
  var raw := quotient_markets__prediction(((2 * sellShares) * oR), denom);
  var g := cpmmSellGrossUnits(yesR, noR, side, sellShares);
  assert 0 <= g <= raw;
  MulMonoRight(g, raw, denom);
}

lemma SellQuadraticPreservesK(yesR: int, noR: int, side: Side, sellShares: int)
  requires yesR > 0 && noR > 0 && sellShares > 0
  requires yesR + noR + sellShares <= 67108863
  ensures var g := cpmmSellGrossUnits(yesR, noR, side, sellShares);
    var nextYes := if side.Yes? then ((yesR + sellShares) - g) else (yesR - g);
    var nextNo := if side.Yes? then (noR - g) else ((noR + sellShares) - g);
    nextYes * nextNo >= yesR * noR
{
  hide *;
  var sR := if side.Yes? then yesR else noR;
  var oR := if side.Yes? then noR else yesR;
  var B := (sR + oR) + sellShares;
  var diff := (sR + oR) - sellShares;
  var disc := (diff * diff) + ((4 * sR) * sellShares);
  var C := sellShares * oR;
  DiscIdentity(sR, oR, sellShares);
  IsqrtSpec(disc);
  var rF := isqrt(disc);
  CeilSqrtGe(rF, disc);
  var rC := if (rF * rF) >= disc then rF else (rF + 1);
  CpmmSellGrossBound(yesR, noR, side, sellShares, rF, rC);
  var g := cpmmSellGrossUnits(yesR, noR, side, sellShares);
  QuadRootIneq(B, C, rC, g);
  SellKAlgebra(sR, oR, sellShares, g);
  var nextYes := if side.Yes? then ((yesR + sellShares) - g) else (yesR - g);
  var nextNo := if side.Yes? then (noR - g) else ((noR + sellShares) - g);
  assert nextYes * nextNo == ((sR + sellShares) - g) * (oR - g);
  assert yesR * noR == sR * oR;
}

lemma FoldPayoutsNonNeg(init: int, xs: seq<TraderAccount>, winner: Side)
  requires init >= 0
  requires forall a :: a in xs ==> a.yesShares >= 0 && a.noShares >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: TraderAccount) => (if a.settledOnClose then acc else (acc + shared__money_floorCents((if winner.Yes? then a.yesShares else a.noShares), SUBCENTS_PER_CENT))), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall a :: a in xs[1..] ==> a in xs;
    var shares := if winner.Yes? then xs[0].yesShares else xs[0].noShares;
    FloorCentsBounds(shares, SUBCENTS_PER_CENT);
    var next := if xs[0].settledOnClose then init else (init + shared__money_floorCents(shares, SUBCENTS_PER_CENT));
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
  reveal inv, alwaysReservesPositive, alwaysConstantProductPreserved, alwaysActiveSupplyWithinSqrtRange, canSell, sell, hasTrader, heldSharesFor, MIN_SELL_SHARE_UNITS;
  BalancesFilterBridge(m);
  var idx :| 0 <= idx < |m.accounts| && m.accounts[idx].id == traderId;
  AccountForAt(m, idx);
  FoldYesSupplyGe(m.accounts, 0);
  FoldNoSupplyGe(m.accounts, 0);
  assert m.yesReserve + m.noReserve + sellShares <= 40000000;
  SellQuadraticPreservesK(m.yesReserve, m.noReserve, side, sellShares);
}

lemma SellPreservesBalancesAndSupply(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysBalancesAndPositionsNonNegative(sell(m, traderId, side, sellShares))
  ensures alwaysActiveSupplyWithinSqrtRange(sell(m, traderId, side, sellShares))
{
  hide *;
  reveal inv, alwaysActiveSupplyWithinSqrtRange, canSell, sell, sellAccountUpdate, hasTrader, heldSharesFor, heldCostFor, shared__money_sellNetProceeds, shared__money_clampMin0, SUBCENTS_PER_CENT;
  var after := sell(m, traderId, side, sellShares);
  var grossUnits := cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares);
  var settledCents := shared__money_floorCents(grossUnits, SUBCENTS_PER_CENT);
  var fee := shared__money_canonicalTradingFee(settledCents);
  var netCredit := shared__money_sellNetProceeds(settledCents);
  FloorCentsBounds(grossUnits, SUBCENTS_PER_CENT);
  CanonicalTradingFeeNonNeg(settledCents);
  assert netCredit <= settledCents;
  BalancesFilterBridge(m);
  BalancesFilterBridge(after);
  AccountsDistinctIds(m);
  var idx :| 0 <= idx < |m.accounts| && m.accounts[idx].id == traderId;
  AccountForAt(m, idx);
  forall i | 0 <= i < |after.accounts|
    ensures |ProofLib.Filter((b: TraderAccount) => (b.id == after.accounts[i].id), after.accounts)| == 1
    ensures after.accounts[i].balanceCents >= 0
    ensures after.accounts[i].yesShares >= 0 && after.accounts[i].noShares >= 0
    ensures after.accounts[i].yesCostCents >= 0 && after.accounts[i].noCostCents >= 0
  {
    var a := m.accounts[i];
    var a' := after.accounts[i];
    assert a in m.accounts;
    ProofLib.FilterLengthPointwise((b: TraderAccount) => (b.id == a'.id), (b: TraderAccount) => (b.id == a.id), after.accounts, m.accounts);
    if a.id == traderId {
      assert i == idx;
      var held := heldSharesFor(a, side);
      var prevCost := heldCostFor(a, side);
      var remaining := shared__money_clampMin0(held - sellShares);
      if held > 0 && remaining > 0 {
        QuotientBounds(prevCost * remaining, held);
      }
    }
  }
  FoldYesSupplyDelta(m.accounts, after.accounts, 0, idx);
  FoldNoSupplyDelta(m.accounts, after.accounts, 0, idx);
}

lemma SellPreservesFees(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  requires inv(m) && canSell(m, traderId, side, sellShares)
  ensures alwaysFeeLedgerReconciles(sell(m, traderId, side, sellShares))
{
  hide *;
  reveal inv, alwaysFeeLedgerReconciles, canSell, sell;
  var grossUnits := cpmmSellGrossUnits(m.yesReserve, m.noReserve, side, sellShares);
  var settledCents := shared__money_floorCents(grossUnits, SUBCENTS_PER_CENT);
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
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> alwaysActiveSupplyWithinSqrtRange(buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepNoTradesOutsideOpenWindow(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepManualHoldBlocksResolution(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepDuplicateResolutionIsIdempotent(m, "buy", buy(m, traderId, side, amountCents)))
  ensures (inv(m) ==> canBuy(m, traderId, side, amountCents) ==> stepTerminalPhasesStayTerminal(m, buy(m, traderId, side, amountCents)))
{
  if inv(m) && canBuy(m, traderId, side, amountCents) {
    var after := buy(m, traderId, side, amountCents);
    var fee := shared__money_canonicalTradingFee(amountCents);
    var netCents := shared__money_buyNetAfterFee(amountCents);
    var netUnits := netCents * SUBCENTS_PER_CENT;
    CanonicalTradingFeeNonNeg(amountCents);
    assert netCents <= amountCents;
    if side.Yes? {
      CeilDivMulGe(m.yesReserve * m.noReserve, m.noReserve + netUnits);
    } else {
      CeilDivMulGe(m.yesReserve * m.noReserve, m.yesReserve + netUnits);
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
    var idx :| 0 <= idx < |m.accounts| && m.accounts[idx].id == traderId;
    FoldYesSupplyDelta(m.accounts, after.accounts, 0, idx);
    FoldNoSupplyDelta(m.accounts, after.accounts, 0, idx);
  }
}

lemma sell_ensures(m: PredictionMarket, traderId: string, side: Side, sellShares: int)
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysReservesPositive(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysConstantProductPreserved(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysBalancesAndPositionsNonNegative(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysFeeLedgerReconciles(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysHiddenOutcomeNeverVisibleBeforeResolution(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysSettledAccountsHaveZeroOpenShares(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> alwaysActiveSupplyWithinSqrtRange(sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepNoTradesOutsideOpenWindow(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepManualHoldBlocksResolution(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepDuplicateResolutionIsIdempotent(m, "sell", sell(m, traderId, side, sellShares)))
  ensures (inv(m) ==> canSell(m, traderId, side, sellShares) ==> stepTerminalPhasesStayTerminal(m, sell(m, traderId, side, sellShares)))
{
  hide *;
  if inv(m) && canSell(m, traderId, side, sellShares) {
    SellPreservesConstantProduct(m, traderId, side, sellShares);
    SellPreservesBalancesAndSupply(m, traderId, side, sellShares);
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
  ensures (inv(m) ==> canReplayResolution(m) ==> alwaysActiveSupplyWithinSqrtRange(replayResolution(m)))
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
  ensures (inv(m) ==> canResolveMarket(m) ==> alwaysActiveSupplyWithinSqrtRange(resolveMarket(m)))
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
      FloorCentsBounds(if winner.Yes? then a.yesShares else a.noShares, SUBCENTS_PER_CENT);
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
  ensures (inv(m) ==> canCancelMarket(m) ==> alwaysActiveSupplyWithinSqrtRange(cancelMarket(m)))
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
