# Feed web application

The root state machine (`AppShellState`) for the Feed (`feed.fun`) web
application in `apps/app`, replacing the starter greeter spec. It composes:

- [Navigation, logged-out browsing, and Game vs Social modes](./navigation.md)
- [Onboarding, JoinSheet doors, and deferred gated actions](./onboarding.md)
- [End-to-end gameplay journey](./gameplayJourney.md)

## Domain

### Application shell state and single-agent grant tracking

An account holds at most one active connected MCP agent grant at any time
(PRD v0.4 §0 #2). Connecting a new client atomically revokes any prior active
grant, and Settings allows inspecting and revoking the current grant.

```quint
import navigation as Nav from "./navigation"
import onboarding as Onb from "./onboarding"
import money as Money from "../shared/money"

type AgentGrantInfo = {
  activeGrantId: int,
  activeClientName: str,
  revokedCount: int,
  nextGrantId: int,
}

type AppShellState = {
  nav: Nav::NavState,
  onb: Onb::OnboardingState,
  agentGrant: AgentGrantInfo,
}

pure val initial: AppShellState = {
  nav: Nav::initial,
  onb: Onb::initial,
  agentGrant: {
    activeGrantId: 0,
    activeClientName: "",
    revokedCount: 0,
    nextGrantId: 1,
  },
}

pure val clientNameValues = Set("", "ChatGPT", "Claude", "Hermes")

pure def accountCashCents(s: AppShellState): Money::Cents =
  Money::ptsToCents(s.onb.pointsBalance)
```

## Story: Browse, switch modes, and sign in through the JoinSheet

> As a visitor or player, I want to browse the public feed without a login
> modal, switch between Game and Social modes, trigger gated actions that open
> the JoinSheet and complete after sign-in, and manage my single connected AI
> agent grant.

### Public navigation, feed tabs, mode switching, and visitor banners

```quint
pure def canViewFeedItem(s: AppShellState, target: Nav::PublicTarget): bool =
  Nav::canViewPublicContent(s.nav, target)

pure def viewFeedItem(s: AppShellState, target: Nav::PublicTarget): AppShellState =
  { ...s, nav: Nav::viewPublicContent(s.nav, target) }

pure def canScrollVisitorFeed(s: AppShellState): bool =
  Nav::canScrollFeed(s.nav)

pure def scrollVisitorFeed(s: AppShellState): AppShellState =
  { ...s, nav: Nav::scrollFeed(s.nav) }

pure def canDismissVisitorBanner(s: AppShellState): bool =
  Nav::canDismissBanner(s.nav)

pure def dismissVisitorBanner(s: AppShellState): AppShellState =
  { ...s, nav: Nav::dismissBanner(s.nav) }

pure def canDismissFirstVisitExplainer(s: AppShellState): bool =
  Onb::canDismissExplainerCard(s.onb)

pure def dismissFirstVisitExplainer(s: AppShellState): AppShellState =
  { ...s, onb: Onb::dismissExplainerCard(s.onb) }

pure def canNavigateApp(s: AppShellState, targetRoute: Nav::AppRoute): bool =
  Nav::canNavigateTo(s.nav, targetRoute)

pure def navigateApp(s: AppShellState, targetRoute: Nav::AppRoute): AppShellState =
  { ...s, nav: Nav::navigateTo(s.nav, targetRoute) }

pure def canSelectTab(s: AppShellState, tab: Nav::FeedTab): bool =
  Nav::canSelectFeedTab(s.nav, tab)

pure def selectTab(s: AppShellState, tab: Nav::FeedTab): AppShellState =
  { ...s, nav: Nav::selectFeedTab(s.nav, tab) }

pure def switchUiMode(s: AppShellState): AppShellState =
  { ...s, nav: Nav::toggleUiMode(s.nav) }

pure def updateAtRiskPositions(s: AppShellState, atRisk: bool): AppShellState =
  { ...s, nav: Nav::setAtRiskPositions(s.nav, atRisk) }
```

### Deferred gated actions and JoinSheet sign-in stay synchronized with navigation auth state

```quint
pure def canTriggerAppGatedAction(
  s: AppShellState,
  actionKind: Onb::GatedActionKind,
  targetId: int
): bool =
  Onb::canTriggerGatedAction(s.onb, actionKind, targetId)

pure def triggerAppGatedAction(
  s: AppShellState,
  actionKind: Onb::GatedActionKind,
  targetId: int
): AppShellState =
  { ...s, onb: Onb::triggerGatedAction(s.onb, actionKind, targetId) }

pure def canOpenJoinSheet(s: AppShellState): bool =
  Onb::canOpenJoinSheetDirectly(s.onb)

pure def openJoinSheet(s: AppShellState): AppShellState =
  { ...s, onb: Onb::openJoinSheetDirectly(s.onb) }

pure def canCloseJoinSheetModal(s: AppShellState): bool =
  Onb::canCloseJoinSheet(s.onb)

pure def closeJoinSheetModal(s: AppShellState): AppShellState =
  { ...s, onb: Onb::closeJoinSheet(s.onb) }

pure def canRequestPhoneSms(s: AppShellState, phoneAllowed: bool, notVoip: bool): bool =
  Onb::canRequestSmsCode(s.onb, phoneAllowed, notVoip)

pure def requestPhoneSms(s: AppShellState, phoneAllowed: bool, notVoip: bool): AppShellState =
  { ...s, onb: Onb::requestSmsCode(s.onb, phoneAllowed, notVoip) }

pure def canVerifyPhoneSms(s: AppShellState, codeValid: bool, isNewAccount: bool): bool =
  Onb::canVerifySmsCode(s.onb, codeValid, isNewAccount)

pure def verifyPhoneSms(s: AppShellState, codeValid: bool, isNewAccount: bool): AppShellState =
  val nextOnb = Onb::verifySmsCode(s.onb, codeValid, isNewAccount)
  val nextNav = if (nextOnb.signedIn and not(s.nav.signedIn)) Nav::signInNav(s.nav, false) else s.nav
  { ...s, onb: nextOnb, nav: nextNav }

pure def canCompletePhoneSignUp(
  s: AppShellState,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): bool =
  Onb::canCompleteNewPhoneProfile(s.onb, usernameValid, age18Plus, acceptedTerms)

pure def completePhoneSignUp(
  s: AppShellState,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): AppShellState =
  {
    ...s,
    onb: Onb::completeNewPhoneProfile(s.onb, usernameValid, age18Plus, acceptedTerms),
    nav: Nav::signInNav(s.nav, false),
  }

pure def canLaunchAgentSkillDoor(s: AppShellState): bool =
  Onb::canLaunchAgentDoor(s.onb)

pure def launchAgentSkillDoor(s: AppShellState, host: Onb::AgentHost): AppShellState =
  { ...s, onb: Onb::launchAgentDoor(s.onb, host) }

pure def canSwitchAgentToPhone(s: AppShellState): bool =
  Onb::canProceedToPhoneFromAgent(s.onb)

pure def switchAgentToPhone(s: AppShellState): AppShellState =
  { ...s, onb: Onb::proceedToPhoneFromAgent(s.onb) }

pure def canOpenReviewerSignIn(s: AppShellState): bool =
  Onb::canOpenReviewerDoor(s.onb)

pure def openReviewerSignIn(s: AppShellState): AppShellState =
  { ...s, onb: Onb::openReviewerDoor(s.onb) }

pure def canCompleteReviewerSignIn(
  s: AppShellState,
  isReviewerAccount: bool,
  passwordValid: bool
): bool =
  Onb::canSubmitReviewerSignIn(s.onb, isReviewerAccount, passwordValid)

pure def completeReviewerSignIn(
  s: AppShellState,
  isReviewerAccount: bool,
  passwordValid: bool
): AppShellState =
  {
    ...s,
    onb: Onb::submitReviewerSignIn(s.onb, isReviewerAccount, passwordValid),
    nav: Nav::signInNav(s.nav, false),
  }

pure def canSignOutApp(s: AppShellState): bool =
  s.nav.signedIn and s.onb.signedIn

pure def signOutApp(s: AppShellState): AppShellState =
  {
    ...s,
    nav: Nav::signOutNav(s.nav),
    onb: Onb::signOutOnboarding(s.onb),
  }
```

## Story: Connect and revoke the account's single AI agent

> As a signed-in player, I want to connect at most one AI agent at a time so
> that connecting a new client replaces any prior grant and revoking ends its
> access immediately.

### Connecting a new agent atomically revokes any prior grant

```quint
pure def canConnectSingleAgent(s: AppShellState, clientName: str): bool =
  s.nav.signedIn and clientName != ""

pure def connectSingleAgent(s: AppShellState, clientName: str): AppShellState =
  val hadPrior = s.agentGrant.activeGrantId > 0
  {
    ...s,
    agentGrant: {
      activeGrantId: s.agentGrant.nextGrantId,
      activeClientName: clientName,
      revokedCount: if (hadPrior) s.agentGrant.revokedCount + 1 else s.agentGrant.revokedCount,
      nextGrantId: s.agentGrant.nextGrantId + 1,
    },
  }

pure def canRevokeConnectedAgent(s: AppShellState): bool =
  s.nav.signedIn and s.agentGrant.activeGrantId > 0

pure def revokeConnectedAgent(s: AppShellState): AppShellState =
  {
    ...s,
    agentGrant: {
      ...s.agentGrant,
      activeGrantId: 0,
      activeClientName: "",
      revokedCount: s.agentGrant.revokedCount + 1,
    },
  }
```

### Root web application invariants and goals

```quint
pure def alwaysShellSubmachinesValid(s: AppShellState): bool = and {
  Nav::alwaysNoLoginModalOnLoad(s.nav),
  Nav::alwaysLoggedOutDefaultsLatest(s.nav),
  Nav::alwaysBannerDelayedForVisitors(s.nav),
  Nav::alwaysProtectedRoutesRequireAuth(s.nav),
  Nav::alwaysSocialModeNeverOnMarkets(s.nav),
  Nav::alwaysNonNegativeViews(s.nav),
  Nav::alwaysSocialModeHidesFinancialSurfaces(s.nav),
  Onb::alwaysSignedInClearsPendingAndClosesSheet(s.onb),
  Onb::alwaysStartingGrantAtMostOnce(s.onb),
  Onb::alwaysCompletedActionsValid(s.onb),
}

pure def alwaysAuthSynced(s: AppShellState): bool =
  s.nav.signedIn == s.onb.signedIn

pure def alwaysAtMostOneActiveAgentGrant(s: AppShellState): bool = and {
  s.agentGrant.activeGrantId >= 0,
  s.agentGrant.nextGrantId >= 1,
  s.agentGrant.activeGrantId < s.agentGrant.nextGrantId,
  s.agentGrant.revokedCount >= 0,
  s.agentGrant.activeGrantId > 0 implies s.agentGrant.activeClientName != "",
  s.agentGrant.activeGrantId == 0 implies s.agentGrant.activeClientName == "",
}

pure def sometimesGatedActionCompletedAfterSignUp(s: AppShellState): bool =
  s.nav.signedIn and s.onb.startingGrantAwarded and s.onb.completedActions.length() >= 1

pure def sometimesAgentConnectedThenReplaced(s: AppShellState): bool =
  s.agentGrant.activeGrantId > 0 and s.agentGrant.revokedCount >= 1

pure def sometimesSocialModeWithOpenPositions(s: AppShellState): bool =
  Nav::visibleSurfaces(s.nav).showAtRiskPositionsNotice
