# Engine and world simulation coordinator

The Feed (`feed.fun`) autonomous world engine, coordinating:

- [World clock and scheduled jobs](./worldClock.md)
- [D-25 spend enforcement](./spendBudget.md)
- [Narrative market arcs and secret outcome isolation](./narrativeArc.md)
- [Bounded NPC Eliza v4 tick loop](./npcLoop.md)

## Domain

### Combined engine state

`EngineState` composes the four engine sub-machines so that minute ticks remain
non-blocking, NPC inference respects D-25 budget reservations and utilization
throttles, NPC spot trades drive the persisted perp index, and prediction
market clues and proofs keep hidden outcomes isolated until settlement.

```quint
import worldClock as WC from "./worldClock"
import spendBudget as SB from "./spendBudget"
import narrativeArc as NA from "./narrativeArc"
import npcLoop as NL from "./npcLoop"

type EngineState = {
  clock: WC::WorldClockState,
  budget: SB::BudgetLedger,
  arcs: NA::NarrativeState,
  npc: NL::NpcLoopState,
}

pure val initial: EngineState = {
  clock: WC::initial,
  budget: SB::initial,
  arcs: NA::initial,
  npc: NL::initial,
}

pure val flippedWindowsValues = Set(0, 1, 2)
pure val newlyExpiredValues = Set(0, 1)
pure val slotIdValues = Set(0, 1, 6, 8, 9)
pure val clueKeyValues = Set("clue-1", "clue-2")
pure val bodyValues = Set("rumor", "leak")
pure val boundCentsValues = Set(0, 500, 1000, 4500, 9000)
pure val actualCentsValues = Set(0, 500, 1000)
pure val attemptIdValues = Set(1, 2, 3)
pure val newDayValues = Set(1, 2)
pure val actorIdValues = Set(1, 2)
pure val spotDeltaValues = Set(-200, 200, 500)
pure val playerIdValues = Set(1, 2)
pure val engagementDeltaValues = Set(1, 2)

pure val weight_dispatchNpcTickWithBudget = 3
pure val weight_npcEndTick = 2
pure val weight_advanceMarketSlot = 3
pure val weight_prepareMarketProof = 3
pure val weight_settleMarketSlot = 3
```

## Story: Run non-blocking minute ticks and D-25 bounded NPC loops

> As an operator, I want the world clock to tick every minute without waiting
> on LLM inference while NPC ticks reserve D-25 budget atomically and throttle
> batch size and steps under utilization thresholds.

### Minute ticks advance committed time without calling an LLM or spending budget

```quint
pure def canTickMinute(e: EngineState, flippedWindows: int, newlyExpired: int): bool =
  WC::canRunMinuteTick(e.clock, flippedWindows, newlyExpired)

pure def tickMinute(e: EngineState, flippedWindows: int, newlyExpired: int): EngineState =
  { ...e, clock: WC::runMinuteTick(e.clock, flippedWindows, newlyExpired) }
```

### Dispatching an NPC tick atomically reserves D-25 budget and applies utilization throttles

```quint
pure def canDispatchNpcTickWithBudget(
  e: EngineState,
  actorId: int,
  boundKnown: bool,
  boundCents: int
): bool =
  e.clock.running
    and SB::canReserveAttempt(e.budget, boundKnown, boundCents)
    and NL::canStartNpcTick(
      e.npc,
      actorId,
      SB::maxStepsAllowed(e.budget),
      SB::effectiveBatch(e.budget, SB::baseNpcBatch),
      NL::EngineNpcRunner
    )

pure def dispatchNpcTickWithBudget(
  e: EngineState,
  actorId: int,
  actorRole: NL::ActorRole,
  boundKnown: bool,
  boundCents: int
): EngineState =
  val nextSteps = SB::maxStepsAllowed(e.budget)
  val nextBatch = SB::effectiveBatch(e.budget, SB::baseNpcBatch)
  {
    ...e,
    clock: WC::runCoreCadenceJob(e.clock, WC::RouteNpcTick),
    budget: SB::reserveAttempt(e.budget, boundKnown, boundCents),
    npc: NL::startNpcTick(e.npc, actorId, actorRole, nextSteps, nextBatch, NL::EngineNpcRunner),
  }

pure def canDenyNpcDispatchOnBudget(e: EngineState, boundKnown: bool, boundCents: int): bool =
  SB::canDenyReservation(e.budget, boundKnown, boundCents)

pure def denyNpcDispatchOnBudget(e: EngineState, boundKnown: bool, boundCents: int): EngineState =
  { ...e, budget: SB::denyReservation(e.budget, boundKnown, boundCents) }
```

### NPC ticks observe, decide, act within step bounds, and settle D-25 spend

```quint
pure def canNpcObserve(e: EngineState): bool =
  NL::canObserveFeed(e.npc, NL::EngineNpcRunner)

pure def npcObserve(e: EngineState): EngineState =
  { ...e, npc: NL::observeFeed(e.npc, NL::EngineNpcRunner) }

pure def canNpcDecide(e: EngineState, actionKind: NL::NpcActionKind): bool =
  NL::canDecideAction(e.npc, actionKind, NL::EngineNpcRunner)

pure def npcDecide(e: EngineState, actionKind: NL::NpcActionKind): EngineState =
  { ...e, npc: NL::decideAction(e.npc, actionKind, NL::EngineNpcRunner) }

pure def canNpcAct(e: EngineState, spotDelta: int, playerId: int): bool =
  NL::canExecuteNpcAction(e.npc, spotDelta, playerId, NL::EngineNpcRunner)

pure def npcAct(e: EngineState, spotDelta: int, playerId: int): EngineState =
  { ...e, npc: NL::executeNpcAction(e.npc, spotDelta, playerId, NL::EngineNpcRunner) }

pure def canNpcEndTick(e: EngineState): bool =
  NL::canEndNpcTick(e.npc, NL::EngineNpcRunner)

pure def npcEndTick(e: EngineState): EngineState =
  { ...e, npc: NL::endNpcTick(e.npc, NL::EngineNpcRunner) }

pure def canRecordPlayerEngaged(e: EngineState, playerId: int, engagementDelta: int): bool =
  NL::canRecordPlayerEngagement(e.npc, playerId, engagementDelta, NL::HumanEngager)

pure def recordPlayerEngaged(e: EngineState, playerId: int, engagementDelta: int): EngineState =
  { ...e, npc: NL::recordPlayerEngagement(e.npc, playerId, engagementDelta, NL::HumanEngager) }

pure def canConfirmNpcSpend(e: EngineState, attemptId: int, actualCents: int): bool =
  SB::canConfirmSpend(e.budget, attemptId, actualCents)

pure def confirmNpcSpend(e: EngineState, attemptId: int, actualCents: int): EngineState =
  { ...e, budget: SB::confirmSpend(e.budget, attemptId, actualCents) }

pure def canMarkNpcSpendUncertain(e: EngineState, attemptId: int): bool =
  SB::canMarkUncertain(e.budget, attemptId)

pure def markNpcSpendUncertain(e: EngineState, attemptId: int): EngineState =
  { ...e, budget: SB::markUncertain(e.budget, attemptId) }

pure def canRolloverBudgetDay(e: EngineState, newDay: int): bool =
  SB::canRolloverUtcDay(e.budget, newDay)

pure def rolloverBudgetDay(e: EngineState, newDay: int): EngineState =
  { ...e, budget: SB::rolloverUtcDay(e.budget, newDay) }
```

## Story: Coordinate market phase clues, private recovery, and RSS updates

> As an operator, I want market phases, clues, durable proof recovery, and RSS
> refreshes to run cleanly alongside NPC ticks without leaking hidden outcomes.

### Market arcs, phase clues, private proof prep, settlement, and replacement

```quint
pure def canAdvanceMarketSlot(e: EngineState, slotId: int): bool =
  e.clock.running and NA::canAdvanceMarketPhase(e.arcs, slotId, NA::ArcSystem)

pure def advanceMarketSlot(e: EngineState, slotId: int): EngineState =
  { ...e, arcs: NA::advanceMarketPhase(e.arcs, slotId, NA::ArcSystem) }

pure def canPublishMarketClue(
  e: EngineState,
  slotId: int,
  cluePhase: NA::CluePhase,
  clueKey: str,
  body: str
): bool =
  e.clock.running and NA::canPublishClue(e.arcs, slotId, cluePhase, clueKey, body, NA::ArcSystem)

pure def publishMarketClue(
  e: EngineState,
  slotId: int,
  cluePhase: NA::CluePhase,
  clueKey: str,
  body: str
): EngineState =
  { ...e, arcs: NA::publishClue(e.arcs, slotId, cluePhase, clueKey, body, NA::ArcSystem) }

pure def canPrepareMarketProof(e: EngineState, slotId: int): bool =
  e.clock.running and NA::canPrepareProof(e.arcs, slotId, NA::ArcSystem)

pure def prepareMarketProof(e: EngineState, slotId: int, needsManualReview: bool): EngineState =
  { ...e, arcs: NA::prepareProof(e.arcs, slotId, needsManualReview, NA::ArcSystem) }

pure def canSettleMarketSlot(e: EngineState, slotId: int): bool =
  e.clock.running and NA::canSettleMarket(e.arcs, slotId, NA::ArcSystem)

pure def settleMarketSlot(e: EngineState, slotId: int): EngineState =
  { ...e, arcs: NA::settleMarket(e.arcs, slotId, NA::ArcSystem) }

pure def canAdminResolveMarketHold(e: EngineState, slotId: int): bool =
  NA::canAdminOverrideHold(e.arcs, slotId, NA::ArcAdmin)

pure def adminResolveMarketHold(e: EngineState, slotId: int, approveYes: bool): EngineState =
  { ...e, arcs: NA::adminOverrideHold(e.arcs, slotId, approveYes, NA::ArcAdmin) }

pure def canReplaceMarketSlot(e: EngineState, slotId: int): bool =
  e.clock.running and NA::canReplaceMarket(e.arcs, slotId, NA::ArcSystem)

pure def replaceMarketSlot(e: EngineState, slotId: int, seedYes: bool): EngineState =
  { ...e, arcs: NA::seedReplacementMarket(slotId, e.arcs, seedYes, NA::ArcSystem) }

pure def canRefreshRssFeed(e: EngineState, ownerRoute: WC::RouteName): bool =
  WC::canRunRssRefresh(e.clock, ownerRoute)

pure def refreshRssFeed(e: EngineState, ownerRoute: WC::RouteName): EngineState =
  { ...e, clock: WC::runRssRefresh(e.clock, ownerRoute) }
```

### Cross-machine engine invariants and reachability goals

```quint
pure def alwaysAllEngineSubmachinesValid(e: EngineState): bool = and {
  WC::alwaysMinuteTickNeverRunsLlm(e.clock),
  WC::alwaysClockNonNegative(e.clock),
  WC::alwaysNoRetiredRoutesActive(e.clock),
  WC::alwaysSingleRssOwner(e.clock),
  WC::alwaysTickHealthConsistent(e.clock),
  WC::alwaysFundingCutoverSafe(e.clock),
  SB::alwaysAttemptIdsUnique(e.budget),
  SB::alwaysAttemptBoundsValid(e.budget),
  SB::alwaysTotalsMatchAttempts(e.budget),
  SB::alwaysNonNegativeAndWithinBudget(e.budget),
  SB::alwaysSpentCoversSettledOverage(e.budget),
  NA::alwaysTenMarketSlots(e.arcs),
  NA::alwaysLiveSlotHasSecretOutcome(e.arcs),
  NA::alwaysUniqueClues(e.arcs),
  NA::alwaysTradingMatchesActivePhase(e.arcs),
  NA::alwaysNoPublicProofBeforeResolution(e.arcs),
  NA::alwaysPreparedDraftMatchesSecretOutcome(e.arcs),
  NA::alwaysResolvedHasProofAndOutcome(e.arcs),
  NL::alwaysNpcRolesOnly(e.npc),
  NL::alwaysStepsBounded(e.npc),
  NL::alwaysSpotIndexPositive(e.npc),
  NL::alwaysEngagementUniqueAndNonNegative(e.npc),
}

pure def alwaysEngineNpcStepsCappedAtFour(e: EngineState): bool =
  e.npc.maxStepsAllowed <= 4

pure def stepMinuteTickNeverTouchesBudgetOrNpc(before: EngineState, via: str, after: EngineState): bool =
  via == "tickMinute" implies (
    after.budget == before.budget
      and after.npc == before.npc
      and after.clock.llmCallsOnMinuteTick == 0
  )

pure def stepNpcDispatchEnforcesD25Throttle(before: EngineState, via: str, after: EngineState): bool =
  via == "dispatchNpcTickWithBudget" implies (
    after.npc.maxStepsAllowed == SB::maxStepsAllowed(before.budget)
      and after.npc.batchSize == SB::effectiveBatch(before.budget, SB::baseNpcBatch)
  )

pure def stepDeniedDispatchLeavesNpcIdle(before: EngineState, via: str, after: EngineState): bool =
  via == "denyNpcDispatchOnBudget" implies after.npc == before.npc

pure def sometimesEngineTickedWithoutLlm(e: EngineState): bool =
  e.clock.minuteIndex >= 1 and e.clock.llmCallsOnMinuteTick == 0

pure def sometimesEngineNpcMovedSpotIndex(e: EngineState): bool =
  e.npc.spotTradeCount >= 1 and e.npc.spotIndexPrice != NL::initialSpotPrice

pure def sometimesEngineBudgetThrottledNpc(e: EngineState): bool =
  e.npc.maxStepsAllowed == 2

pure def sometimesEngineMarketSettledAndReplaced(e: EngineState): bool =
  e.arcs.totalSettled >= 1 and e.arcs.totalReplaced >= 1
