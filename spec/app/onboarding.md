# Onboarding, JoinSheet doors, and deferred gated actions

JoinSheet two-door onboarding (Phone 6-digit SMS code and one-click AI Agent
`SKILL.md` deep-link prompt + Reviewer sign-in link), deferred `PendingAction`
queuing and automatic completion upon sign-in, and the dismissible first-visit
explainer card, derived from PRD §6.2–§6.4, §7.1, §7.4, §14 D-1–D-4, D-11,
D-19, and D-29.

## Domain

### Gated actions, JoinSheet doors, and agent hosts

```quint
type GatedActionKind =
  | GatedNone
  | GatedLike
  | GatedRepost
  | GatedReply
  | GatedPost
  | GatedFollow
  | GatedDm
  | GatedTrade
  | GatedPersistMode

type JoinDoor = DoorNone | DoorPhone | DoorAgent | DoorReviewer

type OnboardingStep =
  | StepClosed
  | StepChooseDoor
  | StepSmsCodeSent
  | StepCompleteProfile
  | StepAgentPromptCopied
  | StepReviewerLogin
  | StepSignedIn

type AgentHost =
  | HostChatGPT
  | HostClaude
  | HostGemini
  | HostGrok
  | HostPerplexity
  | HostMuse
  | HostHermes
  | HostOpenClaw
  | HostCopyPrompt

type PendingAction = {
  actionKind: GatedActionKind,
  targetId: int,
}

type OnboardingState = {
  signedIn: bool,
  isReviewer: bool,
  joinSheetOpen: bool,
  door: JoinDoor,
  stepKind: OnboardingStep,
  selectedHost: AgentHost,
  pendingAction: PendingAction,
  completedActions: List[PendingAction],
  explainerCardVisible: bool,
  pointsBalance: int,
  startingGrantAwarded: bool,
  ageConfirmed: bool,
  codeResendCount: int,
  skillPromptCopied: bool,
}

pure val noPendingAction: PendingAction = { actionKind: GatedNone, targetId: 0 }

pure val initial: OnboardingState = {
  signedIn: false,
  isReviewer: false,
  joinSheetOpen: false,
  door: DoorNone,
  stepKind: StepClosed,
  selectedHost: HostClaude,
  pendingAction: noPendingAction,
  completedActions: List(),
  explainerCardVisible: true,
  pointsBalance: 0,
  startingGrantAwarded: false,
  ageConfirmed: false,
  codeResendCount: 0,
  skillPromptCopied: false,
}

pure def completeQueuedIfPresent(
  completed: List[PendingAction],
  pending: PendingAction
): List[PendingAction] =
  if (pending.actionKind != GatedNone) completed.append(pending) else completed
```

## Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer

> As a visitor, I want trying to like, post, trade, or save mode persistently to
> open the JoinSheet and automatically complete my action once I sign in, and I
> want to dismiss the first-visit explainer card cleanly.

### Triggering a gated action opens the JoinSheet while logged out or executes immediately when signed in

```quint
pure def canTriggerGatedAction(
  s: OnboardingState,
  actionKind: GatedActionKind,
  targetId: int
): bool =
  actionKind != GatedNone and targetId > 0

pure def triggerGatedAction(
  s: OnboardingState,
  actionKind: GatedActionKind,
  targetId: int
): OnboardingState =
  val queued = { actionKind: actionKind, targetId: targetId }
  if (s.signedIn)
    { ...s, completedActions: s.completedActions.append(queued) }
  else {
    ...s,
    joinSheetOpen: true,
    door: DoorNone,
    stepKind: StepChooseDoor,
    pendingAction: queued,
  }

pure def canOpenJoinSheetDirectly(s: OnboardingState): bool =
  not(s.signedIn) and not(s.joinSheetOpen)

pure def openJoinSheetDirectly(s: OnboardingState): OnboardingState =
  { ...s, joinSheetOpen: true, door: DoorNone, stepKind: StepChooseDoor }

pure def canCloseJoinSheet(s: OnboardingState): bool = s.joinSheetOpen

pure def closeJoinSheet(s: OnboardingState): OnboardingState =
  {
    ...s,
    joinSheetOpen: false,
    door: DoorNone,
    stepKind: StepClosed,
    pendingAction: noPendingAction,
  }

pure def canDismissExplainerCard(s: OnboardingState): bool = s.explainerCardVisible

pure def dismissExplainerCard(s: OnboardingState): OnboardingState =
  { ...s, explainerCardVisible: false }
```

## Story: Sign in through the Phone SMS door, AI Agent SKILL.md door, or Reviewer link

> As a new or returning player, I want to verify an allowlisted non-VoIP phone
> with a 6-digit SMS code, confirm 18+ and pick a username to receive 100 pts,
> or start via my AI agent's `SKILL.md` prompt, and have any deferred action run
> immediately.

### Phone door enforces country allowlist, non-VoIP check, 18+ attestation, and one-time 100 pts grant

```quint
pure def canRequestSmsCode(
  s: OnboardingState,
  phoneAllowed: bool,
  notVoip: bool
): bool =
  not(s.signedIn) and s.joinSheetOpen
    and (s.stepKind == StepChooseDoor or s.stepKind == StepSmsCodeSent)
    and phoneAllowed and notVoip

pure def requestSmsCode(
  s: OnboardingState,
  phoneAllowed: bool,
  notVoip: bool
): OnboardingState =
  {
    ...s,
    door: DoorPhone,
    stepKind: StepSmsCodeSent,
    codeResendCount: s.codeResendCount + 1,
  }

pure def canVerifySmsCode(
  s: OnboardingState,
  codeValid: bool,
  isNewAccount: bool
): bool =
  not(s.signedIn) and s.joinSheetOpen and s.door == DoorPhone
    and s.stepKind == StepSmsCodeSent and codeValid
    and (isNewAccount implies not(s.startingGrantAwarded))

pure def verifySmsCode(
  s: OnboardingState,
  codeValid: bool,
  isNewAccount: bool
): OnboardingState =
  if (isNewAccount)
    { ...s, stepKind: StepCompleteProfile }
  else {
    ...s,
    signedIn: true,
    joinSheetOpen: false,
    stepKind: StepSignedIn,
    pendingAction: noPendingAction,
    completedActions: completeQueuedIfPresent(s.completedActions, s.pendingAction),
  }

pure def canCompleteNewPhoneProfile(
  s: OnboardingState,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): bool =
  not(s.signedIn) and s.joinSheetOpen and s.door == DoorPhone
    and s.stepKind == StepCompleteProfile
    and not(s.startingGrantAwarded)
    and usernameValid and age18Plus and acceptedTerms

pure def completeNewPhoneProfile(
  s: OnboardingState,
  usernameValid: bool,
  age18Plus: bool,
  acceptedTerms: bool
): OnboardingState =
  {
    ...s,
    signedIn: true,
    joinSheetOpen: false,
    stepKind: StepSignedIn,
    pointsBalance: s.pointsBalance + 100,
    startingGrantAwarded: true,
    ageConfirmed: true,
    pendingAction: noPendingAction,
    completedActions: completeQueuedIfPresent(s.completedActions, s.pendingAction),
  }
```

### AI Agent door launches SKILL.md prompt and hands off to phone verification

The agent never receives phone numbers or SMS codes; the user verifies their
phone once in the browser.

```quint
pure def canLaunchAgentDoor(s: OnboardingState): bool =
  not(s.signedIn) and s.joinSheetOpen
    and (s.stepKind == StepChooseDoor or s.stepKind == StepAgentPromptCopied)

pure def launchAgentDoor(s: OnboardingState, host: AgentHost): OnboardingState =
  {
    ...s,
    door: DoorAgent,
    stepKind: StepAgentPromptCopied,
    selectedHost: host,
    skillPromptCopied: true,
  }

pure def canProceedToPhoneFromAgent(s: OnboardingState): bool =
  not(s.signedIn) and s.joinSheetOpen and s.stepKind == StepAgentPromptCopied

pure def proceedToPhoneFromAgent(s: OnboardingState): OnboardingState =
  { ...s, door: DoorPhone, stepKind: StepChooseDoor }
```

### Reviewer sign-in link allows password auth strictly for operator-flagged reviewer accounts

```quint
pure def canOpenReviewerDoor(s: OnboardingState): bool =
  not(s.signedIn) and s.joinSheetOpen and s.stepKind == StepChooseDoor

pure def openReviewerDoor(s: OnboardingState): OnboardingState =
  { ...s, door: DoorReviewer, stepKind: StepReviewerLogin }

pure def canSubmitReviewerSignIn(
  s: OnboardingState,
  isReviewerAccount: bool,
  passwordValid: bool
): bool =
  not(s.signedIn) and s.joinSheetOpen and s.door == DoorReviewer
    and s.stepKind == StepReviewerLogin
    and isReviewerAccount and passwordValid

pure def submitReviewerSignIn(
  s: OnboardingState,
  isReviewerAccount: bool,
  passwordValid: bool
): OnboardingState =
  {
    ...s,
    signedIn: true,
    isReviewer: true,
    joinSheetOpen: false,
    stepKind: StepSignedIn,
    pendingAction: noPendingAction,
    completedActions: completeQueuedIfPresent(s.completedActions, s.pendingAction),
  }

pure def canSignOutOnboarding(s: OnboardingState): bool = s.signedIn

pure def signOutOnboarding(s: OnboardingState): OnboardingState =
  {
    ...s,
    signedIn: false,
    isReviewer: false,
    joinSheetOpen: false,
    door: DoorNone,
    stepKind: StepClosed,
    pendingAction: noPendingAction,
  }
```

### Onboarding invariants and reachability checks

```quint
pure def alwaysSignedInClearsPendingAndClosesSheet(s: OnboardingState): bool =
  s.signedIn implies (
    not(s.joinSheetOpen)
      and s.pendingAction.actionKind == GatedNone
      and s.pendingAction.targetId == 0
  )

pure def alwaysStartingGrantAtMostOnce(s: OnboardingState): bool = and {
  not(s.startingGrantAwarded) implies s.pointsBalance == 0,
  s.pointsBalance == 0 or s.pointsBalance == 100,
  s.startingGrantAwarded implies (s.pointsBalance == 100 and s.ageConfirmed),
  s.stepKind == StepCompleteProfile implies not(s.startingGrantAwarded),
  s.codeResendCount >= 0,
}

pure def alwaysCompletedActionsValid(s: OnboardingState): bool =
  s.completedActions.every(a => a.actionKind != GatedNone and a.targetId > 0)

pure def stepPendingActionAutoCompletesOnSignIn(
  before: OnboardingState,
  after: OnboardingState
): bool =
  (not(before.signedIn) and after.signedIn and before.pendingAction.actionKind != GatedNone) implies (
    after.completedActions == before.completedActions.append(before.pendingAction)
      and after.pendingAction.actionKind == GatedNone
  )

pure def stepExplainerNeverReappears(before: OnboardingState, after: OnboardingState): bool =
  not(before.explainerCardVisible) implies not(after.explainerCardVisible)

pure def sometimesPendingActionAutoCompleted(s: OnboardingState): bool =
  s.signedIn and s.completedActions.length() >= 1 and s.startingGrantAwarded

pure def sometimesAgentDoorUsed(s: OnboardingState): bool =
  s.skillPromptCopied

pure def sometimesReviewerSignedIn(s: OnboardingState): bool =
  s.isReviewer and s.signedIn
