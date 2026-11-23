# Single-agent authorization grant

Feed allows **at most one active connected agent grant per account** (`activeGrantCount <= 1`; PRD v0.4 §0.2). Multi-agent teams, shared agent chats, and concurrent external grants are omitted. Connecting a new OAuth 2.1 or RFC 8628 Device Flow client atomically revokes any prior active grant and records every client action with `viaClientName` attribution (D-6).

## Story: Connect at most one agent per account with clear attribution

> As a Feed player, I want at most one AI client authorized on my account at a time and every action labeled with which client took it, so that connecting a new agent replaces the previous one immediately and no revoked agent can keep acting.

### An account holds at most one active grant over four toggleable scopes

An account's grant slot starts empty (`GrantNone`) and holds at most one active grant (`GrantActive`) binding `grantId`, `clientName`, a subset of the four MVP scopes (`read`, `social:write`, `messages`, `trade`), `connectedAt`, and `lastUsedAt`. At least one scope must be enabled for an active grant.

```quint
type Millis = int

type Scope = ScopeRead | ScopeSocialWrite | ScopeMessages | ScopeTrade

type ScopeSet = {
  read: bool,
  socialWrite: bool,
  messages: bool,
  trade: bool,
}

type AgentGrantRecord = {
  grantId: str,
  clientName: str,
  scopes: ScopeSet,
  connectedAt: Millis,
  lastUsedAt: Millis,
}

type OptionAgentGrant =
  | GrantNone
  | GrantActive(AgentGrantRecord)

type AttributionRecord = {
  hasAction: bool,
  viaClientName: str,
  actionGrantId: str,
}

type AgentGrantEffect =
  | GrantRevoked({ accountId: str, revokedGrantId: str })
  | GrantInstalled({ accountId: str, installedGrantId: str, installedClientName: str })
  | ActionAttributed({ accountId: str, usedGrantId: str, viaClientName: str })

type AccountAgentSlot = {
  accountId: str,
  activeGrant: OptionAgentGrant,
  activeGrantCount: int,
  historyRevokedIds: List[str],
  lastAttribution: AttributionRecord,
  now: Millis,
}

type AgentSlotStep = {
  state: AccountAgentSlot,
  out: List[AgentGrantEffect],
}

pure val allScopes: ScopeSet = { read: true, socialWrite: true, messages: true, trade: true }
pure val readOnlyScopes: ScopeSet = { read: true, socialWrite: false, messages: false, trade: false }
pure val socialOnlyScopes: ScopeSet = { read: true, socialWrite: true, messages: false, trade: false }
pure val messagingScopes: ScopeSet = { read: true, socialWrite: false, messages: true, trade: false }
pure val tradingScopes: ScopeSet = { read: true, socialWrite: false, messages: false, trade: true }
pure val emptyScopes: ScopeSet = { read: false, socialWrite: false, messages: false, trade: false }

pure def hasScope(scopes: ScopeSet, scope: Scope): bool =
  if (scope == ScopeRead) scopes.read
  else if (scope == ScopeSocialWrite) scopes.socialWrite
  else if (scope == ScopeMessages) scopes.messages
  else scopes.trade

pure def hasAnyScope(scopes: ScopeSet): bool =
  scopes.read or scopes.socialWrite or scopes.messages or scopes.trade

pure def grantIdOf(ag: OptionAgentGrant): str =
  match ag {
    | GrantNone => ""
    | GrantActive(g) => g.grantId
  }

pure def grantClientOf(ag: OptionAgentGrant): str =
  match ag {
    | GrantNone => ""
    | GrantActive(g) => g.clientName
  }

pure def grantScopesOf(ag: OptionAgentGrant): ScopeSet =
  match ag {
    | GrantNone => emptyScopes
    | GrantActive(g) => g.scopes
  }

pure def grantConnectedAtOf(ag: OptionAgentGrant): Millis =
  match ag {
    | GrantNone => 0
    | GrantActive(g) => g.connectedAt
  }

pure def grantLastUsedAtOf(ag: OptionAgentGrant): Millis =
  match ag {
    | GrantNone => 0
    | GrantActive(g) => g.lastUsedAt
  }

pure def viaClientNameFor(s: AccountAgentSlot, grantId: str): str =
  val ag = s.activeGrant
  match ag {
    | GrantNone => ""
    | GrantActive(g) => if (g.grantId == grantId and not(s.historyRevokedIds.includes(grantId))) g.clientName else ""
  }

pure val initial: AccountAgentSlot = {
  accountId: "",
  activeGrant: GrantNone,
  activeGrantCount: 0,
  historyRevokedIds: List(),
  lastAttribution: { hasAction: false, viaClientName: "", actionGrantId: "" },
  now: 0,
}
```

### Connecting a new agent atomically revokes any prior active grant

When `connectAgent` authorizes a fresh `grantId` for the account, any existing `GrantActive` grant is revoked in the same transition, its ID is appended permanently to `historyRevokedIds`, `GrantRevoked` is emitted before `GrantInstalled`, and `activeGrantCount` remains `1`.

```quint
pure def canConnectAgent(s: AccountAgentSlot, accountId: str, grantId: str, clientName: str, scopes: ScopeSet): bool =
  accountId != ""
    and (s.accountId == "" or s.accountId == accountId)
    and grantId != ""
    and clientName != ""
    and hasAnyScope(scopes)
    and not(s.historyRevokedIds.includes(grantId))
    and grantId != grantIdOf(s.activeGrant)

pure def connectAgent(s: AccountAgentSlot, accountId: str, grantId: str, clientName: str, scopes: ScopeSet): AgentSlotStep =
  val prior = s.activeGrant
  val revokedIds = match prior {
    | GrantNone => s.historyRevokedIds
    | GrantActive(g) => s.historyRevokedIds.append(g.grantId)
  }
  val installed = GrantActive({
    grantId: grantId,
    clientName: clientName,
    scopes: scopes,
    connectedAt: s.now,
    lastUsedAt: s.now,
  })
  val effects = match prior {
    | GrantNone => List(GrantInstalled({ accountId: accountId, installedGrantId: grantId, installedClientName: clientName }))
    | GrantActive(g) => List(
        GrantRevoked({ accountId: accountId, revokedGrantId: g.grantId }),
        GrantInstalled({ accountId: accountId, installedGrantId: grantId, installedClientName: clientName })
      )
  }
  {
    state: {
      ...s,
      accountId: accountId,
      activeGrant: installed,
      activeGrantCount: 1,
      historyRevokedIds: revokedIds,
    },
    out: effects,
  }
```

### Revoking an active grant clears the slot and records its ID permanently

Users can inspect and revoke their active grant from Settings → Connected agents. Revoking clears `activeGrant` to `GrantNone`, sets `activeGrantCount` to `0`, and permanently appends `grantId` to `historyRevokedIds`.

```quint
pure def canRevokeAgent(s: AccountAgentSlot, accountId: str, grantId: str): bool =
  s.accountId != ""
    and s.accountId == accountId
    and grantId != ""
    and grantIdOf(s.activeGrant) == grantId

pure def revokeAgent(s: AccountAgentSlot, accountId: str, grantId: str): AgentSlotStep =
  {
    state: {
      ...s,
      activeGrant: GrantNone,
      activeGrantCount: 0,
      historyRevokedIds: s.historyRevokedIds.append(grantId),
    },
    out: List(GrantRevoked({ accountId: accountId, revokedGrantId: grantId })),
  }
```

### Agent actions require the currently active grant and return client attribution

`recordAgentAction` succeeds only when `grantId` and `clientName` match the account's currently active, unrevoked grant. It advances `lastUsedAt` and records `viaClientName` for UI badges ("via Claude") and the audit log. Advancing time updates `now` monotonically.

```quint
pure def canRecordAgentAction(s: AccountAgentSlot, accountId: str, grantId: str, clientName: str): bool =
  s.accountId != ""
    and s.accountId == accountId
    and grantId != ""
    and clientName != ""
    and grantIdOf(s.activeGrant) == grantId
    and grantClientOf(s.activeGrant) == clientName
    and not(s.historyRevokedIds.includes(grantId))

pure def recordAgentAction(s: AccountAgentSlot, accountId: str, grantId: str, clientName: str): AgentSlotStep =
  val prior = s.activeGrant
  val updated = match prior {
    | GrantNone => GrantNone
    | GrantActive(g) => GrantActive({ ...g, lastUsedAt: s.now })
  }
  {
    state: {
      ...s,
      activeGrant: updated,
      lastAttribution: { hasAction: true, viaClientName: clientName, actionGrantId: grantId },
    },
    out: List(ActionAttributed({ accountId: accountId, usedGrantId: grantId, viaClientName: clientName })),
  }

pure def canElapse(s: AccountAgentSlot, elapsed: Millis): bool =
  elapsed > 0

pure def elapse(s: AccountAgentSlot, elapsed: Millis): AgentSlotStep =
  { state: { ...s, now: s.now + elapsed }, out: List() }
```

### An account never holds more than one active grant and revoked grants never authorize actions

`alwaysSingleActiveGrant` proves inductively that `activeGrantCount` stays within `0..1`, matches `activeGrant`, and never overlaps `historyRevokedIds`. `lawRevokedGrantCannotAuthorizeAction` guarantees that any grant ID in `historyRevokedIds` is refused by `canRecordAgentAction`.

```quint
pure def alwaysSingleActiveGrant(s: AccountAgentSlot): bool =
  s.now >= 0
    and 0 <= s.activeGrantCount
    and s.activeGrantCount <= 1
    and ((s.activeGrant == GrantNone) iff (s.activeGrantCount == 0))
    and (s.accountId == "" implies s.activeGrant == GrantNone)
    and (s.activeGrant != GrantNone implies (
      s.accountId != ""
        and grantIdOf(s.activeGrant) != ""
        and grantClientOf(s.activeGrant) != ""
        and hasAnyScope(grantScopesOf(s.activeGrant))
        and not(s.historyRevokedIds.includes(grantIdOf(s.activeGrant)))
        and 0 <= grantConnectedAtOf(s.activeGrant)
        and grantConnectedAtOf(s.activeGrant) <= grantLastUsedAtOf(s.activeGrant)
        and grantLastUsedAtOf(s.activeGrant) <= s.now
    ))
    and s.historyRevokedIds.every(id => id != "" and id != grantIdOf(s.activeGrant))

pure def alwaysAttributionIsNamed(s: AccountAgentSlot): bool =
  s.lastAttribution.hasAction implies (s.lastAttribution.viaClientName != "" and s.lastAttribution.actionGrantId != "")

pure def stepRevokedNeverRecovers(before: AccountAgentSlot, via: str, after: AccountAgentSlot, out: List[AgentGrantEffect]): bool =
  before.historyRevokedIds.every(id => after.historyRevokedIds.includes(id))
    and (before.accountId != "" implies after.accountId == before.accountId)
    and (via == "recordAgentAction" implies (
      before.activeGrant != GrantNone
        and not(before.historyRevokedIds.includes(grantIdOf(before.activeGrant)))
        and after.lastAttribution == {
          hasAction: true,
          viaClientName: grantClientOf(before.activeGrant),
          actionGrantId: grantIdOf(before.activeGrant),
        }
        and out == List(ActionAttributed({
          accountId: before.accountId,
          usedGrantId: grantIdOf(before.activeGrant),
          viaClientName: grantClientOf(before.activeGrant),
        }))
    ))

pure def stepAtomicReplacementRevokesPrior(before: AccountAgentSlot, via: str, after: AccountAgentSlot, out: List[AgentGrantEffect]): bool =
  (via == "connectAgent" and before.activeGrant != GrantNone) implies (
    after.historyRevokedIds.includes(grantIdOf(before.activeGrant))
      and after.activeGrantCount == 1
      and out == List(
        GrantRevoked({ accountId: before.accountId, revokedGrantId: grantIdOf(before.activeGrant) }),
        GrantInstalled({
          accountId: after.accountId,
          installedGrantId: grantIdOf(after.activeGrant),
          installedClientName: grantClientOf(after.activeGrant),
        })
      )
  )

pure def lawRevokedGrantCannotAuthorizeAction(s: AccountAgentSlot, accountId: str, grantId: str, clientName: str): bool =
  (alwaysSingleActiveGrant(s) and s.historyRevokedIds.includes(grantId)) implies
    not(canRecordAgentAction(s, accountId, grantId, clientName))

pure def sometimesActiveAgent(s: AccountAgentSlot): bool =
  s.activeGrantCount == 1

pure def sometimesReplacedAgent(s: AccountAgentSlot): bool =
  s.activeGrantCount == 1 and s.historyRevokedIds.length() >= 1 and s.lastAttribution.hasAction

pure def sometimesRevokedToNone(s: AccountAgentSlot): bool =
  s.activeGrantCount == 0 and s.historyRevokedIds.length() >= 1
```

### Simulation samples and witness journeys cover connection, replacement, attribution, and revocation

```quint
pure val accountIdValues: Set[str] = Set("acct-1", "acct-2")
pure val grantIdValues: Set[str] = Set("grant-1", "grant-2", "grant-3")
pure val clientNameValues: Set[str] = Set("Claude", "ChatGPT", "Hermes")
pure val scopesValues: Set[ScopeSet] = Set(allScopes, readOnlyScopes, socialOnlyScopes, emptyScopes)
pure val elapsedValues: Set[Millis] = Set(1000, 60000)

pure val eval_witness_sometimesReplacedAgent = (
  ("connectAgent", "acct-1", "grant-1", "Claude", allScopes),
  ("elapse", 1000),
  ("connectAgent", "acct-1", "grant-2", "ChatGPT", socialOnlyScopes),
  ("recordAgentAction", "acct-1", "grant-2", "ChatGPT")
)

pure val eval_witness_sometimesRevokedToNone = (
  ("connectAgent", "acct-1", "grant-1", "Claude", allScopes),
  ("revokeAgent", "acct-1", "grant-1")
)
```
