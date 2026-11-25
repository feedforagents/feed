# End-to-end gameplay journey

Full end-to-end Feed (`feed.fun`) gameplay loop tying together X-style
logged-out browsing (feed and leaderboard), deferred JoinSheet sign-in and
fixed 100 pts ($100 virtual capital) phone grant with no buying or refilling
capital, single-agent OAuth/device connection, social posting, prediction and
20x perp trading, D-25 bounded NPC spot trading driving perp index prices and
alpha-group invites, and private proof preparation before 1 pt/share
settlement.

## Domain

### Journey state across web navigation, onboarding, economy, and world engine

```quint
import navigation as Nav from "./navigation"
import onboarding as Onb from "./onboarding"
import spendBudget as SB from "../engine/spendBudget"
import narrativeArc as NA from "../engine/narrativeArc"
import npcLoop as NL from "../engine/npcLoop"

type AgentConnectFlow = FlowOAuth21 | FlowDeviceCode

type PlayerEconomy = {
  cashCents: int,
  startingGrantCents: int,
  agentGrantId: int,
  agentRevokedCount: int,
  nextGrantId: int,
  activeAgentClient: str,
  socialPostsCount: int,
  viaAgentActionsCount: int,
  predictionSlotId: int,
  predictionYesShares: int,
  predictionCostCents: int,
  perpOpen: bool,
  perpMarginCents: int,
  perpLeverage: int,
  perpEntryIndexPrice: int,
  alphaInvited: bool,
  alphaJoined: bool,
  settledPayoutCents: int,
  leaderboardNetProfitCents: int,
}

type JourneyState = {
  nav: Nav::NavState,
  onb: Onb::OnboardingState,
  budget: SB::BudgetLedger,
  arcs: NA::NarrativeState,
  npc: NL::NpcLoopState,
  player: PlayerEconomy,
}

pure val initial: JourneyState = {
  nav: Nav::initial,
  onb: Onb::initial,
  budget: SB::initial,
  arcs: NA::initial,
  npc: NL::initial,
  player: {
    cashCents: 0,
    startingGrantCents: 0,
    agentGrantId: 0,
    agentRevokedCount: 0,
    nextGrantId: 1,
    activeAgentClient: "",
    socialPostsCount: 0,
    viaAgentActionsCount: 0,
    predictionSlotId: -1,
    predictionYesShares: 0,
    predictionCostCents: 0,
    perpOpen: false,
    perpMarginCents: 0,
    perpLeverage: 0,
    perpEntryIndexPrice: 0,
    alphaInvited: false,
    alphaJoined: false,
    settledPayoutCents: 0,
    leaderboardNetProfitCents: 0,
  },
}

pure val targetIdValues = Set(0, 1, 2)
pure val clientNameValues = Set("", "ChatGPT", "Claude", "Hermes")
pure val slotIdValues = Set(0, 8, 9)
pure val stakeCentsValues = Set(0, 1000, 5000)
pure val sharesBoughtValues = Set(0, 40, 80)
pure val marginCentsValues = Set(0, 1000, 2000)
pure val leverageValues = Set(0, 1, 10, 20, 25)
pure val actorIdValues = Set(0, 1, 2)
pure val boundCentsValues = Set(0, 1000, 9000)
pure val actualCentsValues = Set(0, 500, 1000)
pure val spotDeltaValues = Set(-200, 0, 500)
```

### Equity and profit leaderboard calculation

Net profit on the leaderboard equals current equity (`cash + cost basis of
open predictions + locked perp margin`) minus the fixed 100 pts starting grant
(D-15b). No capital purchase or refill transition exists.

```quint
pure def computeEquityCents(p: PlayerEconomy): int =
  p.cashCents + p.predictionCostCents + p.perpMarginCents

pure def computeNetProfitCents(p: PlayerEconomy): int =
  computeEquityCents(p) - p.startingGrantCents

pure def withLeaderboardSynced(p: PlayerEconomy): PlayerEconomy =
  { ...p, leaderboardNetProfitCents: computeNetProfitCents(p) }
```

## Story: Walk the full Feed gameplay loop from visitor to settlement

> As a new player, I want to browse the feed and leaderboard logged out,
> trigger a gated action to open the JoinSheet, verify my phone (18+ and
> username) to receive a fixed 100 pts ($100 virtual capital) and complete my
> deferred action, connect one AI agent, trade predictions and up to 20x perps
> alongside NPC spot activity and alpha invites, and collect 1 pt per winning
> share after private proof settlement to climb the profit leaderboard.

### Visitor browses, hits a gated action, verifies phone, and receives 100 pts

```quint
pure def canVisitorBrowseFeed(j: JourneyState, target: Nav::PublicTarget): bool =
  Nav::canViewPublicContent(j.nav, target)

pure def visitorBrowseFeed(j: JourneyState, target: Nav::PublicTarget): JourneyState =
  { ...j, nav: Nav::viewPublicContent(j.nav, target) }

pure def canVisitorTriggerGatedAction(
  j: JourneyState,
  actionKind: Onb::GatedActionKind,
  targetId: int
): bool =
  not(j.nav.signedIn) and Onb::canTriggerGatedAction(j.onb, actionKind, targetId)

pure def visitorTriggerGatedAction(
  j: JourneyState,
  actionKind: Onb::GatedActionKind,
  targetId: int
): JourneyState =
  { ...j, onb: Onb::triggerGatedAction(j.onb, actionKind, targetId) }

pure def canVisitorVerifyPhoneAndSignUp(
  j: JourneyState,
  phoneAllowed: bool,
  notVoip: bool,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): bool =
  not(j.nav.signedIn) and j.onb.joinSheetOpen
    and j.onb.stepKind == Onb::StepChooseDoor
    and not(j.onb.startingGrantAwarded)
    and phoneAllowed and notVoip and usernameValid and age18Plus and acceptedTerms

pure def visitorVerifyPhoneAndSignUp(
  j: JourneyState,
  phoneAllowed: bool,
  notVoip: bool,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): JourneyState =
  val s1 = Onb::requestSmsCode(j.onb, phoneAllowed, notVoip)
  val s2 = Onb::verifySmsCode(s1, true, true)
  val s3 = Onb::completeNewPhoneProfile(s2, usernameValid, age18Plus, acceptedTerms)
  val nextPlayer = withLeaderboardSynced({
    ...j.player,
    cashCents: j.player.cashCents + 10000,
    startingGrantCents: 10000,
  })
  { ...j, nav: Nav::signInNav(j.nav, false), onb: s3, player: nextPlayer }
```

### Signed-in player connects one AI agent, posts socially, and trades predictions and 20x perps

Connecting a new client via OAuth 2.1 or RFC 8628 device flow atomically
revokes any previous grant. All trades draw strictly from the fixed 100 pts
starting grant and subsequent realized profits.

```quint
pure def canPlayerConnectAgent(
  j: JourneyState,
  clientName: str,
  flowKind: AgentConnectFlow
): bool =
  j.nav.signedIn and clientName != ""
    and (flowKind == FlowOAuth21 or flowKind == FlowDeviceCode)

pure def playerConnectAgent(
  j: JourneyState,
  clientName: str,
  flowKind: AgentConnectFlow
): JourneyState =
  val hadPrior = j.player.agentGrantId > 0
  val nextRoute = if (flowKind == FlowDeviceCode) Nav::Link else Nav::OAuthConsent
  val nextNav = if (j.nav.signedIn) { ...j.nav, route: nextRoute } else j.nav
  {
    ...j,
    nav: nextNav,
    player: {
      ...j.player,
      agentGrantId: j.player.nextGrantId,
      nextGrantId: j.player.nextGrantId + 1,
      agentRevokedCount: if (hadPrior) j.player.agentRevokedCount + 1 else j.player.agentRevokedCount,
      activeAgentClient: clientName,
    },
  }

pure def canPlayerPostSocial(j: JourneyState, viaAgent: bool): bool =
  j.nav.signedIn and (viaAgent implies j.player.agentGrantId > 0)

pure def playerPostSocial(j: JourneyState, viaAgent: bool): JourneyState =
  {
    ...j,
    npc: NL::recordPlayerEngagement(j.npc, 1, 2, NL::HumanEngager),
    player: {
      ...j.player,
      socialPostsCount: j.player.socialPostsCount + 1,
      viaAgentActionsCount: if (viaAgent) j.player.viaAgentActionsCount + 1 else j.player.viaAgentActionsCount,
    },
  }

pure def canPlayerTradePrediction(
  j: JourneyState,
  slotId: int,
  stakeCents: int,
  sharesBought: int,
  viaAgent: bool
): bool =
  val target = NA::findSlot(j.arcs.slots, slotId)
  j.nav.signedIn
    and (viaAgent implies j.player.agentGrantId > 0)
    and j.player.predictionYesShares == 0
    and target.slotId == slotId
    and target.tradingOpen
    and stakeCents > 0 and stakeCents <= j.player.cashCents
    and sharesBought > 0 and sharesBought <= 200

pure def playerTradePrediction(
  j: JourneyState,
  slotId: int,
  stakeCents: int,
  sharesBought: int,
  viaAgent: bool
): JourneyState =
  val nextPlayer = withLeaderboardSynced({
    ...j.player,
    cashCents: j.player.cashCents - stakeCents,
    predictionSlotId: slotId,
    predictionYesShares: sharesBought,
    predictionCostCents: stakeCents,
    viaAgentActionsCount: if (viaAgent) j.player.viaAgentActionsCount + 1 else j.player.viaAgentActionsCount,
  })
  { ...j, player: nextPlayer }

pure def canPlayerOpenPerp(
  j: JourneyState,
  marginCents: int,
  leverage: int,
  viaAgent: bool
): bool =
  j.nav.signedIn
    and (viaAgent implies j.player.agentGrantId > 0)
    and not(j.player.perpOpen)
    and marginCents > 0 and marginCents <= j.player.cashCents
    and leverage >= 1 and leverage <= 20

pure def playerOpenPerp(
  j: JourneyState,
  marginCents: int,
  leverage: int,
  viaAgent: bool
): JourneyState =
  val nextPlayer = withLeaderboardSynced({
    ...j.player,
    cashCents: j.player.cashCents - marginCents,
    perpOpen: true,
    perpMarginCents: marginCents,
    perpLeverage: leverage,
    perpEntryIndexPrice: j.npc.spotIndexPrice,
    viaAgentActionsCount: if (viaAgent) j.player.viaAgentActionsCount + 1 else j.player.viaAgentActionsCount,
  })
  { ...j, player: nextPlayer }
```

### Bounded NPC tick moves spot index price and sends alpha invite; market settles 1 pt per winning share

```quint
pure def canRunNpcTickSpotAndAlpha(
  j: JourneyState,
  actorId: int,
  boundCents: int,
  actualCents: int,
  spotDelta: int
): bool =
  SB::canReserveAttempt(j.budget, true, boundCents)
    and actualCents >= 0 and actualCents <= boundCents
    and actorId > 0
    and (j.npc.phase == NL::TickIdle or j.npc.phase == NL::TickDone)
    and j.npc.spotIndexPrice + spotDelta >= 100
    and spotDelta != 0

pure def runNpcTickSpotAndAlpha(
  j: JourneyState,
  actorId: int,
  boundCents: int,
  actualCents: int,
  spotDelta: int
): JourneyState =
  val maxSteps = SB::maxStepsAllowed(j.budget)
  val batch = SB::effectiveBatch(j.budget, SB::baseNpcBatch)
  val b1 = SB::reserveAttempt(j.budget, true, boundCents)
  val b2 = SB::confirmSpend(b1, j.budget.nextAttemptId, actualCents)
  val n1 = NL::startNpcTick(j.npc, actorId, NL::NpcCharacter, maxSteps, batch, NL::EngineNpcRunner)
  val n2 = NL::executeNpcAction(
    NL::decideAction(NL::observeFeed(n1, NL::EngineNpcRunner), NL::ActSpot, NL::EngineNpcRunner),
    spotDelta,
    1,
    NL::EngineNpcRunner
  )
  val canInvite = NL::playerScore(n2.engagements, 1) >= NL::minAlphaEngagement
  val n3 = if (canInvite)
    NL::executeNpcAction(
      NL::decideAction(NL::observeFeed(n2, NL::EngineNpcRunner), NL::ActAlphaInvite, NL::EngineNpcRunner),
      0,
      1,
      NL::EngineNpcRunner
    )
    else n2
  val n4 = if (n3.phase == NL::TickDone) n3 else NL::endNpcTick(n3, NL::EngineNpcRunner)
  {
    ...j,
    budget: b2,
    npc: n4,
    player: if (canInvite) { ...j.player, alphaInvited: true } else j.player,
  }

pure def canPlayerJoinAlphaGroup(j: JourneyState): bool =
  j.nav.signedIn and j.player.alphaInvited and not(j.player.alphaJoined)

pure def playerJoinAlphaGroup(j: JourneyState): JourneyState =
  { ...j, player: { ...j.player, alphaJoined: true } }

pure def canExpireMarketSlot(j: JourneyState, slotId: int): bool =
  NA::canAdvanceMarketPhase(j.arcs, slotId, NA::ArcSystem)

pure def expireMarketSlot(j: JourneyState, slotId: int): JourneyState =
  { ...j, arcs: NA::advanceMarketPhase(j.arcs, slotId, NA::ArcSystem) }

pure def canPrepareMarketProof(j: JourneyState, slotId: int): bool =
  NA::canPrepareProof(j.arcs, slotId, NA::ArcSystem)

pure def prepareMarketProof(j: JourneyState, slotId: int, needsManualReview: bool): JourneyState =
  { ...j, arcs: NA::prepareProof(j.arcs, slotId, needsManualReview, NA::ArcSystem) }

pure def canSettleMarketAndPayout(j: JourneyState, slotId: int): bool =
  NA::canSettleMarket(j.arcs, slotId, NA::ArcSystem)

pure def settleMarketAndPayout(j: JourneyState, slotId: int): JourneyState =
  val nextArcs = NA::settleMarket(j.arcs, slotId, NA::ArcSystem)
  val settledSlot = NA::findSlot(nextArcs.slots, slotId)
  val playerHoldsSlot = j.player.predictionYesShares > 0 and j.player.predictionSlotId == slotId
  val payout = if (playerHoldsSlot and settledSlot.phase == NA::ResolvedYes) j.player.predictionYesShares * 100 else 0
  val nextPlayer = if (playerHoldsSlot)
    withLeaderboardSynced({
      ...j.player,
      cashCents: j.player.cashCents + payout,
      predictionSlotId: -1,
      predictionYesShares: 0,
      predictionCostCents: 0,
      settledPayoutCents: j.player.settledPayoutCents + payout,
    })
    else j.player
  { ...j, arcs: nextArcs, player: nextPlayer }
```

### End-to-end journey invariants and witness path

```quint
pure def alwaysJourneySubmachinesConsistent(j: JourneyState): bool = and {
  Nav::alwaysNoLoginModalOnLoad(j.nav),
  Nav::alwaysLoggedOutDefaultsLatest(j.nav),
  Nav::alwaysBannerDelayedForVisitors(j.nav),
  Nav::alwaysProtectedRoutesRequireAuth(j.nav),
  Nav::alwaysSocialModeNeverOnMarkets(j.nav),
  Onb::alwaysSignedInClearsPendingAndClosesSheet(j.onb),
  Onb::alwaysStartingGrantAtMostOnce(j.onb),
  SB::alwaysAttemptIdsUnique(j.budget),
  SB::alwaysTotalsMatchAttempts(j.budget),
  SB::alwaysNonNegativeAndWithinBudget(j.budget),
  NA::alwaysTenMarketSlots(j.arcs),
  NA::alwaysLiveSlotHasSecretOutcome(j.arcs),
  NA::alwaysUniqueClues(j.arcs),
  NA::alwaysNoPublicProofBeforeResolution(j.arcs),
  NA::alwaysPreparedDraftMatchesSecretOutcome(j.arcs),
  NA::alwaysResolvedHasProofAndOutcome(j.arcs),
  NL::alwaysNpcRolesOnly(j.npc),
  NL::alwaysStepsBounded(j.npc),
  NL::alwaysSpotIndexPositive(j.npc),
}

pure def alwaysEconomyAndSingleAgentConstraints(j: JourneyState): bool = and {
  j.nav.signedIn == j.onb.signedIn,
  j.player.cashCents >= 0,
  j.player.startingGrantCents == (if (j.onb.startingGrantAwarded) 10000 else 0),
  j.player.agentGrantId >= 0,
  j.player.nextGrantId >= 1,
  j.player.agentGrantId < j.player.nextGrantId,
  j.player.agentGrantId > 0 implies j.player.activeAgentClient != "",
  j.player.perpOpen implies (j.player.perpLeverage >= 1 and j.player.perpLeverage <= 20 and j.player.perpMarginCents > 0),
  j.player.leaderboardNetProfitCents == computeNetProfitCents(j.player),
}

pure def stepFixedStartingCapitalNoRefill(
  before: JourneyState,
  after: JourneyState
): bool =
  before.onb.startingGrantAwarded implies
    (after.onb.startingGrantAwarded and after.player.startingGrantCents == 10000)

pure def sometimesFullGameplayJourneyCompleted(j: JourneyState): bool = and {
  j.nav.signedIn,
  j.nav.itemsViewed >= 2,
  j.onb.completedActions.length() >= 1,
  j.player.startingGrantCents == 10000,
  j.player.agentGrantId > 0,
  j.player.agentRevokedCount >= 1,
  j.player.viaAgentActionsCount >= 1,
  j.player.socialPostsCount >= 1,
  j.player.perpOpen,
  j.player.perpLeverage == 20,
  j.npc.spotIndexPrice != j.player.perpEntryIndexPrice,
  j.player.alphaJoined,
  j.player.settledPayoutCents > 0,
  j.player.leaderboardNetProfitCents > 0,
}

pure val eval_witness_sometimesFullGameplayJourneyCompleted = (
  ("visitorBrowseFeed", Nav::ViewFeed),
  ("visitorBrowseFeed", Nav::ViewLeaderboard),
  ("visitorTriggerGatedAction", Onb::GatedLike, 1),
  ("visitorVerifyPhoneAndSignUp", true, true, true, true, true),
  ("playerConnectAgent", "ChatGPT", FlowOAuth21),
  ("playerConnectAgent", "Claude", FlowDeviceCode),
  ("playerPostSocial", true),
  ("playerTradePrediction", 8, 5000, 80, true),
  ("playerOpenPerp", 2000, 20, false),
  ("runNpcTickSpotAndAlpha", 1, 1000, 500, 500),
  "playerJoinAlphaGroup",
  ("expireMarketSlot", 8),
  ("prepareMarketProof", 8, false),
  ("settleMarketAndPayout", 8)
)
```

### Discovered by the proof: Spend budget attempt bounds remain valid

Discovered by the proof: without stating
`SB::alwaysAttemptBoundsValid(j.budget)`, an arbitrary prior attempt could
already hold `nextAttemptId`, breaking `SB::alwaysAttemptIdsUnique`,
`SB::alwaysTotalsMatchAttempts`, and `SB::alwaysNonNegativeAndWithinBudget`
during `runNpcTickSpotAndAlpha`.

```quint
pure def alwaysBudgetAttemptBoundsValid(j: JourneyState): bool =
  SB::alwaysAttemptBoundsValid(j.budget)
```
