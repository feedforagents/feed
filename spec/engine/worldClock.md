# World clock and scheduled jobs

The deterministic game clock and scheduled job cadence for Feed (`feed.fun`),
derived from `GameClock` and PRD §9.3, §9.7, and Phase 0. A minute tick advances
committed game time and flips due market signal windows without ever running
LLM inference, while separate scheduled jobs own RSS/parody ingestion, world
facts, NPC and organization activity, article generation, bounded market
recovery, and eight-hour UTC perpetual funding.

## Domain

### Clock mode and scheduled routes

The world clock runs in realtime or simulated mode. Only the nine active
scheduled routes may run on the scheduler; retired routes (`reputation-sync`,
`profile-chain-sync`, and `agent-tick`) are permanently excluded.

```quint
type ClockMode = ClockRealtime | ClockSimulated

type RouteName =
  | RouteGameTick
  | RouteMarketsTick
  | RouteMarketsRecovery
  | RouteNpcTick
  | RouteOrganizationTick
  | RouteArticleTick
  | RoutePerpFunding
  | RouteWorldFacts
  | RouteRssRefresh
  | RouteReputationSync
  | RouteProfileChainSync
  | RouteAgentTick

pure def isRetiredRoute(r: RouteName): bool =
  r == RouteReputationSync or r == RouteProfileChainSync or r == RouteAgentTick

pure def isCoreRoute(r: RouteName): bool = not(isRetiredRoute(r))

pure def routeCadenceMinutes(r: RouteName): int =
  if (r == RouteGameTick or r == RouteMarketsTick or r == RouteMarketsRecovery) 1
  else if (r == RouteNpcTick) 2
  else if (r == RouteOrganizationTick or r == RouteRssRefresh) 5
  else if (r == RouteArticleTick) 30
  else if (r == RoutePerpFunding) 480
  else if (r == RouteWorldFacts) 720
  else 0

pure def currentFundingPeriod(minuteIdx: int): int = minuteIdx / 480
```

### Tick health and world clock state

`tickHealth` tracks the last committed minute tick, pending expired market
resolutions, the age in minutes of the oldest pending resolution, and the last
RSS refresh tick. The RSS/parody ingestion owner is fixed to `RouteRssRefresh`.
Funding starts paused with pre-cutover work draining until an operator arms the
first complete UTC boundary after cutover.

```quint
type TickHealth = {
  lastSuccessTick: int,
  pendingResolutions: int,
  oldestPendingAge: int,
  lastRssRefresh: int,
}

type WorldClockState = {
  running: bool,
  clockMode: ClockMode,
  minuteIndex: int,
  dueSignalWindows: int,
  llmCallsOnMinuteTick: int,
  rssOwner: RouteName,
  activeRoutes: List[RouteName],
  tickHealth: TickHealth,
  fundingPaused: bool,
  inFlightFundingCount: int,
  fundingCutoverPeriod: int,
  lastAccruedFundingPeriod: int,
  rssRefreshCount: int,
  worldFactsRunCount: int,
  articleTickCount: int,
  orgTickCount: int,
  npcTickCount: int,
  marketTickCount: int,
  resolvedBacklogCount: int,
}

pure val initial: WorldClockState = {
  running: true,
  clockMode: ClockRealtime,
  minuteIndex: 0,
  dueSignalWindows: 0,
  llmCallsOnMinuteTick: 0,
  rssOwner: RouteRssRefresh,
  activeRoutes: List(
    RouteGameTick,
    RouteMarketsTick,
    RouteMarketsRecovery,
    RouteNpcTick,
    RouteOrganizationTick,
    RouteArticleTick,
    RoutePerpFunding,
    RouteWorldFacts,
    RouteRssRefresh
  ),
  tickHealth: {
    lastSuccessTick: 0,
    pendingResolutions: 0,
    oldestPendingAge: 0,
    lastRssRefresh: -5,
  },
  fundingPaused: true,
  inFlightFundingCount: 1,
  fundingCutoverPeriod: 0,
  lastAccruedFundingPeriod: -1,
  rssRefreshCount: 0,
  worldFactsRunCount: 0,
  articleTickCount: 0,
  orgTickCount: 0,
  npcTickCount: 0,
  marketTickCount: 0,
  resolvedBacklogCount: 0,
}

pure val hoursValues = Set(0, 1, 8, 12)
pure val flippedWindowsValues = Set(-1, 0, 1, 2)
pure val newlyExpiredValues = Set(-1, 0, 1, 2)
pure val resolvedCountValues = Set(0, 1, 2)
pure val nextOldestAgeValues = Set(0, 1, 2)
pure val boundaryPeriodValues = Set(0, 1, 2)
pure val fundingPeriodValues = Set(0, 1, 2, 3)
```

## Story: Advance the world clock without blocking on inference

> As an operator, I want the minute tick to advance committed game time and
> flip due signal windows without calling an LLM, so that feed copy or recovery
> inference latency never stalls the world clock.

### The minute tick advances the clock, flips signal windows, and tracks pending recovery age

Running the minute tick requires `running == true`, accepts non-negative signal
window flips and newly expired market counts, advances `minuteIndex` by one,
updates `lastSuccessTick` and `oldestPendingAge`, and performs zero LLM calls.

```quint
pure def canRunMinuteTick(w: WorldClockState, flippedWindows: int, newlyExpired: int): bool =
  w.running and flippedWindows >= 0 and flippedWindows <= 3 and newlyExpired >= 0 and newlyExpired <= 2

pure def runMinuteTick(w: WorldClockState, flippedWindows: int, newlyExpired: int): WorldClockState =
  val nextMin = w.minuteIndex + 1
  val nextPending = w.tickHealth.pendingResolutions + newlyExpired
  val nextAge = if (nextPending > 0) w.tickHealth.oldestPendingAge + 1 else 0
  {
    ...w,
    minuteIndex: nextMin,
    dueSignalWindows: w.dueSignalWindows + flippedWindows,
    llmCallsOnMinuteTick: 0,
    tickHealth: {
      ...w.tickHealth,
      lastSuccessTick: nextMin,
      pendingResolutions: nextPending,
      oldestPendingAge: nextAge,
    },
  }
```

### Simulated clock fast-forward is restricted to simulated mode

Matching `GameClock.advanceHours`, advancing time by hours in bulk is refused
in realtime mode and allowed only when `clockMode == ClockSimulated`.

```quint
pure def canEnableSimulatedClock(w: WorldClockState): bool =
  w.clockMode == ClockRealtime

pure def enableSimulatedClock(w: WorldClockState): WorldClockState =
  { ...w, clockMode: ClockSimulated }

pure def canFastForwardHours(w: WorldClockState, hours: int): bool =
  w.running and w.clockMode == ClockSimulated and hours > 0 and hours <= 24

pure def fastForwardHours(w: WorldClockState, hours: int): WorldClockState =
  val delta = hours * 60
  val nextAge = if (w.tickHealth.pendingResolutions > 0) w.tickHealth.oldestPendingAge + delta else 0
  {
    ...w,
    minuteIndex: w.minuteIndex + delta,
    tickHealth: { ...w.tickHealth, oldestPendingAge: nextAge },
  }

pure def canToggleWorldRunning(w: WorldClockState, isRunning: bool): bool =
  w.running != isRunning

pure def toggleWorldRunning(w: WorldClockState, isRunning: bool): WorldClockState =
  { ...w, running: isRunning }
```

### Minute ticks never invoke LLM inference and clock time never moves backward

```quint
pure def alwaysMinuteTickNeverRunsLlm(w: WorldClockState): bool =
  w.llmCallsOnMinuteTick == 0

pure def alwaysClockNonNegative(w: WorldClockState): bool =
  w.minuteIndex >= 0

pure def stepClockMonotonic(before: WorldClockState, after: WorldClockState): bool =
  after.minuteIndex >= before.minuteIndex and after.lastAccruedFundingPeriod >= before.lastAccruedFundingPeriod
```

## Story: Schedule core world jobs and exclude retired routes

> As an operator, I want RSS ingestion and parody headlines owned by a single
> scheduled job, core world jobs running on their cadences, and retired routes
> permanently absent from the scheduler.

### Core cadence jobs exclude retired routes and update their respective counters

```quint
pure def canRunCoreCadenceJob(w: WorldClockState, route: RouteName): bool =
  w.running and isCoreRoute(route) and w.activeRoutes.includes(route)
    and route != RouteGameTick and route != RoutePerpFunding
    and route != RouteRssRefresh and route != RouteMarketsRecovery

pure def runCoreCadenceJob(w: WorldClockState, route: RouteName): WorldClockState =
  {
    ...w,
    marketTickCount: if (route == RouteMarketsTick) w.marketTickCount + 1 else w.marketTickCount,
    npcTickCount: if (route == RouteNpcTick) w.npcTickCount + 1 else w.npcTickCount,
    orgTickCount: if (route == RouteOrganizationTick) w.orgTickCount + 1 else w.orgTickCount,
    articleTickCount: if (route == RouteArticleTick) w.articleTickCount + 1 else w.articleTickCount,
    worldFactsRunCount: if (route == RouteWorldFacts) w.worldFactsRunCount + 1 else w.worldFactsRunCount,
  }
```

### RSS ingestion and parody generation have one scheduled owner at 5-minute cadence

Only `RouteRssRefresh` may refresh RSS and parody headlines while the game is
running, at least five minutes after the previous refresh.

```quint
pure def canRunRssRefresh(w: WorldClockState, ownerRoute: RouteName): bool =
  w.running and ownerRoute == w.rssOwner and w.rssOwner == RouteRssRefresh
    and w.minuteIndex - w.tickHealth.lastRssRefresh >= 5

pure def runRssRefresh(w: WorldClockState, ownerRoute: RouteName): WorldClockState =
  {
    ...w,
    rssRefreshCount: w.rssRefreshCount + 1,
    tickHealth: { ...w.tickHealth, lastRssRefresh: w.minuteIndex },
  }
```

### Market recovery drains pending resolutions and updates backlog age

```quint
pure def canCompleteMarketRecovery(w: WorldClockState, resolvedCount: int, nextOldestAge: int): bool =
  w.running and resolvedCount > 0 and resolvedCount <= w.tickHealth.pendingResolutions
    and nextOldestAge >= 0
    and (if (w.tickHealth.pendingResolutions - resolvedCount == 0) nextOldestAge == 0 else nextOldestAge <= w.tickHealth.oldestPendingAge)

pure def completeMarketRecovery(w: WorldClockState, resolvedCount: int, nextOldestAge: int): WorldClockState =
  {
    ...w,
    resolvedBacklogCount: w.resolvedBacklogCount + resolvedCount,
    tickHealth: {
      ...w.tickHealth,
      pendingResolutions: w.tickHealth.pendingResolutions - resolvedCount,
      oldestPendingAge: nextOldestAge,
    },
  }
```

### Retired routes never run and tick health remains consistent

```quint
pure def alwaysNoRetiredRoutesActive(w: WorldClockState): bool =
  w.activeRoutes.every(r => isCoreRoute(r))

pure def alwaysSingleRssOwner(w: WorldClockState): bool =
  w.rssOwner == RouteRssRefresh

pure def alwaysTickHealthConsistent(w: WorldClockState): bool = and {
  w.tickHealth.lastSuccessTick <= w.minuteIndex,
  w.tickHealth.pendingResolutions >= 0,
  w.tickHealth.oldestPendingAge >= 0,
  w.tickHealth.pendingResolutions == 0 implies w.tickHealth.oldestPendingAge == 0,
  w.tickHealth.lastRssRefresh <= w.minuteIndex,
}

pure def lawRetiredRoutesHaveZeroCadence(r: RouteName): bool =
  isRetiredRoute(r) implies routeCadenceMinutes(r) == 0

pure def sometimesRssRefreshed(w: WorldClockState): bool =
  w.tickHealth.lastRssRefresh >= 0 and w.rssRefreshCount >= 1

pure def sometimesRecoveryBacklogDrained(w: WorldClockState): bool =
  w.resolvedBacklogCount >= 1 and w.tickHealth.pendingResolutions == 0

pure def sometimesWorldFactsRan(w: WorldClockState): bool =
  w.worldFactsRunCount >= 1
```

## Story: Guard perpetual funding cutover across 8-hour UTC periods

> As an operator, I want perpetual funding paused and drained before cutover
> and armed only for a future complete eight-hour UTC boundary, so that the
> revised worker path never replays pre-cutover periods or accrues a period twice.

### Funding jobs drain while paused before configuring the cutover boundary

```quint
pure def canPauseFunding(w: WorldClockState): bool = not(w.fundingPaused)

pure def pauseFunding(w: WorldClockState): WorldClockState =
  { ...w, fundingPaused: true }

pure def canDrainFundingJob(w: WorldClockState): bool =
  w.fundingPaused and w.inFlightFundingCount > 0

pure def drainFundingJob(w: WorldClockState): WorldClockState =
  { ...w, inFlightFundingCount: w.inFlightFundingCount - 1 }

pure def canArmFundingCutover(w: WorldClockState, boundaryPeriod: int): bool =
  w.fundingCutoverPeriod == 0 and w.fundingPaused and w.inFlightFundingCount == 0
    and boundaryPeriod > currentFundingPeriod(w.minuteIndex)

pure def armFundingCutover(w: WorldClockState, boundaryPeriod: int): WorldClockState =
  { ...w, fundingCutoverPeriod: boundaryPeriod, fundingPaused: false }

pure def canResumeFunding(w: WorldClockState): bool =
  w.fundingCutoverPeriod > 0 and w.fundingPaused and w.inFlightFundingCount == 0

pure def resumeFunding(w: WorldClockState): WorldClockState =
  { ...w, fundingPaused: false }
```

### Perpetual funding accrues at most once per eligible post-cutover UTC period

```quint
pure def canRunPerpFunding(w: WorldClockState, fundingPeriod: int): bool =
  w.running and not(w.fundingPaused) and w.fundingCutoverPeriod > 0
    and fundingPeriod >= w.fundingCutoverPeriod
    and fundingPeriod > w.lastAccruedFundingPeriod
    and fundingPeriod <= currentFundingPeriod(w.minuteIndex)

pure def runPerpFunding(w: WorldClockState, fundingPeriod: int): WorldClockState =
  { ...w, lastAccruedFundingPeriod: fundingPeriod }
```

### Unpaused funding requires a configured post-cutover boundary and drained jobs

```quint
pure def alwaysFundingCutoverSafe(w: WorldClockState): bool = and {
  w.fundingCutoverPeriod >= 0,
  w.inFlightFundingCount >= 0,
  not(w.fundingPaused) implies (w.fundingCutoverPeriod > 0 and w.inFlightFundingCount == 0),
  w.lastAccruedFundingPeriod >= 0 implies (w.fundingCutoverPeriod > 0 and w.lastAccruedFundingPeriod >= w.fundingCutoverPeriod),
}

pure def sometimesPerpFundingAccrued(w: WorldClockState): bool =
  w.lastAccruedFundingPeriod >= 1
```
