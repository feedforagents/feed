// spec/app/gameplayJourney.md, "End-to-end journey invariants and witness path"

lemma TenMarketSlotsBridge(s: engine__narrativeArc_NarrativeState)
  ensures engine__narrativeArc_alwaysTenMarketSlots(s) == (
    (|s.slots| == 10) &&
    !((exists sl :: sl in s.slots && !(((((sl.slotId >= 0) && (sl.slotId < 10)) && (sl.marketEpoch >= 1)) && (sl.retryCount >= 0))))) &&
    !((exists a :: a in s.slots && !((|ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots)| == 1)))) &&
    (s.totalSettled >= 0) &&
    (s.totalReplaced >= 0)
  )
{
}

lemma UniqueCluesBridge(s: engine__narrativeArc_NarrativeState)
  ensures engine__narrativeArc_alwaysUniqueClues(s) == (
    !((exists sl :: sl in s.slots && !(!((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))))) &&
    !((exists c :: c in s.feedClues && !((|ProofLib.Filter((d: engine__narrativeArc_PublicClue) => (((d.slotId == c.slotId) && (d.marketEpoch == c.marketEpoch)) && (d.clueKey == c.clueKey)), s.feedClues)| == 1)))) &&
    !((exists c :: c in s.feedClues && !((exists sl :: sl in s.slots && ((sl.slotId == c.slotId) && (c.marketEpoch <= sl.marketEpoch))))))
  )
{
}

lemma AttemptIdsUniqueBridge(b: engine__spendBudget_BudgetLedger)
  ensures engine__spendBudget_alwaysAttemptIdsUnique(b) == !((exists a :: a in b.attempts && !((|ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), b.attempts)| == 1))))
{
}

lemma SlotsSameIdsAndClues(before: engine__narrativeArc_NarrativeState, after: engine__narrativeArc_NarrativeState)
  requires engine__narrativeArc_alwaysTenMarketSlots(before)
  requires engine__narrativeArc_alwaysUniqueClues(before)
  requires |after.slots| == |before.slots|
  requires after.feedClues == before.feedClues
  requires after.totalSettled >= 0 && after.totalReplaced >= 0
  requires forall i :: 0 <= i < |before.slots| ==>
    after.slots[i].slotId == before.slots[i].slotId &&
    after.slots[i].marketEpoch == before.slots[i].marketEpoch &&
    after.slots[i].retryCount == before.slots[i].retryCount &&
    after.slots[i].publishedClueIds == before.slots[i].publishedClueIds
  ensures engine__narrativeArc_alwaysTenMarketSlots(after)
  ensures engine__narrativeArc_alwaysUniqueClues(after)
{
  TenMarketSlotsBridge(before);
  TenMarketSlotsBridge(after);
  UniqueCluesBridge(before);
  UniqueCluesBridge(after);
  forall a | a in after.slots
    ensures |ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), after.slots)| == 1
  {
    var idx :| 0 <= idx < |after.slots| && after.slots[idx] == a;
    var orig := before.slots[idx];
    assert orig in before.slots;
    ProofLib.FilterLengthPointwise(
      (b: engine__narrativeArc_MarketSlot) => (b.slotId == orig.slotId),
      (b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId),
      before.slots,
      after.slots
    );
  }
  forall sl | sl in after.slots
    ensures !((exists k :: k in sl.publishedClueIds && !((|ProofLib.Filter((x: string) => (x == k), sl.publishedClueIds)| == 1))))
  {
    var idx :| 0 <= idx < |after.slots| && after.slots[idx] == sl;
    assert before.slots[idx] in before.slots;
  }
  forall c | c in after.feedClues
    ensures exists sl :: sl in after.slots && ((sl.slotId == c.slotId) && (c.marketEpoch <= sl.marketEpoch))
  {
    assert c in before.feedClues;
    var sl0 :| sl0 in before.slots && ((sl0.slotId == c.slotId) && (c.marketEpoch <= sl0.marketEpoch));
    var idx :| 0 <= idx < |before.slots| && before.slots[idx] == sl0;
    assert after.slots[idx] in after.slots;
  }
}

lemma FindSlotAbsent(slots: seq<engine__narrativeArc_MarketSlot>, slotId: int, init: engine__narrativeArc_MarketSlot)
  requires forall j :: 0 <= j < |slots| ==> slots[j].slotId != slotId
  ensures Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), init, slots) == init
  decreases |slots|
{
  if |slots| > 0 {
    assert forall j :: 0 <= j < |slots[1..]| ==> slots[1..][j] == slots[j + 1];
    FindSlotAbsent(slots[1..], slotId, init);
  }
}

lemma FindSlotUnique(slots: seq<engine__narrativeArc_MarketSlot>, slotId: int, idx: int, init: engine__narrativeArc_MarketSlot)
  requires 0 <= idx < |slots|
  requires slots[idx].slotId == slotId
  requires forall j :: 0 <= j < |slots| && j != idx ==> slots[j].slotId != slotId
  ensures Std.Collections.Seq.FoldLeft((found: engine__narrativeArc_MarketSlot, sl: engine__narrativeArc_MarketSlot) => (if (sl.slotId == slotId) then sl else found), init, slots) == slots[idx]
  decreases |slots|
{
  assert forall j :: 0 <= j < |slots[1..]| ==> slots[1..][j] == slots[j + 1];
  if idx == 0 {
    FindSlotAbsent(slots[1..], slotId, slots[0]);
  } else {
    FindSlotUnique(slots[1..], slotId, idx - 1, init);
  }
}

lemma FindSlotAtIndex(s: engine__narrativeArc_NarrativeState, idx: int)
  requires engine__narrativeArc_alwaysTenMarketSlots(s)
  requires 0 <= idx < |s.slots|
  ensures engine__narrativeArc_findSlot(s.slots, s.slots[idx].slotId) == s.slots[idx]
{
  TenMarketSlotsBridge(s);
  var target := s.slots[idx];
  assert target in s.slots;
  ProofLib.FilterCountOneIffUnique(
    (b: engine__narrativeArc_MarketSlot) => (b.slotId == target.slotId),
    s.slots,
    (b: engine__narrativeArc_MarketSlot) => b.slotId,
    idx
  );
  FindSlotUnique(s.slots, target.slotId, idx, engine__narrativeArc_emptySlot);
}

// spec/app/gameplayJourney.md, "Bounded NPC tick moves spot index price and sends alpha invite; market settles 1 pt per winning share"

lemma expireMarketSlot_ensures(j: JourneyState, slotId: int)
  ensures (inv(j) ==> canExpireMarketSlot(j, slotId) ==> alwaysJourneySubmachinesConsistent(expireMarketSlot(j, slotId)))
  ensures (inv(j) ==> canExpireMarketSlot(j, slotId) ==> alwaysEconomyAndSingleAgentConstraints(expireMarketSlot(j, slotId)))
  ensures (inv(j) ==> canExpireMarketSlot(j, slotId) ==> alwaysBudgetAttemptBoundsValid(expireMarketSlot(j, slotId)))
  ensures (inv(j) ==> canExpireMarketSlot(j, slotId) ==> stepStripePurchaseDoesNotChangeProfitRank(j, "expireMarketSlot", expireMarketSlot(j, slotId)))
{
  if inv(j) && canExpireMarketSlot(j, slotId) {
    var after := expireMarketSlot(j, slotId);
    SlotsSameIdsAndClues(j.arcs, after.arcs);
  }
}

lemma prepareMarketProof_ensures(j: JourneyState, slotId: int, needsManualReview: bool)
  ensures (inv(j) ==> canPrepareMarketProof(j, slotId) ==> alwaysJourneySubmachinesConsistent(prepareMarketProof(j, slotId, needsManualReview)))
  ensures (inv(j) ==> canPrepareMarketProof(j, slotId) ==> alwaysEconomyAndSingleAgentConstraints(prepareMarketProof(j, slotId, needsManualReview)))
  ensures (inv(j) ==> canPrepareMarketProof(j, slotId) ==> alwaysBudgetAttemptBoundsValid(prepareMarketProof(j, slotId, needsManualReview)))
  ensures (inv(j) ==> canPrepareMarketProof(j, slotId) ==> stepStripePurchaseDoesNotChangeProfitRank(j, "prepareMarketProof", prepareMarketProof(j, slotId, needsManualReview)))
{
  if inv(j) && canPrepareMarketProof(j, slotId) {
    var after := prepareMarketProof(j, slotId, needsManualReview);
    SlotsSameIdsAndClues(j.arcs, after.arcs);
    forall i | 0 <= i < |j.arcs.slots| && j.arcs.slots[i].slotId == slotId
      ensures j.arcs.slots[i] == engine__narrativeArc_findSlot(j.arcs.slots, slotId)
      ensures j.arcs.slots[i].publishedProof == ""
      ensures j.arcs.slots[i].outcomeAssigned
    {
      FindSlotAtIndex(j.arcs, i);
      assert j.arcs.slots[i] in j.arcs.slots;
    }
  }
}

lemma settleMarketAndPayout_ensures(j: JourneyState, slotId: int)
  ensures (inv(j) ==> canSettleMarketAndPayout(j, slotId) ==> alwaysJourneySubmachinesConsistent(settleMarketAndPayout(j, slotId)))
  ensures (inv(j) ==> canSettleMarketAndPayout(j, slotId) ==> alwaysEconomyAndSingleAgentConstraints(settleMarketAndPayout(j, slotId)))
  ensures (inv(j) ==> canSettleMarketAndPayout(j, slotId) ==> alwaysBudgetAttemptBoundsValid(settleMarketAndPayout(j, slotId)))
  ensures (inv(j) ==> canSettleMarketAndPayout(j, slotId) ==> stepStripePurchaseDoesNotChangeProfitRank(j, "settleMarketAndPayout", settleMarketAndPayout(j, slotId)))
{
  if inv(j) && canSettleMarketAndPayout(j, slotId) {
    var after := settleMarketAndPayout(j, slotId);
    SlotsSameIdsAndClues(j.arcs, after.arcs);
    forall i | 0 <= i < |j.arcs.slots| && j.arcs.slots[i].slotId == slotId
      ensures j.arcs.slots[i] == engine__narrativeArc_findSlot(j.arcs.slots, slotId)
    {
      FindSlotAtIndex(j.arcs, i);
    }
  }
}

lemma runNpcTickSpotAndAlpha_ensures(j: JourneyState, actorId: int, boundCents: int, actualCents: int, spotDelta: int)
  ensures (inv(j) ==> canRunNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta) ==> alwaysJourneySubmachinesConsistent(runNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta)))
  ensures (inv(j) ==> canRunNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta) ==> alwaysEconomyAndSingleAgentConstraints(runNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta)))
  ensures (inv(j) ==> canRunNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta) ==> alwaysBudgetAttemptBoundsValid(runNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta)))
  ensures (inv(j) ==> canRunNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta) ==> stepStripePurchaseDoesNotChangeProfitRank(j, "runNpcTickSpotAndAlpha", runNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta)))
{
  if inv(j) && canRunNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta) {
    var after := runNpcTickSpotAndAlpha(j, actorId, boundCents, actualCents, spotDelta);
    var b0 := j.budget;
    var b1 := engine__spendBudget_reserveAttempt(b0, true, boundCents);
    var b2 := engine__spendBudget_confirmSpend(b1, b0.nextAttemptId, actualCents);
    var aNew := engine__spendBudget_SpendAttempt(b0.nextAttemptId, b0.currentDay, boundCents, 0, engine__spendBudget_AttemptStatus.AttemptReserved);
    var aSettled := aNew.(actualCents := actualCents, attemptStatus := engine__spendBudget_AttemptStatus.AttemptSettled);
    assert b1.attempts == b0.attempts + [aNew];
    ProofLib.FoldLeftAppend(
      (found: engine__spendBudget_SpendAttempt, a: engine__spendBudget_SpendAttempt) => (if (a.attemptId == b0.nextAttemptId) then a else found),
      engine__spendBudget_emptyAttempt,
      b0.attempts,
      aNew
    );
    assert engine__spendBudget_findAttempt(b1.attempts, b0.nextAttemptId) == aNew;
    forall i | 0 <= i < |b0.attempts|
      ensures b0.attempts[i].attemptId < b0.nextAttemptId
    {
      assert b0.attempts[i] in b0.attempts;
    }
    assert b2.attempts == b0.attempts + [aSettled];
    ProofLib.FoldLeftAppend(
      (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay == b0.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
      0,
      b0.attempts,
      aSettled
    );
    ProofLib.FoldLeftAppend(
      (acc: int, a: engine__spendBudget_SpendAttempt) => (if ((a.utcDay < b0.currentDay) && (a.attemptStatus.AttemptReserved? || a.attemptStatus.AttemptUncertain?)) then (acc + a.boundCents) else acc),
      0,
      b0.attempts,
      aSettled
    );
    AttemptIdsUniqueBridge(b0);
    AttemptIdsUniqueBridge(b2);
    forall a | a in b2.attempts
      ensures |ProofLib.Filter((x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId), b2.attempts)| == 1
    {
      var p := (x: engine__spendBudget_SpendAttempt) => (x.attemptId == a.attemptId);
      ProofLib.FilterAppend(p, b0.attempts, aSettled);
      if a in b0.attempts {
        assert a.attemptId < b0.nextAttemptId;
      } else {
        assert a == aSettled;
        ProofLib.FilterNone(p, b0.attempts);
      }
    }
    assert after.budget == b2;
  }
}

// spec/app/gameplayJourney.md, "Journey state across web navigation, onboarding, economy, and world engine"

lemma InitialArcsTenSlots()
  ensures engine__narrativeArc_alwaysTenMarketSlots(engine__narrativeArc_initial)
{
  var s := engine__narrativeArc_initial;
  TenMarketSlotsBridge(s);
  assert |s.slots| == 10;
  assert s.slots[0].slotId == 0 && s.slots[1].slotId == 1 && s.slots[2].slotId == 2 && s.slots[3].slotId == 3 && s.slots[4].slotId == 4;
  assert s.slots[5].slotId == 5 && s.slots[6].slotId == 6 && s.slots[7].slotId == 7 && s.slots[8].slotId == 8 && s.slots[9].slotId == 9;
  forall a | a in s.slots
    ensures |ProofLib.Filter((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots)| == 1
  {
    var idx :| 0 <= idx < 10 && s.slots[idx] == a;
    ProofLib.FilterOne((b: engine__narrativeArc_MarketSlot) => (b.slotId == a.slotId), s.slots, idx);
  }
}

lemma InitialArcsOther()
  ensures engine__narrativeArc_alwaysLiveSlotHasSecretOutcome(engine__narrativeArc_initial)
  ensures engine__narrativeArc_alwaysUniqueClues(engine__narrativeArc_initial)
  ensures engine__narrativeArc_alwaysNoPublicProofBeforeResolution(engine__narrativeArc_initial)
  ensures engine__narrativeArc_alwaysPreparedDraftMatchesSecretOutcome(engine__narrativeArc_initial)
  ensures engine__narrativeArc_alwaysResolvedHasProofAndOutcome(engine__narrativeArc_initial)
{
  hide *;
  reveal engine__narrativeArc_initial, engine__narrativeArc_mkSeedSlot, engine__narrativeArc_alwaysLiveSlotHasSecretOutcome, engine__narrativeArc_alwaysUniqueClues, engine__narrativeArc_alwaysNoPublicProofBeforeResolution, engine__narrativeArc_alwaysPreparedDraftMatchesSecretOutcome, engine__narrativeArc_alwaysResolvedHasProofAndOutcome;
}

lemma InitialBudgetValid()
  ensures engine__spendBudget_alwaysAttemptIdsUnique(engine__spendBudget_initial)
  ensures engine__spendBudget_alwaysTotalsMatchAttempts(engine__spendBudget_initial)
  ensures engine__spendBudget_alwaysNonNegativeAndWithinBudget(engine__spendBudget_initial)
  ensures engine__spendBudget_alwaysAttemptBoundsValid(engine__spendBudget_initial)
{
  hide *;
  reveal engine__spendBudget_initial, engine__spendBudget_dailyBudgetCents, engine__spendBudget_alwaysAttemptIdsUnique, engine__spendBudget_alwaysTotalsMatchAttempts, engine__spendBudget_alwaysNonNegativeAndWithinBudget, engine__spendBudget_alwaysAttemptBoundsValid, engine__spendBudget_sumReservedForToday, engine__spendBudget_sumPrevReserved, engine__spendBudget_committedCents, Std.Collections.Seq.FoldLeft;
}

lemma InitialNavOnbNpcValid()
  ensures app__navigation_alwaysNoLoginModalOnLoad(app__navigation_initial)
  ensures app__navigation_alwaysLoggedOutDefaultsLatest(app__navigation_initial)
  ensures app__navigation_alwaysBannerDelayedForVisitors(app__navigation_initial)
  ensures app__navigation_alwaysProtectedRoutesRequireAuth(app__navigation_initial)
  ensures app__navigation_alwaysSocialModeNeverOnMarkets(app__navigation_initial)
  ensures app__onboarding_alwaysSignedInClearsPendingAndClosesSheet(app__onboarding_initial)
  ensures app__onboarding_alwaysStartingGrantAtMostOnce(app__onboarding_initial)
  ensures engine__npcLoop_alwaysNpcRolesOnly(engine__npcLoop_initial)
  ensures engine__npcLoop_alwaysStepsBounded(engine__npcLoop_initial)
  ensures engine__npcLoop_alwaysSpotIndexPositive(engine__npcLoop_initial)
{
  hide *;
  reveal app__navigation_initial, app__onboarding_initial, app__onboarding_noPendingAction, engine__npcLoop_initial, engine__npcLoop_initialSpotPrice, app__navigation_alwaysNoLoginModalOnLoad, app__navigation_alwaysLoggedOutDefaultsLatest, app__navigation_alwaysBannerDelayedForVisitors, app__navigation_alwaysProtectedRoutesRequireAuth, app__navigation_alwaysSocialModeNeverOnMarkets, app__navigation_showBottomBanner, app__onboarding_alwaysSignedInClearsPendingAndClosesSheet, app__onboarding_alwaysStartingGrantAtMostOnce, engine__npcLoop_alwaysNpcRolesOnly, engine__npcLoop_alwaysStepsBounded, engine__npcLoop_alwaysSpotIndexPositive;
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  hide *;
  reveal initial, initialHolds, inv, alwaysJourneySubmachinesConsistent, alwaysEconomyAndSingleAgentConstraints, alwaysBudgetAttemptBoundsValid, computeNetProfitCents, computeEquityCents, app__navigation_initial, app__onboarding_initial;
  InitialArcsTenSlots();
  InitialArcsOther();
  InitialBudgetValid();
  InitialNavOnbNpcValid();
}
