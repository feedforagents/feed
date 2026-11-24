# D-25 spend enforcement

Shared durable daily inference spend ledger enforcing PRD §14 D-25 across all
scheduled NPC and engine LLM inference attempts, retries, and embeddings.
Amounts are represented in exact integer cents (`dailyBudgetCents = 10000`,
corresponding to `$100.00` or `budgetMicros = 100000000` micro-dollars at
`microsPerCent = 10000`).

## Domain

### Budget constants and throttle levels

Below 80% committed utilization (`spent + reserved`), the engine runs the full
configured NPC batch with at most 4 steps per NPC. At 80% or above, the NPC
batch size is halved (minimum 1). At 90% or above, the NPC batch size is halved
and NPC steps per tick are capped at 2.

```quint
pure val dailyBudgetCents = 10000
pure val microsPerCent = 10000
pure val budgetMicros = dailyBudgetCents * microsPerCent
pure val baseNpcBatch = 10
pure val normalMaxSteps = 4
pure val throttledMaxSteps = 2

type ThrottleLevel = ThrottleNormal | ThrottleHalfBatch | ThrottleHalfBatchTwoSteps

type AttemptStatus = AttemptReserved | AttemptUncertain | AttemptSettled

type SpendAttempt = {
  attemptId: int,
  utcDay: int,
  boundCents: int,
  actualCents: int,
  attemptStatus: AttemptStatus,
}

type BudgetLedger = {
  currentDay: int,
  dailyBudget: int,
  spentTodayCents: int,
  reservedTodayCents: int,
  outstandingPrevReserved: int,
  nextAttemptId: int,
  declinedCount: int,
  attempts: List[SpendAttempt],
}

pure val initial: BudgetLedger = {
  currentDay: 0,
  dailyBudget: dailyBudgetCents,
  spentTodayCents: 0,
  reservedTodayCents: 0,
  outstandingPrevReserved: 0,
  nextAttemptId: 1,
  declinedCount: 0,
  attempts: List(),
}

pure val boundCentsValues = Set(-1, 0, 500, 1000, 2000, 4500, 8000, 9000)
pure val actualCentsValues = Set(-1, 0, 500, 1000, 2000, 4000)
pure val attemptIdValues = Set(1, 2, 3, 4)
pure val newDayValues = Set(0, 1, 2, 3)
pure val spentAValues = Set(0, 4000, 8000, 9000, 10000)
pure val spentBValues = Set(0, 4000, 8000, 9000, 10000)
pure val budgetValues = Set(100, 1000, 10000)
pure val configuredBatchValues = Set(1, 5, 10)
```

### Committed utilization and throttle calculation

Total reserved funds combine same-day open reservations (`reservedTodayCents`)
and unresolved prior-day reservations (`outstandingPrevReserved`), so uncertain
prior-day attempts reduce today's available headroom until reconciled.

```quint
pure val emptyAttempt: SpendAttempt =
  { attemptId: 0, utcDay: -1, boundCents: 0, actualCents: 0, attemptStatus: AttemptSettled }

pure def findAttempt(attempts: List[SpendAttempt], attemptId: int): SpendAttempt =
  attempts.foldl(emptyAttempt, (found, a) => if (a.attemptId == attemptId) a else found)

pure def sumReservedForToday(attempts: List[SpendAttempt], day: int): int =
  attempts.foldl(0, (acc, a) =>
    if (a.utcDay == day and (a.attemptStatus == AttemptReserved or a.attemptStatus == AttemptUncertain))
      acc + a.boundCents
    else acc)

pure def sumPrevReserved(attempts: List[SpendAttempt], day: int): int =
  attempts.foldl(0, (acc, a) =>
    if (a.utcDay < day and (a.attemptStatus == AttemptReserved or a.attemptStatus == AttemptUncertain))
      acc + a.boundCents
    else acc)

pure def totalReservedCents(b: BudgetLedger): int =
  b.reservedTodayCents + b.outstandingPrevReserved

pure def committedCents(b: BudgetLedger): int =
  b.spentTodayCents + b.reservedTodayCents + b.outstandingPrevReserved

pure def committedMicros(b: BudgetLedger): int =
  committedCents(b) * microsPerCent

pure def remainingHeadroomCents(b: BudgetLedger): int =
  b.dailyBudget - committedCents(b)

pure def throttleFor(committed: int, budget: int): ThrottleLevel =
  if (budget <= 0 or committed * 10 >= budget * 9) ThrottleHalfBatchTwoSteps
  else if (committed * 10 >= budget * 8) ThrottleHalfBatch
  else ThrottleNormal

pure def currentThrottle(b: BudgetLedger): ThrottleLevel =
  throttleFor(committedCents(b), b.dailyBudget)

pure def throttleRank(level: ThrottleLevel): int =
  if (level == ThrottleNormal) 0
  else if (level == ThrottleHalfBatch) 1
  else 2

pure def maxStepsAllowed(b: BudgetLedger): int =
  val thr = currentThrottle(b)
  match thr {
    | ThrottleHalfBatchTwoSteps => throttledMaxSteps
    | _ => normalMaxSteps
  }

pure def effectiveBatch(b: BudgetLedger, configuredBatch: int): int =
  val safeBatch = if (configuredBatch >= 1) configuredBatch else 1
  val half = if (safeBatch / 2 >= 1) safeBatch / 2 else 1
  val thr = currentThrottle(b)
  match thr {
    | ThrottleNormal => safeBatch
    | _ => half
  }
```

## Story: Enforce atomic budget reservations and reconciliation

> As an operator, I want every inference attempt to atomically reserve a
> provider-backed upper bound before dispatch, settle actual spend on response,
> and keep uncertain reservations locked across timeouts, restarts, and UTC
> midnight rollovers until reconciled.

### Dispatch reserves a known upper bound atomically or refuses when headroom is insufficient

An attempt is admitted only when `boundKnown == true`, `boundCents > 0`, and
`spent + reserved + boundCents <= dailyBudget`. Denied attempts record a
declined reservation for tick health without consuming budget.

```quint
pure def canReserveAttempt(b: BudgetLedger, boundKnown: bool, boundCents: int): bool =
  boundKnown and boundCents > 0 and committedCents(b) + boundCents <= b.dailyBudget

pure def reserveAttempt(b: BudgetLedger, boundKnown: bool, boundCents: int): BudgetLedger =
  val entry = {
    attemptId: b.nextAttemptId,
    utcDay: b.currentDay,
    boundCents: boundCents,
    actualCents: 0,
    attemptStatus: AttemptReserved,
  }
  {
    ...b,
    reservedTodayCents: b.reservedTodayCents + boundCents,
    nextAttemptId: b.nextAttemptId + 1,
    attempts: b.attempts.append(entry),
  }

pure def canDenyReservation(b: BudgetLedger, boundKnown: bool, boundCents: int): bool =
  not(canReserveAttempt(b, boundKnown, boundCents))

pure def denyReservation(b: BudgetLedger, boundKnown: bool, boundCents: int): BudgetLedger =
  { ...b, declinedCount: b.declinedCount + 1 }
```

### Confirming spend charges actual cost and releases unused reservation

Reconciling a same-day attempt moves `actualCents` into `spentTodayCents` and
releases `boundCents` from `reservedTodayCents`. Reconciling a prior-day
carried-over attempt assigns the charge to its original UTC day and releases
`boundCents` from `outstandingPrevReserved`, restoring today's headroom.

```quint
pure def canConfirmSpend(b: BudgetLedger, attemptId: int, actualCents: int): bool =
  actualCents >= 0 and b.attempts.some(a =>
    a.attemptId == attemptId
      and (a.attemptStatus == AttemptReserved or a.attemptStatus == AttemptUncertain)
      and actualCents <= a.boundCents)

pure def confirmSpend(b: BudgetLedger, attemptId: int, actualCents: int): BudgetLedger =
  val target = findAttempt(b.attempts, attemptId)
  val nextAttempts = b.attempts.listMap(a =>
    if (a.attemptId == attemptId) { ...a, actualCents: actualCents, attemptStatus: AttemptSettled } else a)
  val sameDay = target.utcDay == b.currentDay
  val releasedToday = if (sameDay) target.boundCents else 0
  val releasedPrev = if (not(sameDay)) target.boundCents else 0
  val chargedToday = if (sameDay) actualCents else 0
  {
    ...b,
    spentTodayCents: b.spentTodayCents + chargedToday,
    reservedTodayCents: b.reservedTodayCents - releasedToday,
    outstandingPrevReserved: b.outstandingPrevReserved - releasedPrev,
    attempts: nextAttempts,
  }
```

### Timeouts and worker restarts mark open reservations uncertain without releasing funds

A failed live call settles at actual cost 0 only when the request was never sent — the connection was refused or the provider address did not resolve, so the provider never saw it and no charge could exist. That holds whether the caller falls back to deterministic text or the failure is surfaced. Every other failed live call stays uncertain until reconciled: a timeout, an HTTP error, or a malformed response may already have been billed, so the bound stays reserved and a later confirm assigns the actual charge.

```quint
pure def canMarkUncertain(b: BudgetLedger, attemptId: int): bool =
  b.attempts.some(a => a.attemptId == attemptId and a.attemptStatus == AttemptReserved)

pure def markUncertain(b: BudgetLedger, attemptId: int): BudgetLedger =
  {
    ...b,
    attempts: b.attempts.listMap(a =>
      if (a.attemptId == attemptId) { ...a, attemptStatus: AttemptUncertain } else a),
  }

pure def canSimulateWorkerRestart(b: BudgetLedger): bool =
  b.attempts.some(a => a.attemptStatus == AttemptReserved)

pure def simulateWorkerRestart(b: BudgetLedger): BudgetLedger =
  {
    ...b,
    attempts: b.attempts.listMap(a =>
      if (a.attemptStatus == AttemptReserved) { ...a, attemptStatus: AttemptUncertain } else a),
  }
```

### UTC day rollover carries unsettled prior-day reservations into new-day headroom

```quint
pure def canRolloverUtcDay(b: BudgetLedger, newDay: int): bool =
  newDay > b.currentDay

pure def rolloverUtcDay(b: BudgetLedger, newDay: int): BudgetLedger =
  {
    ...b,
    currentDay: newDay,
    spentTodayCents: 0,
    reservedTodayCents: 0,
    outstandingPrevReserved: b.reservedTodayCents + b.outstandingPrevReserved,
  }
```

### Inductive safety invariants for spend, reservations, and monotonic throttling

```quint
pure def alwaysAttemptIdsUnique(b: BudgetLedger): bool =
  b.attempts.every(a => b.attempts.select(x => x.attemptId == a.attemptId).length() == 1)

pure def alwaysAttemptBoundsValid(b: BudgetLedger): bool =
  b.attempts.every(a => and {
    a.boundCents > 0,
    a.actualCents >= 0,
    a.actualCents <= a.boundCents,
    a.utcDay >= 0,
    a.utcDay <= b.currentDay,
    a.attemptId >= 1,
    a.attemptId < b.nextAttemptId,
  })

pure def alwaysTotalsMatchAttempts(b: BudgetLedger): bool =
  b.reservedTodayCents == sumReservedForToday(b.attempts, b.currentDay)
    and b.outstandingPrevReserved == sumPrevReserved(b.attempts, b.currentDay)

pure def alwaysNonNegativeAndWithinBudget(b: BudgetLedger): bool = and {
  b.currentDay >= 0,
  b.dailyBudget == dailyBudgetCents,
  b.spentTodayCents >= 0,
  b.reservedTodayCents >= 0,
  b.outstandingPrevReserved >= 0,
  b.nextAttemptId >= 1,
  b.declinedCount >= 0,
  committedCents(b) <= b.dailyBudget,
}

pure def lawThrottleMonotonicWithUtilization(spentA: int, spentB: int, budget: int): bool =
  (budget > 0 and 0 <= spentA and spentA <= spentB and spentB <= budget) implies
    throttleRank(throttleFor(spentA, budget)) <= throttleRank(throttleFor(spentB, budget))

pure def lawEffectiveBatchAtLeastOne(b: BudgetLedger, configuredBatch: int): bool =
  effectiveBatch(b, configuredBatch) >= 1

pure def sometimesReached80Throttle(b: BudgetLedger): bool =
  currentThrottle(b) == ThrottleHalfBatch

pure def sometimesReached90Throttle(b: BudgetLedger): bool =
  currentThrottle(b) == ThrottleHalfBatchTwoSteps

pure def sometimesUncertainCarriedAcrossRollover(b: BudgetLedger): bool =
  b.currentDay >= 1 and b.outstandingPrevReserved > 0

pure def sometimesPriorDayReconciled(b: BudgetLedger): bool =
  b.currentDay >= 1 and b.attempts.some(a => a.utcDay < b.currentDay and a.attemptStatus == AttemptSettled)

pure def sometimesReservationDeclined(b: BudgetLedger): bool =
  b.declinedCount > 0
