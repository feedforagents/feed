# Bounded NPC Eliza v4 tick loop

Bounded autonomous NPC execution loop derived from PRD §9.3, §9.5, §13, and
D-25. Only world NPCs (`NpcCharacter` and `NpcOrg`) execute in this loop—never
user-controlled agents. Each tick runs at most `maxStepsAllowed` steps (4 under
normal D-25 utilization, 2 when committed spend reaches 90%), following
`ObserveFeed -> Decide -> Act`. Only NPCs trade spot (moving the persisted spot
CPMM index price that drives perpetual mark prices), and NPC characters may
invite active human players into private alpha group chats once their
engagement crosses the threshold.

## Domain

### NPC roles, tick phases, and actions

```quint
type ActorRole = NpcCharacter | NpcOrg

type TickPhase = TickIdle | TickReady | TickObserved | TickDecided | TickDone

type NpcActionKind =
  | ActSpot
  | ActPerp
  | ActClosePerp
  | ActPrediction
  | ActSellPrediction
  | ActPost
  | ActReply
  | ActLike
  | ActRepost
  | ActFollow
  | ActReplyDm
  | ActGroupMsg
  | ActAlphaInvite

type LoopSender = EngineNpcRunner | HumanEngager

type PlayerEngagement = {
  playerId: int,
  score: int,
}

type AlphaInviteRecord = {
  actorId: int,
  playerId: int,
}

type NpcLoopState = {
  phase: TickPhase,
  activeActorId: int,
  activeActorRole: ActorRole,
  maxStepsAllowed: int,
  stepsUsed: int,
  batchSize: int,
  plannedAction: NpcActionKind,
  spotIndexPrice: int,
  spotTradeCount: int,
  perpTradeCount: int,
  predictionTradeCount: int,
  socialActionCount: int,
  alphaInviteCount: int,
  ticksCompleted: int,
  engagements: List[PlayerEngagement],
  alphaInvites: List[AlphaInviteRecord],
}

pure val minAlphaEngagement = 2
pure val initialSpotPrice = 10000

pure val initial: NpcLoopState = {
  phase: TickIdle,
  activeActorId: 0,
  activeActorRole: NpcCharacter,
  maxStepsAllowed: 4,
  stepsUsed: 0,
  batchSize: 10,
  plannedAction: ActPost,
  spotIndexPrice: initialSpotPrice,
  spotTradeCount: 0,
  perpTradeCount: 0,
  predictionTradeCount: 0,
  socialActionCount: 0,
  alphaInviteCount: 0,
  ticksCompleted: 0,
  engagements: List(),
  alphaInvites: List(),
}

pure val actorIdValues = Set(0, 1, 2, 3)
pure val maxStepsValues = Set(1, 2, 4)
pure val batchSizeValues = Set(0, 1, 5, 10)
pure val playerIdValues = Set(0, 1, 2)
pure val spotDeltaValues = Set(-200, 0, 200, 500)
pure val engagementDeltaValues = Set(0, 1, 2, 3)

pure def playerScore(engagements: List[PlayerEngagement], playerId: int): int =
  engagements.foldl(0, (acc, e) => if (e.playerId == playerId) e.score else acc)

pure def upsertEngagement(
  engagements: List[PlayerEngagement],
  playerId: int,
  engagementDelta: int
): List[PlayerEngagement] =
  if (engagements.some(e => e.playerId == playerId))
    engagements.listMap(e => if (e.playerId == playerId) { ...e, score: e.score + engagementDelta } else e)
  else engagements.append({ playerId: playerId, score: engagementDelta })
```

## Story: Drive NPC spot markets, social posts, and alpha-group invites within D-25 bounds

> As a player, I want satirical NPCs to observe the world, post, trade markets,
> drive the spot index price, and invite engaged players into private alpha
> chats within a strict step budget.

### Human social engagement unlocks eligibility for private alpha-group invites

```quint
pure def canRecordPlayerEngagement(
  s: NpcLoopState,
  playerId: int,
  engagementDelta: int,
  by: LoopSender
): bool =
  by == HumanEngager and playerId > 0 and engagementDelta > 0 and engagementDelta <= 5

pure def recordPlayerEngagement(
  s: NpcLoopState,
  playerId: int,
  engagementDelta: int,
  by: LoopSender
): NpcLoopState =
  { ...s, engagements: upsertEngagement(s.engagements, playerId, engagementDelta) }
```

### Each NPC tick starts with a budget-enforced step cap and loops ObserveFeed -> Decide -> Act

```quint
pure def canStartNpcTick(
  s: NpcLoopState,
  actorId: int,
  maxSteps: int,
  batchSize: int,
  by: LoopSender
): bool =
  by == EngineNpcRunner
    and (s.phase == TickIdle or s.phase == TickDone)
    and actorId > 0
    and (maxSteps == 2 or maxSteps == 4)
    and batchSize >= 1 and batchSize <= 10

pure def startNpcTick(
  s: NpcLoopState,
  actorId: int,
  actorRole: ActorRole,
  maxSteps: int,
  batchSize: int,
  by: LoopSender
): NpcLoopState =
  {
    ...s,
    phase: TickReady,
    activeActorId: actorId,
    activeActorRole: actorRole,
    maxStepsAllowed: maxSteps,
    stepsUsed: 0,
    batchSize: batchSize,
  }

pure def canObserveFeed(s: NpcLoopState, by: LoopSender): bool =
  by == EngineNpcRunner and s.phase == TickReady and s.stepsUsed < s.maxStepsAllowed

pure def observeFeed(s: NpcLoopState, by: LoopSender): NpcLoopState =
  { ...s, phase: TickObserved }

pure def canDecideAction(s: NpcLoopState, actionKind: NpcActionKind, by: LoopSender): bool =
  by == EngineNpcRunner
    and s.phase == TickObserved
    and s.stepsUsed < s.maxStepsAllowed
    and (actionKind == ActAlphaInvite implies (
      s.activeActorRole == NpcCharacter and s.engagements.some(e => e.score >= minAlphaEngagement)
    ))

pure def decideAction(s: NpcLoopState, actionKind: NpcActionKind, by: LoopSender): NpcLoopState =
  { ...s, phase: TickDecided, plannedAction: actionKind }
```

### Only NPC actors execute spot trades (moving the index price) and alpha invites

```quint
pure def canExecuteNpcAction(
  s: NpcLoopState,
  spotDelta: int,
  playerId: int,
  by: LoopSender
): bool =
  by == EngineNpcRunner
    and s.phase == TickDecided
    and s.stepsUsed < s.maxStepsAllowed
    and (s.plannedAction == ActSpot implies s.spotIndexPrice + spotDelta >= 100)
    and (s.plannedAction == ActAlphaInvite implies (
      s.activeActorRole == NpcCharacter
        and playerId > 0
        and playerScore(s.engagements, playerId) >= minAlphaEngagement
    ))

pure def executeNpcAction(
  s: NpcLoopState,
  spotDelta: int,
  playerId: int,
  by: LoopSender
): NpcLoopState =
  val nextUsed = s.stepsUsed + 1
  val finished = nextUsed >= s.maxStepsAllowed
  val nextSpot = if (s.plannedAction == ActSpot) s.spotIndexPrice + spotDelta else s.spotIndexPrice
  val addInvite = s.plannedAction == ActAlphaInvite
    and not(s.alphaInvites.some(r => r.actorId == s.activeActorId and r.playerId == playerId))
  val nextInvites = if (addInvite) s.alphaInvites.append({ actorId: s.activeActorId, playerId: playerId }) else s.alphaInvites
  val isPerp = s.plannedAction == ActPerp or s.plannedAction == ActClosePerp
  val isPrediction = s.plannedAction == ActPrediction or s.plannedAction == ActSellPrediction
  val isSocial =
    s.plannedAction == ActPost
      or s.plannedAction == ActReply
      or s.plannedAction == ActLike
      or s.plannedAction == ActRepost
      or s.plannedAction == ActFollow
      or s.plannedAction == ActReplyDm
      or s.plannedAction == ActGroupMsg
  {
    ...s,
    phase: if (finished) TickDone else TickReady,
    stepsUsed: nextUsed,
    spotIndexPrice: nextSpot,
    spotTradeCount: if (s.plannedAction == ActSpot) s.spotTradeCount + 1 else s.spotTradeCount,
    perpTradeCount: if (isPerp) s.perpTradeCount + 1 else s.perpTradeCount,
    predictionTradeCount: if (isPrediction) s.predictionTradeCount + 1 else s.predictionTradeCount,
    socialActionCount: if (isSocial) s.socialActionCount + 1 else s.socialActionCount,
    alphaInviteCount: if (addInvite) s.alphaInviteCount + 1 else s.alphaInviteCount,
    ticksCompleted: if (finished) s.ticksCompleted + 1 else s.ticksCompleted,
    alphaInvites: nextInvites,
  }

pure def canEndNpcTick(s: NpcLoopState, by: LoopSender): bool =
  by == EngineNpcRunner and (s.phase == TickReady or s.phase == TickObserved or s.phase == TickDecided)

pure def endNpcTick(s: NpcLoopState, by: LoopSender): NpcLoopState =
  { ...s, phase: TickDone, ticksCompleted: s.ticksCompleted + 1 }
```

### Bounded ticks, NPC-only actors, spot-only index movement, and engagement-gated invites

```quint
pure def alwaysNpcRolesOnly(s: NpcLoopState): bool =
  s.activeActorRole == NpcCharacter or s.activeActorRole == NpcOrg

pure def alwaysStepsBounded(s: NpcLoopState): bool = and {
  0 <= s.stepsUsed,
  s.stepsUsed <= s.maxStepsAllowed,
  s.maxStepsAllowed == 2 or s.maxStepsAllowed == 4,
  s.batchSize >= 1,
  (s.phase != TickIdle and s.phase != TickDone) implies s.stepsUsed < s.maxStepsAllowed,
  s.ticksCompleted >= 0,
}

pure def alwaysSpotIndexPositive(s: NpcLoopState): bool =
  s.spotIndexPrice >= 100

pure def alwaysEngagementUniqueAndNonNegative(s: NpcLoopState): bool = and {
  s.engagements.every(e => e.playerId > 0 and e.score >= 0),
  s.engagements.every(a => s.engagements.select(b => b.playerId == a.playerId).length() == 1),
  s.alphaInvites.every(rec => playerScore(s.engagements, rec.playerId) >= minAlphaEngagement),
}

pure def stepSpotOnlyMovesOnNpcSpot(before: NpcLoopState, via: str, after: NpcLoopState): bool =
  after.spotIndexPrice != before.spotIndexPrice implies (via == "executeNpcAction" and before.plannedAction == ActSpot)

pure def sometimesSpotTradeMovedIndex(s: NpcLoopState): bool =
  s.spotTradeCount >= 1 and s.spotIndexPrice != initialSpotPrice

pure def sometimesAlphaInviteSent(s: NpcLoopState): bool =
  s.alphaInviteCount >= 1

pure def sometimesTickHitMaxSteps(s: NpcLoopState): bool =
  s.ticksCompleted >= 1 and s.stepsUsed == s.maxStepsAllowed

pure def sometimesThrottledTwoStepTick(s: NpcLoopState): bool =
  s.ticksCompleted >= 1 and s.maxStepsAllowed == 2
