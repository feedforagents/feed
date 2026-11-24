# Shared rate limits and D-25 spend budgets

Per-account hourly rate limits shared identically across web and connected MCP clients, plus D-25 daily NPC LLM spend reservation, carryover accounting, and graceful 80%/90% throttling thresholds.

## Shared per-account hourly rate limits

### Posts, DMs, and trades share one hourly budget across web and MCP

Connecting an AI agent through MCP does not multiply rate limits: web requests and MCP tool calls draw from the exact same per-account `postsThisHour`, `dmsThisHour`, and `tradesThisHour` counters. Advancing to a newer UTC hour resets the hourly counters.

```quint
type ActionSurface = WebClient | McpAgent
type RateLimitAction = PostAction | DmAction | TradeAction

type AccountHourlyUsage = {
  postsThisHour: int,
  dmsThisHour: int,
  tradesThisHour: int,
  windowHour: int,
}

type RateLimitPolicy = {
  maxPostsPerHour: int,
  maxDmsPerHour: int,
  maxTradesPerHour: int,
}

pure val DEFAULT_MAX_POSTS_PER_HOUR = 30
pure val DEFAULT_MAX_DMS_PER_HOUR = 60
pure val DEFAULT_MAX_TRADES_PER_HOUR = 120

pure val DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  maxPostsPerHour: DEFAULT_MAX_POSTS_PER_HOUR,
  maxDmsPerHour: DEFAULT_MAX_DMS_PER_HOUR,
  maxTradesPerHour: DEFAULT_MAX_TRADES_PER_HOUR,
}

pure val usageValues =
  Set({ postsThisHour: 0, dmsThisHour: 0, tradesThisHour: 0, windowHour: 0 })
    .union(Set({ postsThisHour: 1, dmsThisHour: 2, tradesThisHour: 2, windowHour: 1 }))
    .union(Set({ postsThisHour: 30, dmsThisHour: 60, tradesThisHour: 120, windowHour: 1 }))

pure val policyValues =
  Set(DEFAULT_RATE_LIMIT_POLICY)
    .union(Set({ maxPostsPerHour: 2, maxDmsPerHour: 2, maxTradesPerHour: 2 }))

pure val activeHourValues = Set(0, 1, 2)

pure def normalizedUsage(usage: AccountHourlyUsage, activeHour: int): AccountHourlyUsage =
  if (activeHour > usage.windowHour)
    { postsThisHour: 0, dmsThisHour: 0, tradesThisHour: 0, windowHour: activeHour }
  else usage

pure def actionCountFor(usage: AccountHourlyUsage, actionKind: RateLimitAction): int =
  match actionKind {
    | PostAction => usage.postsThisHour
    | DmAction => usage.dmsThisHour
    | TradeAction => usage.tradesThisHour
  }

pure def actionLimitFor(policy: RateLimitPolicy, actionKind: RateLimitAction): int =
  match actionKind {
    | PostAction => policy.maxPostsPerHour
    | DmAction => policy.maxDmsPerHour
    | TradeAction => policy.maxTradesPerHour
  }

pure def actionAllowed(
  usage: AccountHourlyUsage,
  policy: RateLimitPolicy,
  actionKind: RateLimitAction,
  activeHour: int,
  surface: ActionSurface
): bool =
  val effective = normalizedUsage(usage, activeHour)
  val cap = actionLimitFor(policy, actionKind)
  val used = actionCountFor(effective, actionKind)
  activeHour >= usage.windowHour and cap >= 0 and used >= 0 and used < cap

pure def recordRateLimitedAction(
  usage: AccountHourlyUsage,
  actionKind: RateLimitAction,
  activeHour: int,
  surface: ActionSurface
): AccountHourlyUsage =
  val effective = normalizedUsage(usage, activeHour)
  match actionKind {
    | PostAction => { ...effective, postsThisHour: effective.postsThisHour + 1 }
    | DmAction => { ...effective, dmsThisHour: effective.dmsThisHour + 1 }
    | TradeAction => { ...effective, tradesThisHour: effective.tradesThisHour + 1 }
  }

pure def remainingActionQuota(
  usage: AccountHourlyUsage,
  policy: RateLimitPolicy,
  actionKind: RateLimitAction,
  activeHour: int
): int =
  val effective = normalizedUsage(usage, activeHour)
  val diff = actionLimitFor(policy, actionKind) - actionCountFor(effective, actionKind)
  if (diff < 0) 0 else diff
```

### Web and MCP always see identical capacity, and consuming via one reduces the other

```quint
pure def lawWebAndMcpShareIdenticalAllowance(
  usage: AccountHourlyUsage,
  policy: RateLimitPolicy,
  actionKind: RateLimitAction,
  activeHour: int
): bool =
  actionAllowed(usage, policy, actionKind, activeHour, WebClient)
    iff actionAllowed(usage, policy, actionKind, activeHour, McpAgent)

pure def lawMcpActionConsumesSharedBudget(
  usage: AccountHourlyUsage,
  policy: RateLimitPolicy,
  actionKind: RateLimitAction,
  activeHour: int
): bool =
  val afterMcp = recordRateLimitedAction(usage, actionKind, activeHour, McpAgent)
  val afterWeb = recordRateLimitedAction(usage, actionKind, activeHour, WebClient)
  actionAllowed(usage, policy, actionKind, activeHour, McpAgent) implies
    (remainingActionQuota(afterMcp, policy, actionKind, activeHour)
      == remainingActionQuota(afterWeb, policy, actionKind, activeHour)
      and remainingActionQuota(afterMcp, policy, actionKind, activeHour)
        == remainingActionQuota(usage, policy, actionKind, activeHour) - 1)
```

## D-25 NPC daily spend budget and throttling

### Committed spend combines confirmed charges, active reservations, and previous-day carryover

Per D-25 (`NPC_LLM_DAILY_BUDGET_USD`, default `$100/day` = `10000` cents), before dispatching an inference attempt we atomically reserve a provider-backed upper bound. At `80%` committed (`committed * 100 >= budget * 80`), the NPC batch size is halved (minimum `1`). At `90%` committed (`committed * 100 >= budget * 90`), steps per NPC drop from `4` to `2`. Below `80%`, the full batch and `4`-step limit apply.

```quint
pure val DEFAULT_NPC_DAILY_BUDGET_CENTS = 10000
pure val THROTTLE_BATCH_PCT = 80
pure val THROTTLE_STEPS_PCT = 90
pure val DEFAULT_MAX_NPC_STEPS = 4
pure val THROTTLED_MAX_NPC_STEPS = 2

type SpendLedger = {
  confirmedCents: int,
  reservedCents: int,
  carryoverReservedCents: int,
  dailyBudgetCents: int,
}

pure val ledgerValues =
  Set({ confirmedCents: 0, reservedCents: 0, carryoverReservedCents: 0, dailyBudgetCents: 10000 })
    .union(Set({ confirmedCents: 7500, reservedCents: 499, carryoverReservedCents: 0, dailyBudgetCents: 10000 }))
    .union(Set({ confirmedCents: 7500, reservedCents: 500, carryoverReservedCents: 0, dailyBudgetCents: 10000 }))
    .union(Set({ confirmedCents: 8000, reservedCents: 500, carryoverReservedCents: 500, dailyBudgetCents: 10000 }))

pure val configuredBatchValues = Set(0, 1, 4, 10)
pure val boundCentsValues = Set(0, 50, 500, 2000)
pure val actualCentsValues = Set(0, 25, 500)

pure def nonNegInt(x: int): int = if (x < 0) 0 else x

pure def committedSpendCents(ledger: SpendLedger): int =
  nonNegInt(ledger.confirmedCents) + nonNegInt(ledger.reservedCents) + nonNegInt(ledger.carryoverReservedCents)

pure def remainingSpendHeadroom(ledger: SpendLedger): int =
  val diff = ledger.dailyBudgetCents - committedSpendCents(ledger)
  if (diff < 0) 0 else diff

pure def isBatchThrottled(ledger: SpendLedger): bool =
  ledger.dailyBudgetCents <= 0
    or committedSpendCents(ledger) * 100 >= ledger.dailyBudgetCents * THROTTLE_BATCH_PCT

pure def isStepThrottled(ledger: SpendLedger): bool =
  ledger.dailyBudgetCents <= 0
    or committedSpendCents(ledger) * 100 >= ledger.dailyBudgetCents * THROTTLE_STEPS_PCT

pure def effectiveNpcBatchSize(ledger: SpendLedger, configuredBatch: int): int =
  val halved = configuredBatch / 2
  if (configuredBatch <= 0) 0
  else if (isBatchThrottled(ledger)) (if (halved < 1) 1 else halved)
  else configuredBatch

pure def effectiveNpcMaxSteps(ledger: SpendLedger): int =
  if (isStepThrottled(ledger)) THROTTLED_MAX_NPC_STEPS else DEFAULT_MAX_NPC_STEPS

pure def canReserveSpend(ledger: SpendLedger, boundCents: int): bool =
  boundCents > 0
    and ledger.dailyBudgetCents > 0
    and ledger.confirmedCents >= 0
    and ledger.reservedCents >= 0
    and ledger.carryoverReservedCents >= 0
    and committedSpendCents(ledger) + boundCents <= ledger.dailyBudgetCents

pure def reserveSpend(ledger: SpendLedger, boundCents: int): SpendLedger =
  { ...ledger, reservedCents: ledger.reservedCents + boundCents }

pure def settleSpend(ledger: SpendLedger, boundCents: int, actualCents: int): SpendLedger =
  val released = if (ledger.reservedCents >= boundCents) ledger.reservedCents - boundCents else 0
  { ...ledger, reservedCents: released, confirmedCents: ledger.confirmedCents + nonNegInt(actualCents) }

pure def rolloverSpendDay(ledger: SpendLedger): SpendLedger =
  {
    confirmedCents: 0,
    reservedCents: 0,
    carryoverReservedCents: nonNegInt(ledger.reservedCents) + nonNegInt(ledger.carryoverReservedCents),
    dailyBudgetCents: ledger.dailyBudgetCents,
  }
```

### Budget thresholds enforce exact 80% batch halving, 90% step caps, and carryover headroom reduction

```quint
pure def lawBelow80PctKeepsFullBatchAndFourSteps(ledger: SpendLedger, configuredBatch: int): bool =
  (ledger.dailyBudgetCents > 0 and configuredBatch > 0
    and committedSpendCents(ledger) * 100 < ledger.dailyBudgetCents * THROTTLE_BATCH_PCT) implies
    (effectiveNpcBatchSize(ledger, configuredBatch) == configuredBatch
      and effectiveNpcMaxSteps(ledger) == DEFAULT_MAX_NPC_STEPS)

pure def lawAt80PctHalvesBatchWithMinimumOne(ledger: SpendLedger, configuredBatch: int): bool =
  (ledger.dailyBudgetCents > 0 and configuredBatch >= 1
    and committedSpendCents(ledger) * 100 >= ledger.dailyBudgetCents * THROTTLE_BATCH_PCT) implies
    (effectiveNpcBatchSize(ledger, configuredBatch) >= 1
      and effectiveNpcBatchSize(ledger, configuredBatch) <= configuredBatch
      and (configuredBatch >= 2 implies effectiveNpcBatchSize(ledger, configuredBatch) == configuredBatch / 2))

pure def lawAt90PctCapsStepsAtTwo(ledger: SpendLedger): bool =
  (ledger.dailyBudgetCents > 0
    and committedSpendCents(ledger) * 100 >= ledger.dailyBudgetCents * THROTTLE_STEPS_PCT) implies
    effectiveNpcMaxSteps(ledger) == THROTTLED_MAX_NPC_STEPS

pure def lawSpendReservationRespectsCap(ledger: SpendLedger, boundCents: int): bool =
  canReserveSpend(ledger, boundCents) implies
    committedSpendCents(reserveSpend(ledger, boundCents)) <= ledger.dailyBudgetCents

pure def lawCarryoverReducesNewDayHeadroom(ledger: SpendLedger): bool =
  (ledger.dailyBudgetCents > 0 and ledger.confirmedCents >= 0 and ledger.reservedCents >= 0 and ledger.carryoverReservedCents >= 0) implies
    remainingSpendHeadroom(rolloverSpendDay(ledger))
      == nonNegInt(ledger.dailyBudgetCents - (ledger.reservedCents + ledger.carryoverReservedCents))
```
