lemma TenSlotsFilter(s: NarrativeState)
  ensures alwaysTenMarketSlots(s) == (((((|s.slots| == 10) && !((exists sl :: sl in s.slots && !(((((sl.slotId >= 0) && (sl.slotId < 10)) && (sl.marketEpoch >= 1)) && (sl.retryCount >= 0)))))) && !((exists a :: a in s.slots && !((|ProofLib.Filter((b: MarketSlot) => (b.slotId == a.slotId), s.slots)| == 1))))) && (s.totalSettled >= 0)) && (s.totalReplaced >= 0))
{
}

lemma UniqueCluesFilter(s: NarrativeState)
  ensures alwaysUniqueClues(s) == ((!((exists sl :: sl in s.slots && !(!((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))))) && !((exists c :: c in s.feedClues && !((|ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), s.feedClues)| == 1))))) && !((exists c :: c in s.feedClues && !((exists sl :: sl in s.slots && ((sl.slotId == c.slotId) && (c.marketEpoch <= sl.marketEpoch)))))))
{
}

lemma UniqueCluesElimSlot(s: NarrativeState, sl: MarketSlot, k: string)
  requires alwaysUniqueClues(s)
  requires sl in s.slots && k in sl.publishedClueIds
  ensures |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
{
  hide alwaysUniqueClues;
  UniqueCluesFilter(s);
}

lemma UniqueCluesElimFeed(s: NarrativeState, c: PublicClue)
  requires alwaysUniqueClues(s)
  requires c in s.feedClues
  ensures |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), s.feedClues)| == 1
{
  hide alwaysUniqueClues;
  UniqueCluesFilter(s);
}

lemma UniqueCluesElimEpoch(s: NarrativeState, c: PublicClue)
  requires alwaysUniqueClues(s)
  requires c in s.feedClues
  ensures exists sl :: sl in s.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
{
  hide alwaysUniqueClues;
  UniqueCluesFilter(s);
}

lemma UniqueCluesIntro(s: NarrativeState)
  requires forall sl :: sl in s.slots ==> forall k :: k in sl.publishedClueIds ==> |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
  requires forall c :: c in s.feedClues ==> |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), s.feedClues)| == 1
  requires forall c :: c in s.feedClues ==> exists sl :: sl in s.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
  ensures alwaysUniqueClues(s)
{
  hide alwaysUniqueClues;
  UniqueCluesFilter(s);
}

lemma SlotsDistinctIds(s: NarrativeState)
  requires alwaysTenMarketSlots(s)
  ensures forall i :: 0 <= i < |s.slots| ==> s.slots[i].slotId >= 0
  ensures forall i, j :: 0 <= i < |s.slots| && 0 <= j < |s.slots| && i != j ==> s.slots[i].slotId != s.slots[j].slotId
{
  hide alwaysTenMarketSlots;
  TenSlotsFilter(s);
  forall i | 0 <= i < |s.slots|
    ensures s.slots[i].slotId >= 0
  {
    assert s.slots[i] in s.slots;
  }
  forall i, j | 0 <= i < |s.slots| && 0 <= j < |s.slots| && i != j
    ensures s.slots[i].slotId != s.slots[j].slotId
  {
    var a := s.slots[i];
    assert a in s.slots;
    ProofLib.FilterCountOneIffUnique((b: MarketSlot) => (b.slotId == a.slotId), s.slots, (b: MarketSlot) => b.slotId, i);
  }
}

lemma FoldLeftFindSlot(slots: seq<MarketSlot>, acc: MarketSlot, slotId: int)
  requires forall i, j :: 0 <= i < |slots| && 0 <= j < |slots| && i != j ==> slots[i].slotId != slots[j].slotId
  requires forall i :: 0 <= i < |slots| ==> slots[i].slotId != acc.slotId
  ensures var res := Std.Collections.Seq.FoldLeft((found: MarketSlot, sl: MarketSlot) => (if (sl.slotId == slotId) then sl else found), acc, slots);
    (exists i :: 0 <= i < |slots| && slots[i].slotId == slotId && res == slots[i])
    || ((forall i :: 0 <= i < |slots| ==> slots[i].slotId != slotId) && res == acc)
  decreases |slots|
{
  var f := (found: MarketSlot, sl: MarketSlot) => (if (sl.slotId == slotId) then sl else found);
  if |slots| == 0 {
  } else if slots[0].slotId == slotId {
    assert forall j :: 0 <= j < |slots[1..]| ==> slots[1..][j] == slots[j + 1];
    FoldLeftFindSlot(slots[1..], slots[0], slotId);
  } else {
    assert forall j :: 0 <= j < |slots[1..]| ==> slots[1..][j] == slots[j + 1];
    FoldLeftFindSlot(slots[1..], acc, slotId);
    var res := Std.Collections.Seq.FoldLeft(f, acc, slots[1..]);
    if exists i :: 0 <= i < |slots[1..]| && slots[1..][i].slotId == slotId && res == slots[1..][i] {
      var i :| 0 <= i < |slots[1..]| && slots[1..][i].slotId == slotId && res == slots[1..][i];
      assert slots[i + 1] == slots[1..][i];
    }
  }
}

lemma FindSlotSpec(s: NarrativeState, slotId: int)
  requires alwaysTenMarketSlots(s)
  ensures var res := findSlot(s.slots, slotId);
    (exists i :: 0 <= i < |s.slots| && s.slots[i].slotId == slotId && res == s.slots[i])
    || ((forall i :: 0 <= i < |s.slots| ==> s.slots[i].slotId != slotId) && res == emptySlot)
  ensures forall i :: 0 <= i < |s.slots| && s.slots[i].slotId == slotId ==> findSlot(s.slots, slotId) == s.slots[i]
{
  hide alwaysTenMarketSlots;
  SlotsDistinctIds(s);
  FoldLeftFindSlot(s.slots, emptySlot, slotId);
}

lemma PreserveTenSlots(before: NarrativeState, after: NarrativeState)
  requires alwaysTenMarketSlots(before)
  requires |after.slots| == |before.slots|
  requires forall i :: 0 <= i < |before.slots| ==>
    after.slots[i].slotId == before.slots[i].slotId
    && after.slots[i].marketEpoch >= before.slots[i].marketEpoch
    && (after.slots[i].retryCount >= before.slots[i].retryCount || after.slots[i].retryCount == 0)
  requires after.totalSettled >= before.totalSettled && after.totalReplaced >= before.totalReplaced
  ensures alwaysTenMarketSlots(after)
{
  hide alwaysTenMarketSlots;
  TenSlotsFilter(before);
  TenSlotsFilter(after);
  forall sl | sl in after.slots
    ensures sl.slotId >= 0 && sl.slotId < 10 && sl.marketEpoch >= 1 && sl.retryCount >= 0
  {
    var i :| 0 <= i < |after.slots| && after.slots[i] == sl;
    assert before.slots[i] in before.slots;
  }
  forall a | a in after.slots
    ensures |ProofLib.Filter((b: MarketSlot) => (b.slotId == a.slotId), after.slots)| == 1
  {
    var i :| 0 <= i < |after.slots| && after.slots[i] == a;
    var orig := before.slots[i];
    assert orig in before.slots;
    ProofLib.FilterLengthPointwise(
      (b: MarketSlot) => (b.slotId == orig.slotId),
      (b: MarketSlot) => (b.slotId == a.slotId),
      before.slots,
      after.slots
    );
  }
}

lemma PreserveUniqueCluesUnchangedFeed(before: NarrativeState, after: NarrativeState)
  requires alwaysUniqueClues(before)
  requires after.feedClues == before.feedClues
  requires |after.slots| == |before.slots|
  requires forall i :: 0 <= i < |before.slots| ==>
    after.slots[i].slotId == before.slots[i].slotId
    && after.slots[i].marketEpoch >= before.slots[i].marketEpoch
    && (after.slots[i].publishedClueIds == before.slots[i].publishedClueIds || after.slots[i].publishedClueIds == [])
  ensures alwaysUniqueClues(after)
{
  hide alwaysUniqueClues;
  assert forall sl :: sl in after.slots ==> forall k :: k in sl.publishedClueIds ==> |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1 by {
    forall sl | sl in after.slots
      ensures forall k :: k in sl.publishedClueIds ==> |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
    {
      var i :| 0 <= i < |after.slots| && after.slots[i] == sl;
      forall k | k in sl.publishedClueIds
        ensures |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
      {
        assert before.slots[i] in before.slots;
        UniqueCluesElimSlot(before, before.slots[i], k);
      }
    }
  }
  assert forall c :: c in after.feedClues ==> |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), after.feedClues)| == 1 by {
    forall c | c in after.feedClues
      ensures |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), after.feedClues)| == 1
    {
      UniqueCluesElimFeed(before, c);
    }
  }
  assert forall c :: c in after.feedClues ==> exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch by {
    forall c | c in after.feedClues
      ensures exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
    {
      UniqueCluesElimEpoch(before, c);
      var sl0 :| sl0 in before.slots && sl0.slotId == c.slotId && c.marketEpoch <= sl0.marketEpoch;
      var i :| 0 <= i < |before.slots| && before.slots[i] == sl0;
      assert after.slots[i] in after.slots;
    }
  }
  UniqueCluesIntro(after);
}

lemma PreserveUniqueCluesPublishClue(s: NarrativeState, after: NarrativeState, slotId: int, cluePhase: CluePhase, clueKey: string, body: string, by_: ArcActor)
  requires alwaysTenMarketSlots(s)
  requires alwaysUniqueClues(s)
  requires canPublishClue(s, slotId, cluePhase, clueKey, body, by_)
  requires after == publishClue(s, slotId, cluePhase, clueKey, body, by_)
  ensures alwaysUniqueClues(after)
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  FindSlotSpec(s, slotId);
  var target := findSlot(s.slots, slotId);
  var ti :| 0 <= ti < |s.slots| && s.slots[ti].slotId == slotId && target == s.slots[ti];
  var newClue := PublicClue(clueKey, slotId, target.marketEpoch, cluePhase, body);
  assert forall sl :: sl in after.slots ==> forall k :: k in sl.publishedClueIds ==> |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1 by {
    forall sl | sl in after.slots
      ensures forall k :: k in sl.publishedClueIds ==> |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
    {
      var i :| 0 <= i < |after.slots| && after.slots[i] == sl;
      var oldSl := s.slots[i];
      assert oldSl in s.slots;
      forall k | k in sl.publishedClueIds
        ensures |ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1
      {
        if oldSl.slotId == slotId {
          assert oldSl == target;
          ProofLib.FilterAppend((x: string) => (x == k), oldSl.publishedClueIds, clueKey);
          if k == clueKey {
            ProofLib.FilterNone((x: string) => (x == k), oldSl.publishedClueIds);
          } else {
            UniqueCluesElimSlot(s, oldSl, k);
          }
        } else {
          UniqueCluesElimSlot(s, oldSl, k);
        }
      }
    }
  }
  assert forall c :: c in after.feedClues ==> |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), after.feedClues)| == 1 by {
    forall c | c in after.feedClues
      ensures |ProofLib.Filter((d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), after.feedClues)| == 1
    {
      ProofLib.FilterAppend(
        (d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)),
        s.feedClues,
        newClue
      );
      if c == newClue {
        ProofLib.FilterNone(
          (d: PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)),
          s.feedClues
        );
      } else {
        UniqueCluesElimFeed(s, c);
      }
    }
  }
  assert forall c :: c in after.feedClues ==> exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch by {
    forall c | c in after.feedClues
      ensures exists sl :: sl in after.slots && sl.slotId == c.slotId && c.marketEpoch <= sl.marketEpoch
    {
      if c == newClue {
        assert after.slots[ti] in after.slots;
      } else {
        UniqueCluesElimEpoch(s, c);
        var sl0 :| sl0 in s.slots && sl0.slotId == c.slotId && c.marketEpoch <= sl0.marketEpoch;
        var i :| 0 <= i < |s.slots| && s.slots[i] == sl0;
        assert after.slots[i] in after.slots;
      }
    }
  }
  UniqueCluesIntro(after);
}

lemma SlotsIdsMatchIndex(slots: seq<MarketSlot>)
  requires forall j :: 0 <= j < |slots| ==> slots[j].slotId == j
  ensures forall a :: a in slots ==> |ProofLib.Filter((b: MarketSlot) => (b.slotId == a.slotId), slots)| == 1
{
  forall a | a in slots
    ensures |ProofLib.Filter((b: MarketSlot) => (b.slotId == a.slotId), slots)| == 1
  {
    var i :| 0 <= i < |slots| && slots[i] == a;
    ProofLib.FilterOne((b: MarketSlot) => (b.slotId == a.slotId), slots, i);
  }
}

lemma SeedSlotsSatisfyInv(s: NarrativeState)
  requires |s.slots| == 10
  requires s.feedClues == []
  requires s.totalSettled == 0 && s.totalReplaced == 0
  requires forall j :: 0 <= j < 10 ==>
    s.slots[j].slotId == j
    && s.slots[j].marketEpoch == 1
    && s.slots[j].retryCount == 0
    && s.slots[j].outcomeAssigned
    && (s.slots[j].outcome.SecretYes? || s.slots[j].outcome.SecretNo?)
    && isOpenTradingPhase(s.slots[j].phase)
    && s.slots[j].tradingOpen
    && !s.slots[j].proofPrepared
    && s.slots[j].publishedProof == ""
    && s.slots[j].publishedClueIds == []
  ensures inv(s)
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  assert alwaysTenMarketSlots(s) by {
    TenSlotsFilter(s);
    SlotsIdsMatchIndex(s.slots);
  }
  assert alwaysUniqueClues(s) by {
    UniqueCluesIntro(s);
  }
}

lemma advanceMarketPhase_ensures(s: NarrativeState, slotId: int, by_: ArcActor)
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysTenMarketSlots(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysUniqueClues(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(advanceMarketPhase(s, slotId, by_)))
  ensures (inv(s) ==> canAdvanceMarketPhase(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(advanceMarketPhase(s, slotId, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canAdvanceMarketPhase(s, slotId, by_) {
    var after := advanceMarketPhase(s, slotId, by_);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma publishClue_ensures(s: NarrativeState, slotId: int, cluePhase: CluePhase, clueKey: string, body: string, by_: ArcActor)
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysTenMarketSlots(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysLiveSlotHasSecretOutcome(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysUniqueClues(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysTradingMatchesActivePhase(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysNoPublicProofBeforeResolution(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
  ensures (inv(s) ==> canPublishClue(s, slotId, cluePhase, clueKey, body, by_) ==> alwaysResolvedHasProofAndOutcome(publishClue(s, slotId, cluePhase, clueKey, body, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canPublishClue(s, slotId, cluePhase, clueKey, body, by_) {
    var after := publishClue(s, slotId, cluePhase, clueKey, body, by_);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesPublishClue(s, after, slotId, cluePhase, clueKey, body, by_);
  }
}

lemma failProofAttempt_ensures(s: NarrativeState, slotId: int, by_: ArcActor)
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysTenMarketSlots(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysUniqueClues(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(failProofAttempt(s, slotId, by_)))
  ensures (inv(s) ==> canFailProofAttempt(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(failProofAttempt(s, slotId, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canFailProofAttempt(s, slotId, by_) {
    var after := failProofAttempt(s, slotId, by_);
    FindSlotSpec(s, slotId);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma prepareProof_ensures(s: NarrativeState, slotId: int, needsManualReview: bool, by_: ArcActor)
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysTenMarketSlots(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysUniqueClues(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(prepareProof(s, slotId, needsManualReview, by_)))
  ensures (inv(s) ==> canPrepareProof(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(prepareProof(s, slotId, needsManualReview, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canPrepareProof(s, slotId, by_) {
    var after := prepareProof(s, slotId, needsManualReview, by_);
    FindSlotSpec(s, slotId);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma settleMarket_ensures(s: NarrativeState, slotId: int, by_: ArcActor)
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysTenMarketSlots(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysUniqueClues(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(settleMarket(s, slotId, by_)))
  ensures (inv(s) ==> canSettleMarket(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(settleMarket(s, slotId, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canSettleMarket(s, slotId, by_) {
    var after := settleMarket(s, slotId, by_);
    FindSlotSpec(s, slotId);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma adminApproveHold_ensures(s: NarrativeState, slotId: int, by_: ArcActor)
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysTenMarketSlots(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysUniqueClues(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(adminApproveHold(s, slotId, by_)))
  ensures (inv(s) ==> canAdminApproveHold(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(adminApproveHold(s, slotId, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canAdminApproveHold(s, slotId, by_) {
    var after := adminApproveHold(s, slotId, by_);
    FindSlotSpec(s, slotId);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma adminOverrideHold_ensures(s: NarrativeState, slotId: int, approveYes: bool, by_: ArcActor)
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysTenMarketSlots(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysUniqueClues(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(adminOverrideHold(s, slotId, approveYes, by_)))
  ensures (inv(s) ==> canAdminOverrideHold(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(adminOverrideHold(s, slotId, approveYes, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canAdminOverrideHold(s, slotId, by_) {
    var after := adminOverrideHold(s, slotId, approveYes, by_);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma replaceMarket_ensures(s: NarrativeState, slotId: int, newOutcome: SecretOutcome, by_: ArcActor)
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysTenMarketSlots(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysLiveSlotHasSecretOutcome(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysUniqueClues(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysTradingMatchesActivePhase(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysNoPublicProofBeforeResolution(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysPreparedDraftMatchesSecretOutcome(replaceMarket(s, slotId, newOutcome, by_)))
  ensures (inv(s) ==> canReplaceMarket(s, slotId, by_) ==> alwaysResolvedHasProofAndOutcome(replaceMarket(s, slotId, newOutcome, by_)))
{
  hide alwaysTenMarketSlots, alwaysUniqueClues;
  if inv(s) && canReplaceMarket(s, slotId, by_) {
    var after := replaceMarket(s, slotId, newOutcome, by_);
    PreserveTenSlots(s, after);
    PreserveUniqueCluesUnchangedFeed(s, after);
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  hide inv;
  var s := initialHolds();
  forall j | 0 <= j < 10
    ensures s.slots[j].slotId == j
      && s.slots[j].marketEpoch == 1
      && s.slots[j].retryCount == 0
      && s.slots[j].outcomeAssigned
      && (s.slots[j].outcome.SecretYes? || s.slots[j].outcome.SecretNo?)
      && isOpenTradingPhase(s.slots[j].phase)
      && s.slots[j].tradingOpen
      && !s.slots[j].proofPrepared
      && s.slots[j].publishedProof == ""
      && s.slots[j].publishedClueIds == []
  {
    if j == 0 {
    } else if j == 1 {
    } else if j == 2 {
    } else if j == 3 {
    } else if j == 4 {
    } else if j == 5 {
    } else if j == 6 {
    } else if j == 7 {
    } else if j == 8 {
    } else {
      assert j == 9;
    }
  }
  SeedSlotsSatisfyInv(s);
}
