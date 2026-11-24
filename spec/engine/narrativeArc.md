# Narrative market arcs and secret outcome isolation

The 10 rolling prediction market slots (`15m` to `3d`), phase-aware clue
publication, durable recovery (`prediction-market-recovery`), and strict
secret outcome isolation (PRD §9.2 and §9.7).

Every active market's hidden outcome (`SecretOutcome`) and private prepared
proof (`SecretDraftProof`) carry a `Secret...` type so Vibestack's taint
analyzer statically prevents any public clue, feed post, guard, or
pre-settlement proof field from depending on the hidden outcome. Only
`declassifyResolution` declassifies the outcome and draft when settling a
prepared `AwaitingProof` market.

## Domain

### Secret outcome, market slots, and phases

Feed maintains 10 rolling slots across eight timeframes (`3d`, `2d`, `1d`, `12h`,
`6h`, `1h`, two `30m`, and two `15m`). `SecretOutcome` and `SecretDraftProof`
are secret types (`SPEC.md#secrets`), while `outcomeAssigned` records publicly
whether an active slot has been seeded with a hidden outcome without revealing
which outcome it holds.

```quint
type SecretOutcome = SecretYes | SecretNo | SecretUnset
type SecretDraftProof = str

type SlotTimeframe = Tf3d | Tf2d | Tf1d | Tf12h | Tf6h | Tf1h | Tf30m | Tf15m

type MarketPhase =
  | Opening
  | Mid
  | Climax
  | Expired
  | AwaitingProof
  | ManualHold
  | ResolvedYes
  | ResolvedNo

type CluePhase = ClueOpening | ClueMid | ClueClimax

type ArcActor = ArcSystem | ArcAdmin

type MarketSlot = {
  slotId: int,
  timeframe: SlotTimeframe,
  marketEpoch: int,
  outcome: SecretOutcome,
  outcomeAssigned: bool,
  phase: MarketPhase,
  proofPrepared: bool,
  draftProof: SecretDraftProof,
  publishedClueIds: List[str],
  publishedProof: str,
  retryCount: int,
  tradingOpen: bool,
}

type PublicClue = {
  clueKey: str,
  slotId: int,
  marketEpoch: int,
  cluePhase: CluePhase,
  body: str,
}

type NarrativeState = {
  slots: List[MarketSlot],
  feedClues: List[PublicClue],
  totalSettled: int,
  totalReplaced: int,
}

pure def mkSeedSlot(
  slotId: int,
  tf: SlotTimeframe,
  seedOutcome: SecretOutcome,
  phase: MarketPhase
): MarketSlot = {
  slotId: slotId,
  timeframe: tf,
  marketEpoch: 1,
  outcome: seedOutcome,
  outcomeAssigned: true,
  phase: phase,
  proofPrepared: false,
  draftProof: "",
  publishedClueIds: List(),
  publishedProof: "",
  retryCount: 0,
  tradingOpen: true,
}

pure val initial: NarrativeState = {
  slots: List(
    mkSeedSlot(0, Tf3d, SecretYes, Opening),
    mkSeedSlot(1, Tf2d, SecretNo, Opening),
    mkSeedSlot(2, Tf1d, SecretYes, Opening),
    mkSeedSlot(3, Tf12h, SecretNo, Opening),
    mkSeedSlot(4, Tf6h, SecretYes, Opening),
    mkSeedSlot(5, Tf1h, SecretNo, Opening),
    mkSeedSlot(6, Tf30m, SecretYes, Mid),
    mkSeedSlot(7, Tf30m, SecretNo, Mid),
    mkSeedSlot(8, Tf15m, SecretYes, Climax),
    mkSeedSlot(9, Tf15m, SecretNo, Climax)
  ),
  feedClues: List(),
  totalSettled: 0,
  totalReplaced: 0,
}

pure val slotIdValues = Set(-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
pure val clueKeyValues = Set("", "clue-1", "clue-2", "clue-3")
pure val bodyValues = Set("", "rumor", "leak", "confirm")
pure val newOutcomeValues = Set(SecretYes, SecretNo)

pure val weight_advanceMarketPhase = 3
pure val weight_prepareProof = 3
pure val weight_settleMarket = 3
```

### Phase helpers and secret proof preparation

`makeSecretDraft` constructs a private `SecretDraftProof` from `SecretOutcome`,
and `declassifyResolution` is the sole boundary that releases a resolved
outcome and proof string to public fields at settlement.

```quint
pure val emptySlot: MarketSlot = {
  slotId: -1,
  timeframe: Tf15m,
  marketEpoch: 1,
  outcome: SecretUnset,
  outcomeAssigned: false,
  phase: ResolvedNo,
  proofPrepared: false,
  draftProof: "",
  publishedClueIds: List(),
  publishedProof: "",
  retryCount: 0,
  tradingOpen: false,
}

pure def findSlot(slots: List[MarketSlot], slotId: int): MarketSlot =
  slots.foldl(emptySlot, (found, sl) => if (sl.slotId == slotId) sl else found)

pure def isOpenTradingPhase(phase: MarketPhase): bool =
  phase == Opening or phase == Mid or phase == Climax

pure def nextArcPhase(phase: MarketPhase): MarketPhase =
  if (phase == Opening) Mid
  else if (phase == Mid) Climax
  else if (phase == Climax) Expired
  else phase

pure def advanceSlotPhase(sl: MarketSlot): MarketSlot =
  val np = nextArcPhase(sl.phase)
  { ...sl, phase: np, tradingOpen: isOpenTradingPhase(np) }

pure def phaseMatchesClue(phase: MarketPhase, cluePhase: CluePhase): bool =
  (phase == Opening and cluePhase == ClueOpening)
    or (phase == Mid and cluePhase == ClueMid)
    or (phase == Climax and cluePhase == ClueClimax)

pure def makeSecretDraft(secretVal: SecretOutcome): SecretDraftProof =
  match secretVal {
    | SecretYes => "proof-yes"
    | SecretNo => "proof-no"
    | SecretUnset => ""
  }

pure def declassifyResolution(secretVal: SecretOutcome, draft: SecretDraftProof): str =
  if (secretVal == SecretYes and (draft == "proof-yes" or draft != "")) "proof-yes"
  else if (secretVal == SecretNo and (draft == "proof-no" or draft != "")) "proof-no"
  else ""
```

## Story: Advance rolling arcs and publish phase-aware clues

> As a player, I want markets to advance through opening, mid, and climax phases
> with phase-appropriate clues that never duplicate on retry and never reveal the
> hidden outcome early.

### Advancing a slot moves through active phases and closes trading immediately on expiry

```quint
pure def canAdvanceMarketPhase(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and target.slotId == slotId and isOpenTradingPhase(target.phase)

pure def advanceMarketPhase(s: NarrativeState, slotId: int, by: ArcActor): NarrativeState =
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) advanceSlotPhase(sl) else sl),
  }
```

### Clues require a matching active phase and a persisted unique clue key

Stale clues targeting a past phase or a non-trading market are refused, and
retried deliveries with an existing `clueKey` for the same market epoch are
refused so no clue is ever published twice.

```quint
pure def canPublishClue(
  s: NarrativeState,
  slotId: int,
  cluePhase: CluePhase,
  clueKey: str,
  body: str,
  by: ArcActor
): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and body != "" and clueKey != ""
    and target.slotId == slotId
    and target.tradingOpen
    and phaseMatchesClue(target.phase, cluePhase)
    and not(target.publishedClueIds.includes(clueKey))
    and not(s.feedClues.some(c =>
      c.slotId == slotId and c.marketEpoch == target.marketEpoch and c.clueKey == clueKey))

pure def publishClue(
  s: NarrativeState,
  slotId: int,
  cluePhase: CluePhase,
  clueKey: str,
  body: str,
  by: ArcActor
): NarrativeState =
  val target = findSlot(s.slots, slotId)
  val clue = {
    clueKey: clueKey,
    slotId: slotId,
    marketEpoch: target.marketEpoch,
    cluePhase: cluePhase,
    body: body,
  }
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) { ...sl, publishedClueIds: sl.publishedClueIds.append(clueKey) }
      else sl),
    feedClues: s.feedClues.append(clue),
  }
```

## Story: Prepare private proofs and settle expired markets safely

> As an operator, I want expired markets to hold settlement on `AwaitingProof`
> across retries or on `ManualHold` for admin review without stalling minute
> ticks or replacement of other slots, while keeping outcomes and draft proofs
> private until settlement.

### Expired markets prepare a private draft proof or enter manual review hold

Recovery retries missing proofs on `AwaitingProof` without touching
`publishedProof` or blocking other slots.

```quint
pure def canFailProofAttempt(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and target.slotId == slotId
    and (target.phase == Expired or target.phase == AwaitingProof)
    and not(target.proofPrepared)

pure def failProofAttempt(s: NarrativeState, slotId: int, by: ArcActor): NarrativeState =
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) { ...sl, phase: AwaitingProof, retryCount: sl.retryCount + 1 }
      else sl),
  }

pure def canPrepareProof(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and target.slotId == slotId
    and (target.phase == Expired or target.phase == AwaitingProof)
    and not(target.proofPrepared)
    and target.outcomeAssigned

pure def prepareProof(s: NarrativeState, slotId: int, needsManualReview: bool, by: ArcActor): NarrativeState =
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) {
        ...sl,
        draftProof: makeSecretDraft(sl.outcome),
        proofPrepared: true,
        phase: if (needsManualReview) ManualHold else AwaitingProof,
      }
      else sl),
  }
```

### Settlement declassifies the stored secret outcome only after proof preparation

```quint
pure def canSettleMarket(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and target.slotId == slotId
    and target.phase == AwaitingProof
    and target.proofPrepared
    and target.outcomeAssigned

pure def settleMarket(s: NarrativeState, slotId: int, by: ArcActor): NarrativeState =
  val target = findSlot(s.slots, slotId)
  val proofText = declassifyResolution(target.outcome, target.draftProof)
  val nextPhase =
    if (proofText == "proof-yes") ResolvedYes
    else if (proofText == "proof-no") ResolvedNo
    else ManualHold
  val didResolve = nextPhase == ResolvedYes or nextPhase == ResolvedNo
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) {
        ...sl,
        phase: nextPhase,
        publishedProof: if (didResolve) proofText else "",
        tradingOpen: false,
      }
      else sl),
    totalSettled: if (didResolve) s.totalSettled + 1 else s.totalSettled,
  }
```

### Only admins may approve or resolve markets on manual hold

```quint
pure def canAdminApproveHold(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcAdmin and target.slotId == slotId
    and target.phase == ManualHold
    and target.proofPrepared
    and target.outcomeAssigned

pure def adminApproveHold(s: NarrativeState, slotId: int, by: ArcActor): NarrativeState =
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) { ...sl, phase: AwaitingProof }
      else sl),
  }

pure def canAdminOverrideHold(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcAdmin and target.slotId == slotId and target.phase == ManualHold

pure def adminOverrideHold(s: NarrativeState, slotId: int, approveYes: bool, by: ArcActor): NarrativeState =
  val nextOutcome = if (approveYes) SecretYes else SecretNo
  val nextPhase = if (approveYes) ResolvedYes else ResolvedNo
  val nextProof = if (approveYes) "proof-yes" else "proof-no"
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) {
        ...sl,
        outcome: nextOutcome,
        outcomeAssigned: true,
        draftProof: nextProof,
        proofPrepared: true,
        phase: nextPhase,
        publishedProof: nextProof,
        tradingOpen: false,
      }
      else sl),
    totalSettled: s.totalSettled + 1,
  }
```

### Resolved slots are replaced independently with a fresh market epoch

```quint
pure def canReplaceMarket(s: NarrativeState, slotId: int, by: ArcActor): bool =
  val target = findSlot(s.slots, slotId)
  by == ArcSystem and target.slotId == slotId
    and (target.phase == ResolvedYes or target.phase == ResolvedNo)

pure def replaceMarket(s: NarrativeState, slotId: int, newOutcome: SecretOutcome, by: ArcActor): NarrativeState =
  val nextAssigned = if (newOutcome == SecretUnset) SecretYes else newOutcome
  {
    ...s,
    slots: s.slots.listMap(sl =>
      if (sl.slotId == slotId) {
        ...sl,
        marketEpoch: sl.marketEpoch + 1,
        outcome: nextAssigned,
        outcomeAssigned: true,
        phase: Opening,
        proofPrepared: false,
        draftProof: "",
        publishedClueIds: List(),
        publishedProof: "",
        retryCount: 0,
        tradingOpen: true,
      }
      else sl),
    totalReplaced: s.totalReplaced + 1,
  }

pure def seedReplacementMarket(slotId: int, s: NarrativeState, seedYes: bool, by: ArcActor): NarrativeState =
  replaceMarket(s, slotId, if (seedYes) SecretYes else SecretNo, by)
```

### Inductive invariants for 10 slots, unique clues, and secret isolation

The manual-hold reachability check exercises a state where a slot is held for
review and a settlement has already proceeded. The admin-only approval and
override transitions separately govern resolution of a held market.

```quint
pure def alwaysTenMarketSlots(s: NarrativeState): bool = and {
  s.slots.length() == 10,
  s.slots.every(sl => sl.slotId >= 0 and sl.slotId < 10 and sl.marketEpoch >= 1 and sl.retryCount >= 0),
  s.slots.every(a => s.slots.select(b => b.slotId == a.slotId).length() == 1),
  s.totalSettled >= 0,
  s.totalReplaced >= 0,
}

pure def alwaysLiveSlotHasSecretOutcome(s: NarrativeState): bool =
  s.slots.every(sl => sl.outcomeAssigned implies (sl.outcome == SecretYes or sl.outcome == SecretNo))

pure def alwaysUniqueClues(s: NarrativeState): bool = and {
  s.slots.every(sl => sl.publishedClueIds.every(k => sl.publishedClueIds.select(x => x == k).length() == 1)),
  s.feedClues.every(c => s.feedClues.select(d =>
    d.slotId == c.slotId and d.marketEpoch == c.marketEpoch and d.clueKey == c.clueKey).length() == 1),
  s.feedClues.every(c => s.slots.some(sl => sl.slotId == c.slotId and c.marketEpoch <= sl.marketEpoch)),
}

pure def alwaysTradingMatchesActivePhase(s: NarrativeState): bool =
  s.slots.every(sl => isOpenTradingPhase(sl.phase) iff sl.tradingOpen)

pure def alwaysNoPublicProofBeforeResolution(s: NarrativeState): bool =
  s.slots.every(sl => (sl.phase != ResolvedYes and sl.phase != ResolvedNo) implies sl.publishedProof == "")

pure def alwaysPreparedDraftMatchesSecretOutcome(s: NarrativeState): bool =
  s.slots.every(sl => sl.proofPrepared implies (sl.outcomeAssigned and sl.draftProof == makeSecretDraft(sl.outcome)))

pure def alwaysResolvedHasProofAndOutcome(s: NarrativeState): bool =
  s.slots.every(sl => and {
    sl.phase == ResolvedYes implies (sl.outcome == SecretYes and sl.publishedProof == "proof-yes" and not(sl.tradingOpen)),
    sl.phase == ResolvedNo implies (sl.outcome == SecretNo and sl.publishedProof == "proof-no" and not(sl.tradingOpen)),
  })

pure def sometimesResolvedYes(s: NarrativeState): bool =
  s.slots.some(sl => sl.phase == ResolvedYes)

pure def sometimesResolvedNo(s: NarrativeState): bool =
  s.slots.some(sl => sl.phase == ResolvedNo)

pure def sometimesManualHoldResolved(s: NarrativeState): bool =
  s.totalSettled >= 1 and s.slots.some(sl => sl.phase == ManualHold)

pure def sometimesReplacedAfterResolution(s: NarrativeState): bool =
  s.totalReplaced >= 1

pure def sometimesProofRetriedAndSettled(s: NarrativeState): bool =
  s.slots.some(sl => sl.retryCount >= 1 and (sl.phase == ResolvedYes or sl.phase == ResolvedNo))
