lemma EngagementUniqueBridge(s: NpcLoopState)
  ensures alwaysEngagementUniqueAndNonNegative(s) == (
    !((exists e :: e in s.engagements && !(((e.playerId > 0) && (e.score >= 0))))) &&
    !((exists a :: a in s.engagements && !((|ProofLib.Filter((b: PlayerEngagement) => (b.playerId == a.playerId), s.engagements)| == 1)))) &&
    !((exists rec :: rec in s.alphaInvites && !((playerScore(s.engagements, rec.playerId) >= minAlphaEngagement))))
  )
{
}

lemma PlayerScoreMonotone(xs: seq<PlayerEngagement>, ys: seq<PlayerEngagement>, pid: int, init1: int, init2: int)
  requires |xs| == |ys|
  requires init1 <= init2
  requires forall i :: 0 <= i < |xs| ==> xs[i].playerId == ys[i].playerId && xs[i].score <= ys[i].score
  ensures Std.Collections.Seq.FoldLeft((acc: int, e: PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init1, xs) <= Std.Collections.Seq.FoldLeft((acc: int, e: PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init2, ys)
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    PlayerScoreMonotone(
      xs[1..],
      ys[1..],
      pid,
      if xs[0].playerId == pid then xs[0].score else init1,
      if ys[0].playerId == pid then ys[0].score else init2
    );
  }
}

lemma PlayerScoreAbsent(xs: seq<PlayerEngagement>, pid: int, init: int)
  requires forall e :: e in xs ==> e.playerId != pid
  ensures Std.Collections.Seq.FoldLeft((acc: int, e: PlayerEngagement) => (if (e.playerId == pid) then e.score else acc), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall e :: e in xs[1..] ==> e in xs;
    PlayerScoreAbsent(xs[1..], pid, init);
  }
}

lemma recordPlayerEngagement_ensures(s: NpcLoopState, playerId: int, engagementDelta: int, by_: LoopSender)
  ensures (inv(s) ==> canRecordPlayerEngagement(s, playerId, engagementDelta, by_) ==> alwaysNpcRolesOnly(recordPlayerEngagement(s, playerId, engagementDelta, by_)))
  ensures (inv(s) ==> canRecordPlayerEngagement(s, playerId, engagementDelta, by_) ==> alwaysStepsBounded(recordPlayerEngagement(s, playerId, engagementDelta, by_)))
  ensures (inv(s) ==> canRecordPlayerEngagement(s, playerId, engagementDelta, by_) ==> alwaysSpotIndexPositive(recordPlayerEngagement(s, playerId, engagementDelta, by_)))
  ensures (inv(s) ==> canRecordPlayerEngagement(s, playerId, engagementDelta, by_) ==> alwaysEngagementUniqueAndNonNegative(recordPlayerEngagement(s, playerId, engagementDelta, by_)))
  ensures (inv(s) ==> canRecordPlayerEngagement(s, playerId, engagementDelta, by_) ==> stepSpotOnlyMovesOnNpcSpot(s, "recordPlayerEngagement", recordPlayerEngagement(s, playerId, engagementDelta, by_)))
{
  if inv(s) && canRecordPlayerEngagement(s, playerId, engagementDelta, by_) {
    var after := recordPlayerEngagement(s, playerId, engagementDelta, by_);
    EngagementUniqueBridge(s);
    EngagementUniqueBridge(after);
    if exists e :: e in s.engagements && e.playerId == playerId {
      forall a | a in after.engagements
        ensures |ProofLib.Filter((b: PlayerEngagement) => (b.playerId == a.playerId), after.engagements)| == 1
      {
        var idx :| 0 <= idx < |after.engagements| && after.engagements[idx] == a;
        var orig := s.engagements[idx];
        assert orig in s.engagements;
        assert orig.playerId == a.playerId;
        ProofLib.FilterLengthPointwise(
          (b: PlayerEngagement) => (b.playerId == orig.playerId),
          (b: PlayerEngagement) => (b.playerId == a.playerId),
          s.engagements,
          after.engagements
        );
      }
      forall rec | rec in after.alphaInvites
        ensures playerScore(after.engagements, rec.playerId) >= minAlphaEngagement
      {
        PlayerScoreMonotone(s.engagements, after.engagements, rec.playerId, 0, 0);
      }
    } else {
      var added := PlayerEngagement(playerId, engagementDelta);
      forall a | a in after.engagements
        ensures |ProofLib.Filter((b: PlayerEngagement) => (b.playerId == a.playerId), after.engagements)| == 1
      {
        var p := (b: PlayerEngagement) => (b.playerId == a.playerId);
        ProofLib.FilterAppend(p, s.engagements, added);
        if a in s.engagements {
          assert a.playerId != playerId;
        } else {
          assert a == added;
          ProofLib.FilterNone(p, s.engagements);
        }
      }
      forall rec | rec in after.alphaInvites
        ensures playerScore(after.engagements, rec.playerId) >= minAlphaEngagement
      {
        if rec.playerId == playerId {
          PlayerScoreAbsent(s.engagements, rec.playerId, 0);
          assert false;
        }
        ProofLib.FoldLeftAppend(
          (acc: int, e: PlayerEngagement) => (if (e.playerId == rec.playerId) then e.score else acc),
          0,
          s.engagements,
          added
        );
      }
    }
  }
}
