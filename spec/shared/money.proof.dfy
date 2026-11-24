// spec/shared/money.md, "Splitting non-negative amounts never increases floored cents"; "Splitting sales or gross cash proceeds never increases total trader credit"; "Splitting cash inputs never increases total CPMM shares received"

lemma MulMonoLeft(a: int, b: int, c: int)
  requires a <= b && c >= 0
  ensures a * c <= b * c
{
  assert (b - a) * c >= 0;
}

lemma QuotientNonNeg(a: int, b: int)
  requires a >= 0 && b > 0
  ensures quotient_shared__money(a, b) == a / b
  ensures floorCents(a, b) == a / b
  ensures ceilDiv(a, b) == (a + b - 1) / b
{
}

lemma DivUpperBound(n: int, d: int, q: int)
  requires n >= 0 && d > 0 && n < (q + 1) * d
  ensures n / d <= q
{
  if n / d > q {
    var k := n / d;
    MulMonoLeft(q + 1, k, d);
    assert n == k * d + n % d;
    assert n % d >= 0;
  }
}

lemma FloorCentsNonNeg(n: int, d: int)
  requires n >= 0 && d > 0
  ensures 0 <= floorCents(n, d)
{
  QuotientNonNeg(n, d);
  if n / d < 0 {
    var k := n / d;
    MulMonoLeft(k, -1, d);
    assert n == k * d + n % d;
    assert n % d < d;
  }
}

lemma FloorCentsAdd(a: int, b: int, d: int)
  requires a >= 0 && b >= 0 && d > 0
  ensures floorCents(a, d) + floorCents(b, d) <= floorCents(a + b, d)
{
  QuotientNonNeg(a, d);
  QuotientNonNeg(b, d);
  QuotientNonNeg(a + b, d);
  var qa := a / d;
  var qb := b / d;
  var qab := (a + b) / d;
  assert a == qa * d + a % d && 0 <= a % d < d;
  assert b == qb * d + b % d && 0 <= b % d < d;
  assert a + b == qab * d + (a + b) % d && 0 <= (a + b) % d < d;
  assert (qa + qb) * d <= a + b;
  assert a + b < (qab + 1) * d;
  if qa + qb > qab {
    MulMonoLeft(qab + 1, qa + qb, d);
  }
}

lemma CeilDivBounds(n: int, d: int)
  requires n >= 0 && d > 0
  ensures ceilDiv(n, d) >= 0
  ensures ceilDiv(n, d) * d >= n
  ensures n > 0 ==> ceilDiv(n, d) >= 1
{
  QuotientNonNeg(n, d);
  var q := (n + d - 1) / d;
  var r := (n + d - 1) % d;
  assert n + d - 1 == q * d + r && 0 <= r < d;
  assert q * d == n + d - 1 - r >= n;
  if n > 0 && q <= 0 {
    MulMonoLeft(q, 0, d);
  }
}

lemma CeilDivLe(n: int, d: int, q: int)
  requires n >= 0 && d > 0 && n <= q * d
  ensures ceilDiv(n, d) <= q
{
  QuotientNonNeg(n, d);
  assert n + d - 1 < (q + 1) * d;
  DivUpperBound(n + d - 1, d, q);
}

lemma CeilDivMonoNum(n1: int, n2: int, d: int)
  requires 0 <= n1 <= n2 && d > 0
  ensures ceilDiv(n1, d) <= ceilDiv(n2, d)
{
  CeilDivBounds(n2, d);
  CeilDivLe(n1, d, ceilDiv(n2, d));
}

lemma CeilDivAntiMonoDenom(n: int, d1: int, d2: int)
  requires n >= 0 && 0 < d1 <= d2
  ensures ceilDiv(n, d2) <= ceilDiv(n, d1)
{
  CeilDivBounds(n, d1);
  var q1 := ceilDiv(n, d1);
  MulMonoLeft(d1, d2, q1);
  CeilDivLe(n, d2, q1);
}

lemma FeeBounds(x: int)
  requires x >= 0
  ensures 0 <= canonicalTradingFee(x) <= x
  ensures sellNetProceeds(x) == x - canonicalTradingFee(x)
  ensures buyNetAfterFee(x) == x - canonicalTradingFee(x)
{
  if x > 0 {
    CeilDivBounds(x * TRADING_FEE_BPS, BPS_DENOMINATOR);
    CeilDivLe(x * TRADING_FEE_BPS, BPS_DENOMINATOR, x);
  }
}

lemma NetMono(x: int, y: int)
  requires 0 <= x <= y
  ensures sellNetProceeds(x) <= sellNetProceeds(y)
  ensures buyNetAfterFee(x) <= buyNetAfterFee(y)
{
  FeeBounds(x);
  FeeBounds(y);
  if x > 0 {
    var d := y - x;
    CeilDivBounds(x * TRADING_FEE_BPS, BPS_DENOMINATOR);
    var fx := canonicalTradingFee(x);
    assert x * TRADING_FEE_BPS <= fx * BPS_DENOMINATOR;
    assert y * TRADING_FEE_BPS <= (fx + d) * BPS_DENOMINATOR;
    CeilDivLe(y * TRADING_FEE_BPS, BPS_DENOMINATOR, fx + d);
  }
}

lemma NetSuperAdd(x: int, y: int)
  requires x >= 0 && y >= 0
  ensures sellNetProceeds(x) + sellNetProceeds(y) <= sellNetProceeds(x + y)
  ensures buyNetAfterFee(x) + buyNetAfterFee(y) <= buyNetAfterFee(x + y)
{
  FeeBounds(x);
  FeeBounds(y);
  FeeBounds(x + y);
  if x > 0 && y > 0 {
    CeilDivBounds(x * TRADING_FEE_BPS, BPS_DENOMINATOR);
    CeilDivBounds(y * TRADING_FEE_BPS, BPS_DENOMINATOR);
    var fx := canonicalTradingFee(x);
    var fy := canonicalTradingFee(y);
    assert (x + y) * TRADING_FEE_BPS <= (fx + fy) * BPS_DENOMINATOR;
    CeilDivLe((x + y) * TRADING_FEE_BPS, BPS_DENOMINATOR, fx + fy);
  }
}

lemma CpmmSharesMono(s: int, o: int, n1: int, n2: int)
  requires s > 0 && o > 0 && 0 <= n1 <= n2
  ensures cpmmBuySharesOut(s, o, n1) <= cpmmBuySharesOut(s, o, n2)
{
  if n1 == 0 {
    if n2 > 0 {
      MulMonoLeft(o, o + n2, s);
      CeilDivLe(s * o, o + n2, s);
    }
  } else {
    CeilDivAntiMonoDenom(s * o, o + n1, o + n2);
  }
}

lemma lawFloorCentsPartitionNeverAmplifies_ensures(a: int, b: int, denom: int)
  ensures (lawFloorCentsPartitionNeverAmplifies(a, b, denom) == true)
{
  if a >= 0 && b >= 0 && denom > 0 {
    FloorCentsAdd(a, b, denom);
  }
}

lemma lawSellProceedsPartitionNonAmplifying_ensures(grossA: int, grossB: int, denom: int)
  ensures (lawSellProceedsPartitionNonAmplifying(grossA, grossB, denom) == true)
{
  hide *;
  reveal lawSellProceedsPartitionNonAmplifying;
  if grossA >= 0 && grossB >= 0 && denom > 0 {
    FloorCentsNonNeg(grossA, denom);
    FloorCentsNonNeg(grossB, denom);
    FloorCentsAdd(grossA, grossB, denom);
    var fa := floorCents(grossA, denom);
    var fb := floorCents(grossB, denom);
    var fab := floorCents(grossA + grossB, denom);
    NetSuperAdd(fa, fb);
    NetMono(fa + fb, fab);
  }
}

lemma lawBuyNetPartitionNonAmplifying_ensures(cashA: int, cashB: int, denom: int)
  ensures (lawBuyNetPartitionNonAmplifying(cashA, cashB, denom) == true)
{
  hide *;
  reveal lawBuyNetPartitionNonAmplifying;
  if cashA >= 0 && cashB >= 0 && denom > 0 {
    FloorCentsNonNeg(cashA, denom);
    FloorCentsNonNeg(cashB, denom);
    FloorCentsAdd(cashA, cashB, denom);
    var fa := floorCents(cashA, denom);
    var fb := floorCents(cashB, denom);
    var fab := floorCents(cashA + cashB, denom);
    NetSuperAdd(fa, fb);
    NetMono(fa + fb, fab);
  }
}

lemma lawSplitBuyNeverIncreasesShares_ensures(sideReserve: int, oppReserve: int, legCashA: int, legCashB: int)
  ensures (lawSplitBuyNeverIncreasesShares(sideReserve, oppReserve, legCashA, legCashB) == true)
{
  if sideReserve > 0 && oppReserve > 0 && legCashA >= 0 && legCashB >= 0 {
    var netA := buyNetAfterFee(legCashA);
    var netB := buyNetAfterFee(legCashB);
    var netWhole := buyNetAfterFee(legCashA + legCashB);
    FeeBounds(legCashA);
    FeeBounds(legCashB);
    FeeBounds(legCashA + legCashB);
    NetSuperAdd(legCashA, legCashB);
    CpmmSharesMono(sideReserve, oppReserve, netA + netB, netWhole);
    if netA > 0 && netB > 0 {
      var midSide := cpmmNextSideReserve(sideReserve, oppReserve, netA);
      var midOpp := oppReserve + netA;
      CeilDivBounds(sideReserve * oppReserve, midOpp);
      CeilDivMonoNum(sideReserve * oppReserve, midSide * midOpp, midOpp + netB);
    }
  }
}
