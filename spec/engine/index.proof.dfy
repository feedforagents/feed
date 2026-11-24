lemma EngineNpcEngagementUniqueBridge(s: engine__npcLoop_NpcLoopState)
  ensures engine__npcLoop_alwaysEngagementUniqueAndNonNegative(s) == (
    !((exists e :: e in s.engagements && !(((e.playerId > 0) && (e.score >= 0))))) &&
    !((exists a :: a in s.engagements && !((|ProofLib.Filter((b: engine__npcLoop_PlayerEngagement) => (b.playerId == a.playerId), s.engagements)| == 1)))) &&
    !((exists rec :: rec in s.alphaInvites && !((engine__npcLoop_playerScore(s.engagements, rec.playerId) >= engine__npcLoop_minAlphaEngagement))))
  )
{
}

lemma EngineNpcPlayerScoreMonotone(xs: seq<engine__npcLoop_PlayerEngagement>, ys: seq<engine__npcLoop_PlayerEngagement>, pid: int, init1: int, init2: int)
  requires |xs| == |ys|
  requires init1 <= init2
  requires forall i :: 0 <= i < |xs| ==> xs[i].playerId == ys[i].playerId && xs[i].score <= ys[i].score
  ensures Std.Collections.Seq.FoldLeft((acc: int, e: engine__npcLoop_PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init1, xs) <= Std.Collections.Seq.FoldLeft((acc: int, e: engine__npcLoop_PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init2, ys)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    EngineNpcPlayerScoreMonotone(
      xs[1..],
      ys[1..],
      pid,
      if xs[0].playerId == pid then xs[0].score else init1,
      if ys[0].playerId == pid then ys[0].score else init2
    );
  }
}

lemma EngineNpcPlayerScoreAbsent(xs: seq<engine__npcLoop_PlayerEngagement>, pid: int, init: int)
  requires forall e :: e in xs ==> e.playerId != pid
  ensures Std.Collections.Seq.FoldLeft((acc: int, e: engine__npcLoop_PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall e :: e in xs[1..] ==> e in xs;
    EngineNpcPlayerScoreAbsent(xs[1..], pid, init);
  }
}

lemma EngineNpcRecordEngagementPreserves(s: engine__npcLoop_NpcLoopState, playerId: int, engagementDelta: int, by_: engine__npcLoop_LoopSender)
  requires engine__npcLoop_inv(s)
  requires engine__npcLoop_canRecordPlayerEngagement(s, playerId, engagementDelta, by_)
  ensures engine__npcLoop_inv(engine__npcLoop_recordPlayerEngagement(s, playerId, engagementDelta, by_))
{
  var after := engine__npcLoop_recordPlayerEngagement(s, playerId, engagementDelta, by_);
  EngineNpcEngagementUniqueBridge(s);
  EngineNpcEngagementUniqueBridge(after);
  if exists e :: e in s.engagements && e.playerId == playerId {
    forall a | a in after.engagements
      ensures |ProofLib.Filter((b: engine__npcLoop_PlayerEngagement) => (b.playerId == a.playerId), after.engagements)| == 1
    {
      var idx :| 0 <= idx < |after.engagements| && after.engagements[idx] == a;
      var orig := s.engagements[idx];
      assert orig in s.engagements;
      assert orig.playerId == a.playerId;
      ProofLib.FilterLengthPointwise(
        (b: engine__npcLoop_PlayerEngagement) => (b.playerId == orig.playerId),
        (b: engine__npcLoop_PlayerEngagement) => (b.playerId == a.playerId),
        s.engagements,
        after.engagements
      );
    }
    forall rec | rec in after.alphaInvites
      ensures engine__npcLoop_playerScore(after.engagements, rec.playerId) >= engine__npcLoop_minAlphaEngagement
    {
      EngineNpcPlayerScoreMonotone(s.engagements, after.engagements, rec.playerId, 0, 0);
    }
  } else {
    var added := engine__npcLoop_PlayerEngagement(playerId, engagementDelta);
    forall a | a in after.engagements
      ensures |ProofLib.Filter((b: engine__npcLoop_PlayerEngagement) => (b.playerId == a.playerId), after.engagements)| == 1
    {
      var p := (b: engine__npcLoop_PlayerEngagement) => (b.playerId == a.playerId);
      ProofLib.FilterAppend(p, s.engagements, added);
      if a in s.engagements {
        assert a.playerId != playerId;
      } else {
        assert a == added;
        ProofLib.FilterNone(p, s.engagements);
      }
    }
    forall rec | rec in after.alphaInvites
      ensures engine__npcLoop_playerScore(after.engagements, rec.playerId) >= engine__npcLoop_minAlphaEngagement
    {
      if rec.playerId == playerId {
        EngineNpcPlayerScoreAbsent(s.engagements, rec.playerId, 0);
        assert false;
      }
      ProofLib.FoldLeftAppend(
        (acc: int, e: engine__npcLoop_PlayerEngagement) => (if (e.playerId == rec.playerId) then e.score else acc),
        0,
        s.engagements,
        added
      );
    }
  }
}

lemma EngineBudgetAttemptIdsUniqueBridge(b: engine__spendBudget_BudgetLedger)
  ensures engine__spendBudget_alwaysAttemptIdsUnique(b) == !((exists a :: a in b.attempts && !((|ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), b.attempts)| == 1))))
{
}

lemma EngineBudgetAttemptIdUniqueAt(xs: seq<engine__spendBudget_SpendAttempt>, idx: int)
  requires 0 <= idx < |xs|
  requires |ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == xs[idx].attemptId), xs)| == 1
  ensures forall j :: 0 <= j < |xs| && j != idx ==> xs[j].attemptId != xs[idx].attemptId
{
  ProofLib.FilterCountOneIffUnique(
    (x: engine__spendBudget_SpendAttempt) => (x.attemptId == xs[idx].attemptId),
    xs,
    (x: engine__spendBudget_SpendAttempt) => x.attemptId,
    idx
  );
}

lemma EngineBudgetFindAttemptAbsent(xs: seq<engine__spendBudget_SpendAttempt>, attemptId: int, init: engine__spendBudget_SpendAttempt)
  requires forall i :: 0 <= i < |xs| ==> xs[i].attemptId != attemptId
  ensures Std.Collections.Seq.FoldLeft((found: engine__spendBudget_SpendAttempt, a: engine__spendBudget_SpendAttempt) => (if (a.attemptId == attemptId) then a else found), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    EngineBudgetFindAttemptAbsent(xs[1..], attemptId, init);
  }
}

lemma EngineBudgetFindAttemptUnique(xs: seq<engine__spendBudget_SpendAttempt>, attemptId: int, idx: int, init: engine__spendBudget_SpendAttempt)
  requires 0 <= idx < |xs|
  requires xs[idx].attemptId == attemptId
  requires forall j :: 0 <= j < |xs| && j != idx ==> xs[j].attemptId != attemptId
  ensures Std.Collections.Seq.FoldLeft((found: engine__spendBudget_SpendAttempt, a: engine__spendBudget_SpendAttempt) => (if (a.attemptId == attemptId) then a else found), init, xs) == xs[idx]
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    EngineBudgetFindAttemptAbsent(xs[1..], attemptId, xs[0]);
  } else {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    EngineBudgetFindAttemptUnique(xs[1..], attemptId, idx - 1, init);
  }
}

lemma EngineBudgetSumTodayShift(xs: seq<engine__spendBudget_SpendAttempt>, day: int, init: int, d: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init + d, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) + d
  decreases |xs|
{
  if |xs| > 0 {
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumTodayShift(xs[1..], day, nextInit, d);
  }
}

lemma EngineBudgetSumPrevShift(xs: seq<engine__spendBudget_SpendAttempt>, day: int, init: int, d: int)
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init + d, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) + d
  decreases |xs|
{
  if |xs| > 0 {
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumPrevShift(xs[1..], day, nextInit, d);
  }
}

lemma EngineBudgetSumTodayNonNeg(xs: seq<engine__spendBudget_SpendAttempt>, day: int, init: int)
  requires init >= 0
  requires forall a :: a in xs ==> a.boundCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumTodayNonNeg(xs[1..], day, nextInit);
  }
}

lemma EngineBudgetSumPrevNonNeg(xs: seq<engine__spendBudget_SpendAttempt>, day: int, init: int)
  requires init >= 0
  requires forall a :: a in xs ==> a.boundCents >= 0
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) >= init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumPrevNonNeg(xs[1..], day, nextInit);
  }
}

lemma EngineBudgetSumTodaySettleOne(xs: seq<engine__spendBudget_SpendAttempt>, ys: seq<engine__spendBudget_SpendAttempt>, day: int, idx: int, init: int)
  requires |xs| == |ys|
  requires 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  requires xs[idx].attemptStatus.AttemptReserved? || xs[idx].attemptStatus.AttemptUncertain?
  requires ys[idx].attemptStatus.AttemptSettled?
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
       == Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
          - (if xs[idx].utcDay == day then xs[idx].boundCents else 0)
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    if xs[0].utcDay == day {
      EngineBudgetSumTodayShift(xs[1..], day, init, xs[0].boundCents);
    }
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay == day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumTodaySettleOne(xs[1..], ys[1..], day, idx - 1, nextInit);
  }
}

lemma EngineBudgetSumPrevSettleOne(xs: seq<engine__spendBudget_SpendAttempt>, ys: seq<engine__spendBudget_SpendAttempt>, day: int, idx: int, init: int)
  requires |xs| == |ys|
  requires 0 <= idx < |xs|
  requires forall i :: 0 <= i < |xs| && i != idx ==> xs[i] == ys[i]
  requires xs[idx].attemptStatus.AttemptReserved? || xs[idx].attemptStatus.AttemptUncertain?
  requires ys[idx].attemptStatus.AttemptSettled?
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, ys)
       == Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < day) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs)
          - (if xs[idx].utcDay < day then xs[idx].boundCents else 0)
  decreases |xs|
{
  if idx == 0 {
    assert xs[1..] == ys[1..];
    if xs[0].utcDay < day {
      EngineBudgetSumPrevShift(xs[1..], day, init, xs[0].boundCents);
    }
  } else {
    assert xs[0] == ys[0];
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    var nextInit := if ((xs[0].utcDay < day) && (xs[0].attemptStatus.AttemptReserved? || xs[0].attemptStatus.AttemptUncertain?)) then (init + xs[0].boundCents) else init;
    EngineBudgetSumPrevSettleOne(xs[1..], ys[1..], day, idx - 1, nextInit);
  }
}

lemma EngineBudgetSumTodayZeroAfterRollover(xs: seq<engine__spendBudget_SpendAttempt>, newDay: int, init: int)
  requires forall a :: a in xs ==> a.utcDay < newDay
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == newDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    EngineBudgetSumTodayZeroAfterRollover(xs[1..], newDay, init);
  }
}

lemma EngineBudgetSumPrevRollover(xs: seq<engine__spendBudget_SpendAttempt>, oldDay: int, newDay: int, initToday: int, initPrev: int)
  requires oldDay < newDay
  requires forall a :: a in xs ==> a.utcDay <= oldDay
  ensures Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < newDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initToday + initPrev, xs)
       == Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initToday, xs)
        + Std.Collections.Seq.FoldLeft((acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc), initPrev, xs)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall a :: a in xs[1..] ==> a in xs;
    var a := xs[0];
    var nextToday := if ((a.utcDay == oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (initToday + a.boundCents) else initToday;
    var nextPrev := if ((a.utcDay < oldDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (initPrev + a.boundCents) else initPrev;
    EngineBudgetSumPrevRollover(xs[1..], oldDay, newDay, nextToday, nextPrev);
  }
}

lemma EngineBudgetReservePreserves(b: engine__spendBudget_BudgetLedger, boundKnown: bool, boundCents: int)
  requires engine__spendBudget_inv(b)
  requires engine__spendBudget_canReserveAttempt(b, boundKnown, boundCents)
  ensures engine__spendBudget_inv(engine__spendBudget_reserveAttempt(b, boundKnown, boundCents))
{
  var after := engine__spendBudget_reserveAttempt(b, boundKnown, boundCents);
  var added := engine__spendBudget_SpendAttempt(b.nextAttemptId, b.currentDay, boundCents, 0, engine__spendBudget_AttemptStatus.AttemptReserved);
  EngineBudgetAttemptIdsUniqueBridge(b);
  EngineBudgetAttemptIdsUniqueBridge(after);
  forall a | a in after.attempts
    ensures |ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), after.attempts)| == 1
  {
    var p := (x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId);
    ProofLib.FilterAppend(p, b.attempts, added);
    if a in b.attempts {
      assert a.attemptId < b.nextAttemptId;
    } else {
      assert a == added;
      ProofLib.FilterNone(p, b.attempts);
    }
  }
  ProofLib.FoldLeftAppend(
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    0,
    b.attempts,
    added
  );
  ProofLib.FoldLeftAppend(
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    0,
    b.attempts,
    added
  );
}

lemma EngineBudgetConfirmPreserves(b: engine__spendBudget_BudgetLedger, attemptId: int, actualCents: int)
  requires engine__spendBudget_inv(b)
  requires engine__spendBudget_canConfirmSpend(b, attemptId, actualCents)
  ensures engine__spendBudget_inv(engine__spendBudget_confirmSpend(b, attemptId, actualCents))
{
  var after := engine__spendBudget_confirmSpend(b, attemptId, actualCents);
  EngineBudgetAttemptIdsUniqueBridge(b);
  EngineBudgetAttemptIdsUniqueBridge(after);
  var idx :| 0 <= idx < |b.attempts| && b.attempts[idx].attemptId == attemptId && (b.attempts[idx].attemptStatus.AttemptReserved? || b.attempts[idx].attemptStatus.AttemptUncertain?);
  assert b.attempts[idx] in b.attempts;
  EngineBudgetAttemptIdUniqueAt(b.attempts, idx);
  EngineBudgetFindAttemptUnique(b.attempts, attemptId, idx, engine__spendBudget_emptyAttempt);
  forall a | a in after.attempts
    ensures |ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), after.attempts)| == 1
  {
    var k :| 0 <= k < |after.attempts| && after.attempts[k] == a;
    var orig := b.attempts[k];
    assert orig in b.attempts;
    ProofLib.FilterLengthPointwise(
      (x: engine__spendBudget_SpendAttempt) => (x.attemptId == orig.attemptId),
      (x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId),
      b.attempts,
      after.attempts
    );
  }
  EngineBudgetSumTodaySettleOne(b.attempts, after.attempts, b.currentDay, idx, 0);
  EngineBudgetSumPrevSettleOne(b.attempts, after.attempts, b.currentDay, idx, 0);
  EngineBudgetSumTodayNonNeg(after.attempts, b.currentDay, 0);
  EngineBudgetSumPrevNonNeg(after.attempts, b.currentDay, 0);
}

lemma EngineBudgetMarkUncertainPreserves(b: engine__spendBudget_BudgetLedger, attemptId: int)
  requires engine__spendBudget_inv(b)
  requires engine__spendBudget_canMarkUncertain(b, attemptId)
  ensures engine__spendBudget_inv(engine__spendBudget_markUncertain(b, attemptId))
{
  var after := engine__spendBudget_markUncertain(b, attemptId);
  EngineBudgetAttemptIdsUniqueBridge(b);
  EngineBudgetAttemptIdsUniqueBridge(after);
  var idx :| 0 <= idx < |b.attempts| && b.attempts[idx].attemptId == attemptId && b.attempts[idx].attemptStatus.AttemptReserved?;
  assert b.attempts[idx] in b.attempts;
  EngineBudgetAttemptIdUniqueAt(b.attempts, idx);
  forall a | a in after.attempts
    ensures |ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), after.attempts)| == 1
  {
    var k :| 0 <= k < |after.attempts| && after.attempts[k] == a;
    var orig := b.attempts[k];
    assert orig in b.attempts;
    ProofLib.FilterLengthPointwise(
      (x: engine__spendBudget_SpendAttempt) => (x.attemptId == orig.attemptId),
      (x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId),
      b.attempts,
      after.attempts
    );
  }
  ProofLib.FoldLeftPointwise(
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    0,
    b.attempts,
    after.attempts
  );
  ProofLib.FoldLeftPointwise(
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < b.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
    0,
    b.attempts,
    after.attempts
  );
}

lemma EngineBudgetRolloverPreserves(b: engine__spendBudget_BudgetLedger, newDay: int)
  requires engine__spendBudget_inv(b)
  requires engine__spendBudget_canRolloverUtcDay(b, newDay)
  ensures engine__spendBudget_inv(engine__spendBudget_rolloverUtcDay(b, newDay))
{
  EngineBudgetSumTodayZeroAfterRollover(b.attempts, newDay, 0);
  EngineBudgetSumPrevRollover(b.attempts, b.currentDay, newDay, 0, 0);
}

lemma EngineArcTenMarketSlotsBridge(s: engine__narrativeArc_NarrativeState)
  ensures engine__narrativeArc_alwaysTenMarketSlots(s) == (
    ((((|s.slots| == 10) && !((exists sl :: sl in s.slots && !(((((sl.slotId >= 0) && (sl.slotId < 10)) && (sl.marketEpoch >= 1)) && (sl.retryCount >= 0)))))) && !((exists a :: a in s.slots && !((|ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots)| == 1))))) && (s.totalSettled >= 0)) && (s.totalReplaced >= 0)
  )
{
}

lemma EngineArcUniqueCluesBridge(s: engine__narrativeArc_NarrativeState)
  ensures engine__narrativeArc_alwaysUniqueClues(s) == (
    ((!((exists sl :: sl in s.slots && !(!((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))))) && !((exists c :: c in s.feedClues && !((|ProofLib.Filter((d: engine__narrativeArc_PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), s.feedClues)| == 1))))) && !((exists c :: c in s.feedClues && !((exists sl :: sl in s.slots && ((sl.slotId == c.slotId) && (c.marketEpoch <= sl.marketEpoch)))))))
  )
{
}

lemma EngineArcFindSlotAbsent(xs: seq<engine__narrativeArc_MarketSlot>, slotId: int, init: engine__narrativeArc_MarketSlot)
  requires forall i :: 0 <= i < |xs| ==> xs[i].slotId != slotId
  ensures Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    EngineArcFindSlotAbsent(xs[1..], slotId, init);
  }
}

lemma EngineArcFindSlotUnique(xs: seq<engine__narrativeArc_MarketSlot>, slotId: int, idx: int, init: engine__narrativeArc_MarketSlot)
  requires 0 <= idx < |xs|
  requires xs[idx].slotId == slotId
  requires forall j :: 0 <= j < |xs| && j != idx ==> xs[j].slotId != slotId
  ensures Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), init, xs) == xs[idx]
  decreases |xs|
{
  if idx == 0 {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    EngineArcFindSlotAbsent(xs[1..], slotId, xs[0]);
  } else {
    assert forall j :: 0 <= j < |xs[1..]| ==> xs[1..][j] == xs[j + 1];
    EngineArcFindSlotUnique(xs[1..], slotId, idx - 1, init);
  }
}

lemma EngineArcFindSlotMember(xs: seq<engine__narrativeArc_MarketSlot>, slotId: int, init: engine__narrativeArc_MarketSlot)
  ensures var r := Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), init, xs);
          r == init || (exists idx :: 0 <= idx < |xs| && xs[idx].slotId == slotId && r == xs[idx])
  decreases |xs|
{
  if |xs| > 0 {
    var nextInit := if xs[0].slotId == slotId then xs[0] else init;
    EngineArcFindSlotMember(xs[1..], slotId, nextInit);
    var r := Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), nextInit, xs[1..]);
    if r == nextInit {
      if xs[0].slotId == slotId {
        assert 0 <= 0 < |xs| && xs[0].slotId == slotId && r == xs[0];
      }
    } else {
      var idx :| 0 <= idx < |xs[1..]| && xs[1..][idx].slotId == slotId && r == xs[1..][idx];
      assert 0 <= idx + 1 < |xs| && xs[idx + 1] == xs[1..][idx];
    }
  }
}

lemma EngineArcSlotAtMatchesFindSlot(s: engine__narrativeArc_NarrativeState, slotId: int, idx: int)
  requires engine__narrativeArc_alwaysTenMarketSlots(s)
  requires 0 <= idx < |s.slots| && s.slots[idx].slotId == slotId
  ensures engine__narrativeArc_findSlot(s.slots, slotId) == s.slots[idx]
{
  EngineArcTenMarketSlotsBridge(s);
  assert s.slots[idx] in s.slots;
  ProofLib.FilterCountOneIffUnique(
    (b: engine__narrativeArc_MarketSlot) => (b.slotId == s.slots[idx].slotId),
    s.slots,
    (b: engine__narrativeArc_MarketSlot) => b.slotId,
    idx
  );
  EngineArcFindSlotUnique(s.slots, slotId, idx, engine__narrativeArc_emptySlot);
}

lemma EngineArcPreserveSlotIdsUnique(s: engine__narrativeArc_NarrativeState, after: engine__narrativeArc_NarrativeState)
  requires engine__narrativeArc_alwaysTenMarketSlots(s)
  requires |after.slots| == |s.slots|
  requires forall i :: 0 <= i < |s.slots| ==> after.slots[i].slotId == s.slots[i].slotId
  ensures !((exists a :: a in after.slots && !((|ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), after.slots)| == 1))))
{
  EngineArcTenMarketSlotsBridge(s);
  forall a | a in after.slots
    ensures |ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), after.slots)| == 1
  {
    var k :| 0 <= k < |after.slots| && after.slots[k] == a;
    var orig := s.slots[k];
    assert orig in s.slots;
    ProofLib.FilterLengthPointwise(
      (b: engine__narrativeArc_MarketSlot) => (b.slotId == orig.slotId),
      (b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId),
      s.slots,
      after.slots
    );
  }
}

lemma EngineArcPreserveUniqueCluesWhenFeedUnchanged(s: engine__narrativeArc_NarrativeState, after: engine__narrativeArc_NarrativeState)
  requires engine__narrativeArc_alwaysUniqueClues(s)
  requires after.feedClues == s.feedClues
  requires |after.slots| == |s.slots|
  requires forall i :: 0 <= i < |s.slots| ==> after.slots[i].slotId == s.slots[i].slotId && after.slots[i].marketEpoch >= s.slots[i].marketEpoch
  requires forall i :: 0 <= i < |s.slots| ==> after.slots[i].publishedClueIds == s.slots[i].publishedClueIds || after.slots[i].publishedClueIds == []
  ensures engine__narrativeArc_alwaysUniqueClues(after)
{
  EngineArcUniqueCluesBridge(s);
  EngineArcUniqueCluesBridge(after);
  forall sl | sl in after.slots
    ensures !((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))
  {
    var i :| 0 <= i < |after.slots| && after.slots[i] == sl;
    assert s.slots[i] in s.slots;
  }
  forall c | c in after.feedClues
    ensures exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
  {
    var oldSl :| oldSl in s.slots && oldSl.slotId == c.slotId && c.marketEpoch <= oldSl.marketEpoch;
    var i :| 0 <= i < |s.slots| && s.slots[i] == oldSl;
    assert after.slots[i] in after.slots;
  }
}

lemma EngineArcAdvancePreserves(s: engine__narrativeArc_NarrativeState, slotId: int, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canAdvanceMarketPhase(s, slotId, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_advanceMarketPhase(s, slotId, by_))
{
  var after := engine__narrativeArc_advanceMarketPhase(s, slotId, by_);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcPreserveUniqueCluesWhenFeedUnchanged(s, after);
}

lemma EngineArcPublishCluePreserves(s: engine__narrativeArc_NarrativeState, slotId: int, cluePhase: engine__narrativeArc_CluePhase, clueKey: string, body: string, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canPublishClue(s, slotId, cluePhase, clueKey, body, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_publishClue(s, slotId, cluePhase, clueKey, body, by_))
{
  var after := engine__narrativeArc_publishClue(s, slotId, cluePhase, clueKey, body, by_);
  var found := engine__narrativeArc_findSlot(s.slots, slotId);
  var added := engine__narrativeArc_PublicClue(clueKey, slotId, found.marketEpoch, cluePhase, body);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcUniqueCluesBridge(s);
  EngineArcUniqueCluesBridge(after);
  EngineArcFindSlotMember(s.slots, slotId, engine__narrativeArc_emptySlot);
  var fidx :| 0 <= fidx < |s.slots| && s.slots[fidx].slotId == slotId && found == s.slots[fidx];
  forall sl | sl in after.slots
    ensures !((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))
  {
    var i :| 0 <= i < |after.slots| && after.slots[i] == sl;
    var orig := s.slots[i];
    assert orig in s.slots;
    if orig.slotId == slotId {
      EngineArcSlotAtMatchesFindSlot(s, slotId, i);
      assert orig == found;
      assert !(clueKey in orig.publishedClueIds);
      forall k | k in sl.publishedClueIds
        ensures |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
      {
        var p := (x: string) => (x == k);
        ProofLib.FilterAppend(p, orig.publishedClueIds, clueKey);
        if k in orig.publishedClueIds {
          assert k != clueKey;
        } else {
          assert k == clueKey;
          ProofLib.FilterNone(p, orig.publishedClueIds);
        }
      }
    }
  }
  forall c | c in after.feedClues
    ensures |ProofLib.Filter((d: engine__narrativeArc_PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), after.feedClues)| == 1
  {
    var p := (d: engine__narrativeArc_PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey));
    ProofLib.FilterAppend(p, s.feedClues, added);
    if c in s.feedClues {
      assert !(c.slotId == slotId && c.marketEpoch == found.marketEpoch && c.clueKey == clueKey);
    } else {
      assert c == added;
      ProofLib.FilterNone(p, s.feedClues);
    }
  }
  forall c | c in after.feedClues
    ensures exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
  {
    if c in s.feedClues {
      var oldSl :| oldSl in s.slots && oldSl.slotId == c.slotId && c.marketEpoch <= oldSl.marketEpoch;
      var i :| 0 <= i < |s.slots| && s.slots[i] == oldSl;
      assert after.slots[i] in after.slots;
    } else {
      assert c == added;
      assert after.slots[fidx] in after.slots;
    }
  }
}

lemma EngineArcPrepareProofPreserves(s: engine__narrativeArc_NarrativeState, slotId: int, needsManualReview: bool, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canPrepareProof(s, slotId, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_prepareProof(s, slotId, needsManualReview, by_))
{
  var after := engine__narrativeArc_prepareProof(s, slotId, needsManualReview, by_);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcPreserveUniqueCluesWhenFeedUnchanged(s, after);
  forall i | 0 <= i < |s.slots| && s.slots[i].slotId == slotId
    ensures s.slots[i] == engine__narrativeArc_findSlot(s.slots, slotId)
  {
    EngineArcSlotAtMatchesFindSlot(s, slotId, i);
  }
}

lemma EngineArcSettlePreserves(s: engine__narrativeArc_NarrativeState, slotId: int, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canSettleMarket(s, slotId, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_settleMarket(s, slotId, by_))
{
  var after := engine__narrativeArc_settleMarket(s, slotId, by_);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcPreserveUniqueCluesWhenFeedUnchanged(s, after);
  forall i | 0 <= i < |s.slots| && s.slots[i].slotId == slotId
    ensures s.slots[i] == engine__narrativeArc_findSlot(s.slots, slotId)
  {
    EngineArcSlotAtMatchesFindSlot(s, slotId, i);
  }
}

lemma EngineArcAdminOverridePreserves(s: engine__narrativeArc_NarrativeState, slotId: int, approveYes: bool, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canAdminOverrideHold(s, slotId, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_adminOverrideHold(s, slotId, approveYes, by_))
{
  var after := engine__narrativeArc_adminOverrideHold(s, slotId, approveYes, by_);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcPreserveUniqueCluesWhenFeedUnchanged(s, after);
}

lemma EngineArcReplacePreserves(s: engine__narrativeArc_NarrativeState, slotId: int, newOutcome: engine__narrativeArc_SecretOutcome, by_: engine__narrativeArc_ArcActor)
  requires engine__narrativeArc_inv(s)
  requires engine__narrativeArc_canReplaceMarket(s, slotId, by_)
  ensures engine__narrativeArc_inv(engine__narrativeArc_replaceMarket(s, slotId, newOutcome, by_))
{
  var after := engine__narrativeArc_replaceMarket(s, slotId, newOutcome, by_);
  EngineArcTenMarketSlotsBridge(after);
  EngineArcPreserveSlotIdsUnique(s, after);
  EngineArcPreserveUniqueCluesWhenFeedUnchanged(s, after);
}

lemma EngineArcInitialValid()
  ensures engine__narrativeArc_alwaysTenMarketSlots(engine__narrativeArc_initial)
{
  var s := engine__narrativeArc_initial;
  EngineArcTenMarketSlotsBridge(s);
  forall a | a in s.slots
    ensures |ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots)| == 1
  {
    var i :| 0 <= i < |s.slots| && s.slots[i] == a;
    ProofLib.FilterOne((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots, i);
  }
}

lemma dispatchNpcTickWithBudget_ensures(e: EngineState, actorId: int, actorRole: engine__npcLoop_ActorRole, boundKnown: bool, boundCents: int)
  ensures (inv(e) ==> canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) ==> alwaysAllEngineSubmachinesValid(dispatchNpcTickWithBudget(e, actorId, actorRole, boundKnown, boundCents)))
  ensures (inv(e) ==> canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) ==> alwaysEngineNpcStepsCappedAtFour(dispatchNpcTickWithBudget(e, actorId, actorRole, boundKnown, boundCents)))
  ensures (inv(e) ==> canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "dispatchNpcTickWithBudget", dispatchNpcTickWithBudget(e, actorId, actorRole, boundKnown, boundCents)))
  ensures (inv(e) ==> canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) ==> stepNpcDispatchEnforcesD25Throttle(e, "dispatchNpcTickWithBudget", dispatchNpcTickWithBudget(e, actorId, actorRole, boundKnown, boundCents)))
  ensures (inv(e) ==> canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) ==> stepDeniedDispatchLeavesNpcIdle(e, "dispatchNpcTickWithBudget", dispatchNpcTickWithBudget(e, actorId, actorRole, boundKnown, boundCents)))
{
  if inv(e) && canDispatchNpcTickWithBudget(e, actorId, boundKnown, boundCents) {
    EngineBudgetReservePreserves(e.budget, boundKnown, boundCents);
  }
}

lemma recordPlayerEngaged_ensures(e: EngineState, playerId: int, engagementDelta: int)
  ensures (inv(e) ==> canRecordPlayerEngaged(e, playerId, engagementDelta) ==> alwaysAllEngineSubmachinesValid(recordPlayerEngaged(e, playerId, engagementDelta)))
  ensures (inv(e) ==> canRecordPlayerEngaged(e, playerId, engagementDelta) ==> alwaysEngineNpcStepsCappedAtFour(recordPlayerEngaged(e, playerId, engagementDelta)))
  ensures (inv(e) ==> canRecordPlayerEngaged(e, playerId, engagementDelta) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "recordPlayerEngaged", recordPlayerEngaged(e, playerId, engagementDelta)))
  ensures (inv(e) ==> canRecordPlayerEngaged(e, playerId, engagementDelta) ==> stepNpcDispatchEnforcesD25Throttle(e, "recordPlayerEngaged", recordPlayerEngaged(e, playerId, engagementDelta)))
  ensures (inv(e) ==> canRecordPlayerEngaged(e, playerId, engagementDelta) ==> stepDeniedDispatchLeavesNpcIdle(e, "recordPlayerEngaged", recordPlayerEngaged(e, playerId, engagementDelta)))
{
  if inv(e) && canRecordPlayerEngaged(e, playerId, engagementDelta) {
    EngineNpcRecordEngagementPreserves(e.npc, playerId, engagementDelta, engine__npcLoop_LoopSender.HumanEngager);
  }
}

lemma confirmNpcSpend_ensures(e: EngineState, attemptId: int, actualCents: int)
  ensures (inv(e) ==> canConfirmNpcSpend(e, attemptId, actualCents) ==> alwaysAllEngineSubmachinesValid(confirmNpcSpend(e, attemptId, actualCents)))
  ensures (inv(e) ==> canConfirmNpcSpend(e, attemptId, actualCents) ==> alwaysEngineNpcStepsCappedAtFour(confirmNpcSpend(e, attemptId, actualCents)))
  ensures (inv(e) ==> canConfirmNpcSpend(e, attemptId, actualCents) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "confirmNpcSpend", confirmNpcSpend(e, attemptId, actualCents)))
  ensures (inv(e) ==> canConfirmNpcSpend(e, attemptId, actualCents) ==> stepNpcDispatchEnforcesD25Throttle(e, "confirmNpcSpend", confirmNpcSpend(e, attemptId, actualCents)))
  ensures (inv(e) ==> canConfirmNpcSpend(e, attemptId, actualCents) ==> stepDeniedDispatchLeavesNpcIdle(e, "confirmNpcSpend", confirmNpcSpend(e, attemptId, actualCents)))
{
  if inv(e) && canConfirmNpcSpend(e, attemptId, actualCents) {
    EngineBudgetConfirmPreserves(e.budget, attemptId, actualCents);
  }
}

lemma markNpcSpendUncertain_ensures(e: EngineState, attemptId: int)
  ensures (inv(e) ==> canMarkNpcSpendUncertain(e, attemptId) ==> alwaysAllEngineSubmachinesValid(markNpcSpendUncertain(e, attemptId)))
  ensures (inv(e) ==> canMarkNpcSpendUncertain(e, attemptId) ==> alwaysEngineNpcStepsCappedAtFour(markNpcSpendUncertain(e, attemptId)))
  ensures (inv(e) ==> canMarkNpcSpendUncertain(e, attemptId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "markNpcSpendUncertain", markNpcSpendUncertain(e, attemptId)))
  ensures (inv(e) ==> canMarkNpcSpendUncertain(e, attemptId) ==> stepNpcDispatchEnforcesD25Throttle(e, "markNpcSpendUncertain", markNpcSpendUncertain(e, attemptId)))
  ensures (inv(e) ==> canMarkNpcSpendUncertain(e, attemptId) ==> stepDeniedDispatchLeavesNpcIdle(e, "markNpcSpendUncertain", markNpcSpendUncertain(e, attemptId)))
{
  if inv(e) && canMarkNpcSpendUncertain(e, attemptId) {
    EngineBudgetMarkUncertainPreserves(e.budget, attemptId);
  }
}

lemma rolloverBudgetDay_ensures(e: EngineState, newDay: int)
  ensures (inv(e) ==> canRolloverBudgetDay(e, newDay) ==> alwaysAllEngineSubmachinesValid(rolloverBudgetDay(e, newDay)))
  ensures (inv(e) ==> canRolloverBudgetDay(e, newDay) ==> alwaysEngineNpcStepsCappedAtFour(rolloverBudgetDay(e, newDay)))
  ensures (inv(e) ==> canRolloverBudgetDay(e, newDay) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "rolloverBudgetDay", rolloverBudgetDay(e, newDay)))
  ensures (inv(e) ==> canRolloverBudgetDay(e, newDay) ==> stepNpcDispatchEnforcesD25Throttle(e, "rolloverBudgetDay", rolloverBudgetDay(e, newDay)))
  ensures (inv(e) ==> canRolloverBudgetDay(e, newDay) ==> stepDeniedDispatchLeavesNpcIdle(e, "rolloverBudgetDay", rolloverBudgetDay(e, newDay)))
{
  if inv(e) && canRolloverBudgetDay(e, newDay) {
    EngineBudgetRolloverPreserves(e.budget, newDay);
  }
}

lemma advanceMarketSlot_ensures(e: EngineState, slotId: int)
  ensures (inv(e) ==> canAdvanceMarketSlot(e, slotId) ==> alwaysAllEngineSubmachinesValid(advanceMarketSlot(e, slotId)))
  ensures (inv(e) ==> canAdvanceMarketSlot(e, slotId) ==> alwaysEngineNpcStepsCappedAtFour(advanceMarketSlot(e, slotId)))
  ensures (inv(e) ==> canAdvanceMarketSlot(e, slotId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "advanceMarketSlot", advanceMarketSlot(e, slotId)))
  ensures (inv(e) ==> canAdvanceMarketSlot(e, slotId) ==> stepNpcDispatchEnforcesD25Throttle(e, "advanceMarketSlot", advanceMarketSlot(e, slotId)))
  ensures (inv(e) ==> canAdvanceMarketSlot(e, slotId) ==> stepDeniedDispatchLeavesNpcIdle(e, "advanceMarketSlot", advanceMarketSlot(e, slotId)))
{
  if inv(e) && canAdvanceMarketSlot(e, slotId) {
    EngineArcAdvancePreserves(e.arcs, slotId, engine__narrativeArc_ArcActor.ArcSystem);
  }
}

lemma publishMarketClue_ensures(e: EngineState, slotId: int, cluePhase: engine__narrativeArc_CluePhase, clueKey: string, body: string)
  ensures (inv(e) ==> canPublishMarketClue(e, slotId, cluePhase, clueKey, body) ==> alwaysAllEngineSubmachinesValid(publishMarketClue(e, slotId, cluePhase, clueKey, body)))
  ensures (inv(e) ==> canPublishMarketClue(e, slotId, cluePhase, clueKey, body) ==> alwaysEngineNpcStepsCappedAtFour(publishMarketClue(e, slotId, cluePhase, clueKey, body)))
  ensures (inv(e) ==> canPublishMarketClue(e, slotId, cluePhase, clueKey, body) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "publishMarketClue", publishMarketClue(e, slotId, cluePhase, clueKey, body)))
  ensures (inv(e) ==> canPublishMarketClue(e, slotId, cluePhase, clueKey, body) ==> stepNpcDispatchEnforcesD25Throttle(e, "publishMarketClue", publishMarketClue(e, slotId, cluePhase, clueKey, body)))
  ensures (inv(e) ==> canPublishMarketClue(e, slotId, cluePhase, clueKey, body) ==> stepDeniedDispatchLeavesNpcIdle(e, "publishMarketClue", publishMarketClue(e, slotId, cluePhase, clueKey, body)))
{
  if inv(e) && canPublishMarketClue(e, slotId, cluePhase, clueKey, body) {
    EngineArcPublishCluePreserves(e.arcs, slotId, cluePhase, clueKey, body, engine__narrativeArc_ArcActor.ArcSystem);
  }
}

lemma prepareMarketProof_ensures(e: EngineState, slotId: int, needsManualReview: bool)
  ensures (inv(e) ==> canPrepareMarketProof(e, slotId) ==> alwaysAllEngineSubmachinesValid(prepareMarketProof(e, slotId, needsManualReview)))
  ensures (inv(e) ==> canPrepareMarketProof(e, slotId) ==> alwaysEngineNpcStepsCappedAtFour(prepareMarketProof(e, slotId, needsManualReview)))
  ensures (inv(e) ==> canPrepareMarketProof(e, slotId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "prepareMarketProof", prepareMarketProof(e, slotId, needsManualReview)))
  ensures (inv(e) ==> canPrepareMarketProof(e, slotId) ==> stepNpcDispatchEnforcesD25Throttle(e, "prepareMarketProof", prepareMarketProof(e, slotId, needsManualReview)))
  ensures (inv(e) ==> canPrepareMarketProof(e, slotId) ==> stepDeniedDispatchLeavesNpcIdle(e, "prepareMarketProof", prepareMarketProof(e, slotId, needsManualReview)))
{
  if inv(e) && canPrepareMarketProof(e, slotId) {
    EngineArcPrepareProofPreserves(e.arcs, slotId, needsManualReview, engine__narrativeArc_ArcActor.ArcSystem);
  }
}

lemma settleMarketSlot_ensures(e: EngineState, slotId: int)
  ensures (inv(e) ==> canSettleMarketSlot(e, slotId) ==> alwaysAllEngineSubmachinesValid(settleMarketSlot(e, slotId)))
  ensures (inv(e) ==> canSettleMarketSlot(e, slotId) ==> alwaysEngineNpcStepsCappedAtFour(settleMarketSlot(e, slotId)))
  ensures (inv(e) ==> canSettleMarketSlot(e, slotId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "settleMarketSlot", settleMarketSlot(e, slotId)))
  ensures (inv(e) ==> canSettleMarketSlot(e, slotId) ==> stepNpcDispatchEnforcesD25Throttle(e, "settleMarketSlot", settleMarketSlot(e, slotId)))
  ensures (inv(e) ==> canSettleMarketSlot(e, slotId) ==> stepDeniedDispatchLeavesNpcIdle(e, "settleMarketSlot", settleMarketSlot(e, slotId)))
{
  if inv(e) && canSettleMarketSlot(e, slotId) {
    EngineArcSettlePreserves(e.arcs, slotId, engine__narrativeArc_ArcActor.ArcSystem);
  }
}

lemma adminResolveMarketHold_ensures(e: EngineState, slotId: int, approveYes: bool)
  ensures (inv(e) ==> canAdminResolveMarketHold(e, slotId) ==> alwaysAllEngineSubmachinesValid(adminResolveMarketHold(e, slotId, approveYes)))
  ensures (inv(e) ==> canAdminResolveMarketHold(e, slotId) ==> alwaysEngineNpcStepsCappedAtFour(adminResolveMarketHold(e, slotId, approveYes)))
  ensures (inv(e) ==> canAdminResolveMarketHold(e, slotId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "adminResolveMarketHold", adminResolveMarketHold(e, slotId, approveYes)))
  ensures (inv(e) ==> canAdminResolveMarketHold(e, slotId) ==> stepNpcDispatchEnforcesD25Throttle(e, "adminResolveMarketHold", adminResolveMarketHold(e, slotId, approveYes)))
  ensures (inv(e) ==> canAdminResolveMarketHold(e, slotId) ==> stepDeniedDispatchLeavesNpcIdle(e, "adminResolveMarketHold", adminResolveMarketHold(e, slotId, approveYes)))
{
  if inv(e) && canAdminResolveMarketHold(e, slotId) {
    EngineArcAdminOverridePreserves(e.arcs, slotId, approveYes, engine__narrativeArc_ArcActor.ArcAdmin);
  }
}

lemma replaceMarketSlot_ensures(e: EngineState, slotId: int, seedYes: bool)
  ensures (inv(e) ==> canReplaceMarketSlot(e, slotId) ==> alwaysAllEngineSubmachinesValid(replaceMarketSlot(e, slotId, seedYes)))
  ensures (inv(e) ==> canReplaceMarketSlot(e, slotId) ==> alwaysEngineNpcStepsCappedAtFour(replaceMarketSlot(e, slotId, seedYes)))
  ensures (inv(e) ==> canReplaceMarketSlot(e, slotId) ==> stepMinuteTickNeverTouchesBudgetOrNpc(e, "replaceMarketSlot", replaceMarketSlot(e, slotId, seedYes)))
  ensures (inv(e) ==> canReplaceMarketSlot(e, slotId) ==> stepNpcDispatchEnforcesD25Throttle(e, "replaceMarketSlot", replaceMarketSlot(e, slotId, seedYes)))
  ensures (inv(e) ==> canReplaceMarketSlot(e, slotId) ==> stepDeniedDispatchLeavesNpcIdle(e, "replaceMarketSlot", replaceMarketSlot(e, slotId, seedYes)))
{
  if inv(e) && canReplaceMarketSlot(e, slotId) {
    EngineArcReplacePreserves(
      e.arcs,
      slotId,
      if seedYes then engine__narrativeArc_SecretOutcome.SecretYes else engine__narrativeArc_SecretOutcome.SecretNo,
      engine__narrativeArc_ArcActor.ArcSystem
    );
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  EngineArcInitialValid();
}
