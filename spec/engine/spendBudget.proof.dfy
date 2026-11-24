lemma AttemptIdsUniqueBridge(b: BudgetLedger)
  ensures alwaysAttemptIdsUnique(b) == !((exists a :: a in b.attempts && !((|ProofLib.Filter((x: SpendAttempt) => (x.attemptId == a.attemptId), b.attempts)| == 1))))
{
}

lemma AttemptIdUniqueAt(xs: seq<SpendAttempt>, idx: int)
  requires 0 <= idx < |xs|
  requires |ProofLib.Filter((x: SpendAttempt) => (x.attemptId == xs[idx].attemptId), xs)| == 1
  ensures forall j :: 0 <= j < |xs| && j != idx ==> xs[j].attemptId != xs[idx].attemptId
{
  ProofLib.FilterCountOneIffUnique(
    (x: SpendAttempt) => (x.attemptId == xs[idx].attemptId),
    xs,
    (x: SpendAttempt) => x.attemptId,
    idx
  );
}

lemma PreserveAttemptIdsUnique(b: BudgetLedger, after: BudgetLedger)
  requires alwaysAttemptIdsUnique(b)
  requires |after.attempts| == |b.attempts|
  requires forall i :: 0 <= i < |b.attempts| ==> after.attempts[i].attemptId == b.attempts[i].attemptId
  ensures alwaysAttemptIdsUnique(after)
{
  AttemptIdsUniqueBridge(b);
  AttemptIdsUniqueBridge(after);
  forall a | a in after.attempts
    ensures |ProofLib.Filter((x: SpendAttempt) => (x.attemptId == a.attemptId), after.attempts)| == 1
  {
    var k :| 0 <= k < |after.attempts| && after.attempts[k] == a;
    var orig := b.attempts[k];
    assert orig in b.attempts;
    ProofLib.FilterLengthPointwise(
      (x: SpendAttempt) => (x.attemptId == orig.attemptId),
      (x: SpendAttempt) => (x.attemptId == a.attemptId),
      b.attempts,
      after.attempts
    );
  }
}

lemma SumTodaySame(xs: seq<SpendAttempt>, ys: seq<SpendAttempt>, day: int, init: int)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].utcDay == ys[i].utcDay && xs[i].boundCents == ys[i].boundCents && (xs[i].attemptStatus.AttemptReserved? || xs[i].attemptStatus.AttemptUncertain?) == (ys[i].attemptStatus.AttemptReserved? || ys[i].attemptStatus.AttemptUncertain?)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumTodaySame(xs[1..], ys[1..], day, nextInit);
  }
}

lemma SumPrevSame(xs: seq<SpendAttempt>, ys: seq<SpendAttempt>, day: int, init: int)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].utcDay == ys[i].utcDay && xs[i].boundCents == ys[i].boundCents && (xs[i].attemptStatus.AttemptReserved? || xs[i].attemptStatus.AttemptUncertain?) == (ys[i].attemptStatus.AttemptReserved? || ys[i].attemptStatus.AttemptUncertain?)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumPrevSame(xs[1..], ys[1..], day, nextInit);
  }
}

lemma FindAttemptAbsent(xs: seq<SpendAttempt>, attemptId: int, init: SpendAttempt)
  requires forall i :: 0 <= i < |xs| ==> xs[i].attemptId != attemptId
  ensures Std.Collections.Seq.FoldLeft((found: SpendAttempt, a: SpendAttempt) => (if (a.attemptId == attemptId) then a else found), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FindAttemptAbsent(xs[1..], attemptId, init);
  }
}

lemma FindAttemptUnique(xs: seq<SpendAttempt>, attemptId: int, idx: int, init: SpendAttempt)
  requires 0 <= idx < |xs|
  requires xs[idx].attemptId == attemptId
  requires forall j :: 0 <= j < |xs| && j != idx ==> xs[j].attemptId != attemptId
  ensures Std.Collections.Seq.FoldLeft((found: SpendAttempt, a: SpendAttempt) => (if (a.attemptId == attemptId) then a else found), init, xs) == xs[idx]
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FindAttemptAbsent(xs[1..], attemptId, xs[0]);
  } else {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    FindAttemptUnique(xs[1..], attemptId, idx - 1, init);
  }
}

lemma SumTodayShift(xs: seq<SpendAttempt>, day: int, init: int, d: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init + d, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) + d
  decreases |xs|
{
  if |xs| > 0 {
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumTodayShift(xs[1..], day, nextInit, d);
  }
}

lemma SumPrevShift(xs: seq<SpendAttempt>, day: int, init: int, d: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init + d, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) + d
  decreases |xs|
{
  if |xs| > 0 {
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumPrevShift(xs[1..], day, nextInit, d);
  }
}

lemma SumTodayNonNeg(xs: seq<SpendAttempt>, day: int, init: int)
  requires init >= 0
  requires forall a :: a in xs ==> a.boundCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumTodayNonNeg(xs[1..], day, nextInit);
  }
}

lemma SumPrevNonNeg(xs: seq<SpendAttempt>, day: int, init: int)
  requires init >= 0
  requires forall a :: a in xs ==> a.boundCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumPrevNonNeg(xs[1..], day, nextInit);
  }
}

lemma SumTodaySettleOne(xs: seq<SpendAttempt>, ys: seq<SpendAttempt>, day: int, idx: int, init: int)
  requires |xs| == |ys|
  requires 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  requires xs[idx].attemptStatus.AttemptReserved? || xs[idx].attemptStatus.AttemptUncertain?
  requires ys[idx].attemptStatus.AttemptSettled?
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
          - (if xs[idx].utcDay == day then xs[idx].boundCents else 0)
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    if xs[0].utcDay == day {
      SumTodayShift(xs[1..], day, init, xs[0].boundCents);
    }
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumTodaySettleOne(xs[1..], ys[1..], day, idx - 1, nextInit);
  }
}

lemma SumPrevSettleOne(xs: seq<SpendAttempt>, ys: seq<SpendAttempt>, day: int, idx: int, init: int)
  requires |xs| == |ys|
  requires 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  requires xs[idx].attemptStatus.AttemptReserved? || xs[idx].attemptStatus.AttemptUncertain?
  requires ys[idx].attemptStatus.AttemptSettled?
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
          - (if xs[idx].utcDay < day then xs[idx].boundCents else 0)
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    if xs[0].utcDay < day {
      SumPrevShift(xs[1..], day, init, xs[0].boundCents);
    }
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    SumPrevSettleOne(xs[1..], ys[1..], day, idx - 1, nextInit);
  }
}

lemma SumTodayZeroAfterRollover(xs: seq<SpendAttempt>, newDay: int, init: int)
  requires forall a :: a in xs ==> a.utcDay < newDay
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == newDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    SumTodayZeroAfterRollover(xs[1..], newDay, init);
  }
}

lemma SumPrevRollover(xs: seq<SpendAttempt>, oldDay: int, newDay: int, initToday: int, initPrev: int)
  requires oldDay < newDay
  requires forall a :: a in xs ==> a.utcDay <= oldDay
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < newDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initToday + initPrev, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay == oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initToday, xs)
        + Std.Collections.Seq.FoldLeft((acc: int, a: SpendAttempt) => (if ((a.utcDay < oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initPrev, xs)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var a := xs[0];
    var nextToday := if ((a.utcDay == oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (initToday + a.boundCents) else initToday;
    var nextPrev := if ((a.utcDay < oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (initPrev + a.boundCents) else initPrev;
    SumPrevRollover(xs[1..], oldDay, newDay, nextToday, nextPrev);
  }
}

lemma reserveAttempt_ensures(b: BudgetLedger, boundKnown: bool, boundCents: int)
  ensures (inv(b) ==> canReserveAttempt(b, boundKnown, boundCents) ==> alwaysAttemptIdsUnique(reserveAttempt(b, boundKnown, boundCents)))
  ensures (inv(b) ==> canReserveAttempt(b, boundKnown, boundCents) ==> alwaysAttemptBoundsValid(reserveAttempt(b, boundKnown, boundCents)))
  ensures (inv(b) ==> canReserveAttempt(b, boundKnown, boundCents) ==> alwaysTotalsMatchAttempts(reserveAttempt(b, boundKnown, boundCents)))
  ensures (inv(b) ==> canReserveAttempt(b, boundKnown, boundCents) ==> alwaysNonNegativeAndWithinBudget(reserveAttempt(b, boundKnown, boundCents)))
{
  if inv(b) && canReserveAttempt(b, boundKnown, boundCents) {
    var after := reserveAttempt(b, boundKnown, boundCents);
    var added := SpendAttempt(b.nextAttemptId, b.currentDay, boundCents, 0, AttemptStatus.AttemptReserved);
    AttemptIdsUniqueBridge(b);
    AttemptIdsUniqueBridge(after);
    forall a | a in after.attempts
      ensures |ProofLib.Filter((x: SpendAttempt) => (x.attemptId == a.attemptId), after.attempts)| == 1
    {
      var p := (x: SpendAttempt) => (x.attemptId == a.attemptId);
      ProofLib.FilterAppend(p, b.attempts, added);
      if a in b.attempts {
        assert a.attemptId < b.nextAttemptId;
      } else {
        assert a == added;
        ProofLib.FilterNone(p, b.attempts);
      }
    }
    ProofLib.FoldLeftAppend(
      (acc: int, a: SpendAttempt) => (if ((a.utcDay == b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
      0,
      b.attempts,
      added
    );
    ProofLib.FoldLeftAppend(
      (acc: int, a: SpendAttempt) => (if ((a.utcDay < b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
      0,
      b.attempts,
      added
    );
  }
}

lemma confirmSpend_ensures(b: BudgetLedger, attemptId: int, actualCents: int)
  ensures (inv(b) ==> canConfirmSpend(b, attemptId, actualCents) ==> alwaysAttemptIdsUnique(confirmSpend(b, attemptId, actualCents)))
  ensures (inv(b) ==> canConfirmSpend(b, attemptId, actualCents) ==> alwaysAttemptBoundsValid(confirmSpend(b, attemptId, actualCents)))
  ensures (inv(b) ==> canConfirmSpend(b, attemptId, actualCents) ==> alwaysTotalsMatchAttempts(confirmSpend(b, attemptId, actualCents)))
  ensures (inv(b) ==> canConfirmSpend(b, attemptId, actualCents) ==> alwaysNonNegativeAndWithinBudget(confirmSpend(b, attemptId, actualCents)))
{
  if inv(b) && canConfirmSpend(b, attemptId, actualCents) {
    var after := confirmSpend(b, attemptId, actualCents);
    AttemptIdsUniqueBridge(b);
    var idx :| 0 <= idx < |b.attempts| && b.attempts[idx].attemptId == attemptId && (b.attempts[idx].attemptStatus.AttemptReserved? || b.attempts[idx].attemptStatus.AttemptUncertain?);
    assert b.attempts[idx] in b.attempts;
    AttemptIdUniqueAt(b.attempts, idx);
    FindAttemptUnique(b.attempts, attemptId, idx, emptyAttempt);
    PreserveAttemptIdsUnique(b, after);
    SumTodaySettleOne(b.attempts, after.attempts, b.currentDay, idx, 0);
    SumPrevSettleOne(b.attempts, after.attempts, b.currentDay, idx, 0);
    SumTodayNonNeg(after.attempts, b.currentDay, 0);
    SumPrevNonNeg(after.attempts, b.currentDay, 0);
  }
}

lemma markUncertain_ensures(b: BudgetLedger, attemptId: int)
  ensures (inv(b) ==> canMarkUncertain(b, attemptId) ==> alwaysAttemptIdsUnique(markUncertain(b, attemptId)))
  ensures (inv(b) ==> canMarkUncertain(b, attemptId) ==> alwaysAttemptBoundsValid(markUncertain(b, attemptId)))
  ensures (inv(b) ==> canMarkUncertain(b, attemptId) ==> alwaysTotalsMatchAttempts(markUncertain(b, attemptId)))
  ensures (inv(b) ==> canMarkUncertain(b, attemptId) ==> alwaysNonNegativeAndWithinBudget(markUncertain(b, attemptId)))
{
  if inv(b) && canMarkUncertain(b, attemptId) {
    var after := markUncertain(b, attemptId);
    AttemptIdsUniqueBridge(b);
    var idx :| 0 <= idx < |b.attempts| && b.attempts[idx].attemptId == attemptId && b.attempts[idx].attemptStatus.AttemptReserved?;
    assert b.attempts[idx] in b.attempts;
    AttemptIdUniqueAt(b.attempts, idx);
    PreserveAttemptIdsUnique(b, after);
    SumTodaySame(b.attempts, after.attempts, b.currentDay, 0);
    SumPrevSame(b.attempts, after.attempts, b.currentDay, 0);
  }
}

lemma simulateWorkerRestart_ensures(b: BudgetLedger)
  ensures (inv(b) ==> canSimulateWorkerRestart(b) ==> alwaysAttemptIdsUnique(simulateWorkerRestart(b)))
  ensures (inv(b) ==> canSimulateWorkerRestart(b) ==> alwaysAttemptBoundsValid(simulateWorkerRestart(b)))
  ensures (inv(b) ==> canSimulateWorkerRestart(b) ==> alwaysTotalsMatchAttempts(simulateWorkerRestart(b)))
  ensures (inv(b) ==> canSimulateWorkerRestart(b) ==> alwaysNonNegativeAndWithinBudget(simulateWorkerRestart(b)))
{
  if inv(b) && canSimulateWorkerRestart(b) {
    var after := simulateWorkerRestart(b);
    PreserveAttemptIdsUnique(b, after);
    SumTodaySame(b.attempts, after.attempts, b.currentDay, 0);
    SumPrevSame(b.attempts, after.attempts, b.currentDay, 0);
  }
}

lemma rolloverUtcDay_ensures(b: BudgetLedger, newDay: int)
  ensures (inv(b) ==> canRolloverUtcDay(b, newDay) ==> alwaysAttemptIdsUnique(rolloverUtcDay(b, newDay)))
  ensures (inv(b) ==> canRolloverUtcDay(b, newDay) ==> alwaysAttemptBoundsValid(rolloverUtcDay(b, newDay)))
  ensures (inv(b) ==> canRolloverUtcDay(b, newDay) ==> alwaysTotalsMatchAttempts(rolloverUtcDay(b, newDay)))
  ensures (inv(b) ==> canRolloverUtcDay(b, newDay) ==> alwaysNonNegativeAndWithinBudget(rolloverUtcDay(b, newDay)))
{
  if inv(b) && canRolloverUtcDay(b, newDay) {
    var after := rolloverUtcDay(b, newDay);
    SumTodayZeroAfterRollover(b.attempts, newDay, 0);
    SumPrevRollover(b.attempts, b.currentDay, newDay, 0, 0);
  }
}
