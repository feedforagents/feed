# OAuth 2.1 authorization server and RFC 8628 device flow

Feed acts as its own **first-party OAuth 2.1 authorization server** on `https://feed.fun` (`issuer = https://feed.fun`, RFC 8414 AS metadata, RFC 9728 protected-resource metadata, RFC 9207 `iss`). Clients onboard via CIMD or DCR (RFC 7591), must use PKCE `S256` with normalized RFC 8707 `resource` indicators, and install grants into the account's single active agent slot ([`agentGrant`](./agentGrant.md)), atomically replacing any prior connected client.

## Story: Authorize one MCP client over OAuth 2.1 or Device Flow and rotate tokens safely

> As a Feed player connecting ChatGPT, Claude, Hermes, or OpenClaw, I want standard OAuth 2.1 with PKCE and one consent screen (or `/link` device authorization on headless machines) that replaces any prior agent grant and immediately revokes stolen refresh tokens on reuse.

### Clients register via CIMD or DCR for hosted callbacks or RFC 8252 loopback redirects only

```quint
import agentGrant as AG from "./agentGrant"

type RegistrationKind = ClientCimd | ClientDcr

type RedirectKind = RedirectHostedCallback | RedirectLoopback | RedirectOther

type TokenEndpointAuthMethod = AuthMethodNone | AuthMethodSecret

type PkceMethod = PkceS256 | PkcePlain | PkceNone

type ResponseMode = CodeFlow | ImplicitToken

type AuthRequestPhase = AuthIdle | AuthPendingConsent | AuthCodeIssued

type TokenFamilyStatus = FamilyNone | FamilyActive | FamilyRevoked | FamilyReused

type DeviceAuthStatus = DeviceIdle | DevicePending | DeviceApproved | DeviceConsumed

type OAuthRefusal =
  | RefusalNone
  | RefusalInvalidClient
  | RefusalRedirectMismatch
  | RefusalPkceRequired
  | RefusalImplicitForbidden
  | RefusalInvalidResource
  | RefusalStateRequired
  | RefusalGrantExpired
  | RefusalReuseDetected

type ClientRegistration = {
  regClientId: str,
  regClientName: str,
  regKind: RegistrationKind,
  regRedirectKind: RedirectKind,
  regAuthMethod: TokenEndpointAuthMethod,
}

type AuthRequest = {
  authPhase: AuthRequestPhase,
  reqClientId: str,
  reqClientName: str,
  reqRedirectKind: RedirectKind,
  reqPkceMethod: PkceMethod,
  reqResponseMode: ResponseMode,
  reqResource: str,
  reqStateLen: int,
  authAccountId: str,
  authCode: str,
  authGrantedScopes: AG::ScopeSet,
  authCodeExpiresAt: AG::Millis,
}

type TokenFamily = {
  familyGrantId: str,
  familyAccountId: str,
  familyClientId: str,
  familyClientName: str,
  familyStatus: TokenFamilyStatus,
  generation: int,
  audience: str,
  familyScopes: AG::ScopeSet,
  pkceVerified: bool,
  authAt: AG::Millis,
  issuedAt: AG::Millis,
  accessExpiresAt: AG::Millis,
  grantExpiresAt: AG::Millis,
}

type DeviceAuth = {
  deviceStatus: DeviceAuthStatus,
  deviceCode: str,
  userCode: str,
  verificationUri: str,
  deviceClientId: str,
  deviceClientName: str,
  deviceResource: str,
  deviceAccountId: str,
  deviceScopes: AG::ScopeSet,
  deviceExpiresAt: AG::Millis,
}

type OAuthEffect =
  | IssuerCodeIssued({ issuerUrl: str, preservedStateLen: int })
  | TokensIssued({ tokenGrantId: str, tokenAudience: str, tokenGeneration: int, accessExp: AG::Millis, grantExp: AG::Millis })
  | RefreshReuseRevokedGrant({ compromisedGrantId: str, replayedGeneration: int })
  | DeviceFlowApproved({ approvedUserCode: str, approvedAccountId: str })

type OAuthState = {
  registeredClients: List[ClientRegistration],
  pendingAuth: AuthRequest,
  deviceAuth: DeviceAuth,
  tokenFamily: TokenFamily,
  agentSlot: AG::AccountAgentSlot,
  lastRefusal: OAuthRefusal,
  now: AG::Millis,
}

type OAuthStep = {
  state: OAuthState,
  out: List[OAuthEffect],
}

pure val canonicalIssuer: str = "https://feed.fun"
pure val canonicalMcpResource: str = "https://feed.fun/mcp"
pure val canonicalDeviceUri: str = "https://feed.fun/link"
pure val authCodeLifetimeMs: AG::Millis = 300000
pure val deviceCodeLifetimeMs: AG::Millis = 600000
pure val accessTokenLifetimeMs: AG::Millis = 900000
pure val maxGrantLifetimeMs: AG::Millis = 7776000000

pure val noClient: ClientRegistration = {
  regClientId: "",
  regClientName: "",
  regKind: ClientDcr,
  regRedirectKind: RedirectOther,
  regAuthMethod: AuthMethodSecret,
}

pure val idleAuth: AuthRequest = {
  authPhase: AuthIdle,
  reqClientId: "",
  reqClientName: "",
  reqRedirectKind: RedirectOther,
  reqPkceMethod: PkceNone,
  reqResponseMode: ImplicitToken,
  reqResource: "",
  reqStateLen: 0,
  authAccountId: "",
  authCode: "",
  authGrantedScopes: AG::emptyScopes,
  authCodeExpiresAt: 0,
}

pure val idleDeviceAuth: DeviceAuth = {
  deviceStatus: DeviceIdle,
  deviceCode: "",
  userCode: "",
  verificationUri: "",
  deviceClientId: "",
  deviceClientName: "",
  deviceResource: "",
  deviceAccountId: "",
  deviceScopes: AG::emptyScopes,
  deviceExpiresAt: 0,
}

pure val emptyFamily: TokenFamily = {
  familyGrantId: "",
  familyAccountId: "",
  familyClientId: "",
  familyClientName: "",
  familyStatus: FamilyNone,
  generation: 0,
  audience: "",
  familyScopes: AG::emptyScopes,
  pkceVerified: false,
  authAt: 0,
  issuedAt: 0,
  accessExpiresAt: 0,
  grantExpiresAt: 0,
}

pure val initial: OAuthState = {
  registeredClients: List(),
  pendingAuth: idleAuth,
  deviceAuth: idleDeviceAuth,
  tokenFamily: emptyFamily,
  agentSlot: AG::initial,
  lastRefusal: RefusalNone,
  now: 0,
}

pure def redirectAllowed(redirectKind: RedirectKind): bool =
  redirectKind == RedirectHostedCallback or redirectKind == RedirectLoopback

pure def normalizeResource(rawResource: str): str =
  if (rawResource == "https://feed.fun/mcp/") canonicalMcpResource else rawResource

pure def resourceAllowed(rawResource: str): bool =
  normalizeResource(rawResource) == canonicalMcpResource

pure def findClient(clients: List[ClientRegistration], clientId: str): ClientRegistration =
  clients.foldl(noClient, (acc, c) => if (c.regClientId == clientId) c else acc)

pure def canRegisterClient(
  s: OAuthState,
  clientId: str,
  clientName: str,
  regKind: RegistrationKind,
  redirectKind: RedirectKind,
  authMethod: TokenEndpointAuthMethod
): bool =
  clientId != ""
    and clientName != ""
    and redirectAllowed(redirectKind)
    and authMethod == AuthMethodNone
    and findClient(s.registeredClients, clientId).regClientId == ""

pure def registerClient(
  s: OAuthState,
  clientId: str,
  clientName: str,
  regKind: RegistrationKind,
  redirectKind: RedirectKind,
  authMethod: TokenEndpointAuthMethod
): OAuthStep =
  {
    state: {
      ...s,
      registeredClients: s.registeredClients.append({
        regClientId: clientId,
        regClientName: clientName,
        regKind: regKind,
        regRedirectKind: redirectKind,
        regAuthMethod: authMethod,
      }),
      lastRefusal: RefusalNone,
    },
    out: List(),
  }
```

### Authorization requires PKCE S256, code flow, normalized resource, and preserves 400+ character state across one 4-scope consent screen

The server requires PKCE with S256 and the authorization code flow. One
consent screen shows all four scopes (`read`, `social:write`, `messages`,
`trade`) enabled by default. A phone-verified user can toggle scopes and
must leave at least one enabled to approve consent.

```quint
pure def canStartAuthorization(
  s: OAuthState,
  clientId: str,
  redirectKind: RedirectKind,
  pkceMethod: PkceMethod,
  responseMode: ResponseMode,
  rawResource: str,
  stateLen: int
): bool =
  val client = findClient(s.registeredClients, clientId)
  client.regClientId != ""
    and client.regRedirectKind == redirectKind
    and redirectAllowed(redirectKind)
    and client.regAuthMethod == AuthMethodNone
    and pkceMethod == PkceS256
    and responseMode == CodeFlow
    and resourceAllowed(rawResource)
    and stateLen >= 1

pure def startAuthorization(
  s: OAuthState,
  clientId: str,
  redirectKind: RedirectKind,
  pkceMethod: PkceMethod,
  responseMode: ResponseMode,
  rawResource: str,
  stateLen: int
): OAuthStep =
  val client = findClient(s.registeredClients, clientId)
  {
    state: {
      ...s,
      pendingAuth: {
        ...idleAuth,
        authPhase: AuthPendingConsent,
        reqClientId: client.regClientId,
        reqClientName: client.regClientName,
        reqRedirectKind: redirectKind,
        reqPkceMethod: pkceMethod,
        reqResponseMode: responseMode,
        reqResource: normalizeResource(rawResource),
        reqStateLen: stateLen,
      },
      lastRefusal: RefusalNone,
    },
    out: List(),
  }

pure def canApproveConsent(
  s: OAuthState,
  accountId: str,
  accountPhoneVerified: bool,
  approvedScopes: AG::ScopeSet,
  authCode: str
): bool =
  s.pendingAuth.authPhase == AuthPendingConsent
    and accountId != ""
    and accountPhoneVerified
    and (s.agentSlot.accountId == "" or s.agentSlot.accountId == accountId)
    and AG::hasAnyScope(approvedScopes)
    and authCode != ""

pure def approveConsent(
  s: OAuthState,
  accountId: str,
  accountPhoneVerified: bool,
  approvedScopes: AG::ScopeSet,
  authCode: str
): OAuthStep =
  val p = s.pendingAuth
  {
    state: {
      ...s,
      pendingAuth: {
        ...p,
        authPhase: AuthCodeIssued,
        authAccountId: accountId,
        authCode: authCode,
        authGrantedScopes: approvedScopes,
        authCodeExpiresAt: s.now + authCodeLifetimeMs,
      },
      lastRefusal: RefusalNone,
    },
    out: List(IssuerCodeIssued({ issuerUrl: canonicalIssuer, preservedStateLen: p.reqStateLen })),
  }

pure def canExchangeAuthCode(
  s: OAuthState,
  authCode: str,
  clientId: str,
  redirectKind: RedirectKind,
  rawResource: str,
  verifierMatches: bool,
  grantId: str
): bool =
  s.pendingAuth.authPhase == AuthCodeIssued
    and s.now < s.pendingAuth.authCodeExpiresAt
    and authCode == s.pendingAuth.authCode
    and clientId == s.pendingAuth.reqClientId
    and redirectKind == s.pendingAuth.reqRedirectKind
    and normalizeResource(rawResource) == s.pendingAuth.reqResource
    and verifierMatches
    and AG::canConnectAgent(
      s.agentSlot,
      s.pendingAuth.authAccountId,
      grantId,
      s.pendingAuth.reqClientName,
      s.pendingAuth.authGrantedScopes
    )

pure def installGrantFamily(
  s: OAuthState,
  accountId: str,
  clientId: str,
  clientName: str,
  scopes: AG::ScopeSet,
  audience: str,
  pkceVerified: bool,
  grantId: str
): TokenFamily = {
  familyGrantId: grantId,
  familyAccountId: accountId,
  familyClientId: clientId,
  familyClientName: clientName,
  familyStatus: FamilyActive,
  generation: 1,
  audience: audience,
  familyScopes: scopes,
  pkceVerified: pkceVerified,
  authAt: s.now,
  issuedAt: s.now,
  accessExpiresAt: s.now + accessTokenLifetimeMs,
  grantExpiresAt: s.now + maxGrantLifetimeMs,
}

pure def exchangeAuthCode(
  s: OAuthState,
  authCode: str,
  clientId: str,
  redirectKind: RedirectKind,
  rawResource: str,
  verifierMatches: bool,
  grantId: str
): OAuthStep =
  val p = s.pendingAuth
  val slotStep = AG::connectAgent(s.agentSlot, p.authAccountId, grantId, p.reqClientName, p.authGrantedScopes)
  val family = installGrantFamily(s, p.authAccountId, p.reqClientId, p.reqClientName, p.authGrantedScopes, p.reqResource, true, grantId)
  {
    state: {
      ...s,
      pendingAuth: idleAuth,
      tokenFamily: family,
      agentSlot: slotStep.state,
      lastRefusal: RefusalNone,
    },
    out: List(TokensIssued({
      tokenGrantId: grantId,
      tokenAudience: p.reqResource,
      tokenGeneration: 1,
      accessExp: family.accessExpiresAt,
      grantExp: family.grantExpiresAt,
    })),
  }
```

### Rotating refresh tokens cap grants at 90 days and revoke the entire grant family on reuse

Presenting the current refresh generation issues a new 15-minute access token (capped at the 90-day grant expiry) and advances `generation`. Replaying any earlier generation immediately marks the family `FamilyReused` and revokes the active agent grant.

```quint
pure def isRefreshReuse(f: TokenFamily, refreshGrantId: str, presentedGen: int, now: AG::Millis): bool =
  refreshGrantId == f.familyGrantId
    and (f.familyStatus == FamilyActive or f.familyStatus == FamilyRevoked)
    and 1 <= presentedGen
    and presentedGen < f.generation
    and now < f.grantExpiresAt

pure def isValidRefreshRotation(s: OAuthState, refreshGrantId: str, presentedGen: int): bool =
  s.tokenFamily.familyStatus == FamilyActive
    and refreshGrantId == s.tokenFamily.familyGrantId
    and presentedGen == s.tokenFamily.generation
    and s.now < s.tokenFamily.grantExpiresAt
    and AG::grantIdOf(s.agentSlot.activeGrant) == refreshGrantId

pure def canRefreshOAuthToken(s: OAuthState, refreshGrantId: str, presentedGen: int): bool =
  isRefreshReuse(s.tokenFamily, refreshGrantId, presentedGen, s.now)
    or isValidRefreshRotation(s, refreshGrantId, presentedGen)

pure def handleRefreshReuse(refreshGrantId: str, presentedGen: int, s: OAuthState): OAuthStep = {
  val f = s.tokenFamily
  val slotAfter =
    if (AG::grantIdOf(s.agentSlot.activeGrant) == refreshGrantId)
      AG::revokeAgent(s.agentSlot, s.agentSlot.accountId, refreshGrantId).state
    else s.agentSlot
  {
    state: {
      ...s,
      tokenFamily: { ...f, familyStatus: FamilyReused },
      agentSlot: slotAfter,
      lastRefusal: RefusalReuseDetected,
    },
    out: List(RefreshReuseRevokedGrant({ compromisedGrantId: refreshGrantId, replayedGeneration: presentedGen })),
  }
}

pure def rotateRefreshFamily(f: TokenFamily, s: OAuthState): OAuthStep = {
  val nextGen = f.generation + 1
  val rawAccessExp = s.now + accessTokenLifetimeMs
  val cappedAccessExp = if (rawAccessExp < f.grantExpiresAt) rawAccessExp else f.grantExpiresAt
  {
    state: {
      ...s,
      tokenFamily: {
        ...f,
        generation: nextGen,
        issuedAt: s.now,
        accessExpiresAt: cappedAccessExp,
      },
      lastRefusal: RefusalNone,
    },
    out: List(TokensIssued({
      tokenGrantId: f.familyGrantId,
      tokenAudience: f.audience,
      tokenGeneration: nextGen,
      accessExp: cappedAccessExp,
      grantExp: f.grantExpiresAt,
    })),
  }
}

pure def refreshOAuthToken(s: OAuthState, refreshGrantId: str, presentedGen: int): OAuthStep =
  if (isRefreshReuse(s.tokenFamily, refreshGrantId, presentedGen, s.now))
    handleRefreshReuse(refreshGrantId, presentedGen, s)
  else
    rotateRefreshFamily(s.tokenFamily, s)

pure def canRevokeOAuthGrant(s: OAuthState, accountId: str, grantId: str): bool =
  AG::canRevokeAgent(s.agentSlot, accountId, grantId)

pure def revokeOAuthGrant(s: OAuthState, accountId: str, grantId: str): OAuthStep =
  val slotStep = AG::revokeAgent(s.agentSlot, accountId, grantId)
  val nextFamily =
    if (s.tokenFamily.familyGrantId == grantId and s.tokenFamily.familyStatus == FamilyActive)
      { ...s.tokenFamily, familyStatus: FamilyRevoked }
    else s.tokenFamily
  {
    state: {
      ...s,
      agentSlot: slotStep.state,
      tokenFamily: nextFamily,
      lastRefusal: RefusalNone,
    },
    out: List(),
  }
```

## Story: Authorize headless agents through RFC 8628 device flow at `/link`

> As a player running a headless or remote agent, I want my agent to give me a short code for `feed.fun/link` so I can verify my phone on any browser and atomically switch my account's active grant to that agent.

### Exchanging an approved device code issues tokens and atomically replaces any prior connected agent

```quint
pure def canStartDeviceFlow(
  s: OAuthState,
  clientId: str,
  rawResource: str,
  requestedScopes: AG::ScopeSet,
  deviceCode: str,
  userCode: str
): bool =
  val client = findClient(s.registeredClients, clientId)
  client.regClientId != ""
    and client.regAuthMethod == AuthMethodNone
    and resourceAllowed(rawResource)
    and AG::hasAnyScope(requestedScopes)
    and deviceCode != ""
    and userCode != ""

pure def startDeviceFlow(
  s: OAuthState,
  clientId: str,
  rawResource: str,
  requestedScopes: AG::ScopeSet,
  deviceCode: str,
  userCode: str
): OAuthStep =
  val client = findClient(s.registeredClients, clientId)
  {
    state: {
      ...s,
      deviceAuth: {
        deviceStatus: DevicePending,
        deviceCode: deviceCode,
        userCode: userCode,
        verificationUri: canonicalDeviceUri,
        deviceClientId: client.regClientId,
        deviceClientName: client.regClientName,
        deviceResource: normalizeResource(rawResource),
        deviceAccountId: "",
        deviceScopes: requestedScopes,
        deviceExpiresAt: s.now + deviceCodeLifetimeMs,
      },
      lastRefusal: RefusalNone,
    },
    out: List(),
  }

pure def canApproveDeviceFlow(
  s: OAuthState,
  userCode: str,
  accountId: str,
  accountPhoneVerified: bool,
  approvedScopes: AG::ScopeSet
): bool =
  s.deviceAuth.deviceStatus == DevicePending
    and s.now < s.deviceAuth.deviceExpiresAt
    and userCode == s.deviceAuth.userCode
    and accountId != ""
    and accountPhoneVerified
    and (s.agentSlot.accountId == "" or s.agentSlot.accountId == accountId)
    and AG::hasAnyScope(approvedScopes)

pure def approveDeviceFlow(
  s: OAuthState,
  userCode: str,
  accountId: str,
  accountPhoneVerified: bool,
  approvedScopes: AG::ScopeSet
): OAuthStep =
  {
    state: {
      ...s,
      deviceAuth: {
        ...s.deviceAuth,
        deviceStatus: DeviceApproved,
        deviceAccountId: accountId,
        deviceScopes: approvedScopes,
      },
      lastRefusal: RefusalNone,
    },
    out: List(DeviceFlowApproved({ approvedUserCode: userCode, approvedAccountId: accountId })),
  }

pure def canExchangeDeviceCode(s: OAuthState, deviceCode: str, clientId: str, grantId: str): bool =
  s.deviceAuth.deviceStatus == DeviceApproved
    and s.now < s.deviceAuth.deviceExpiresAt
    and deviceCode == s.deviceAuth.deviceCode
    and clientId == s.deviceAuth.deviceClientId
    and AG::canConnectAgent(
      s.agentSlot,
      s.deviceAuth.deviceAccountId,
      grantId,
      s.deviceAuth.deviceClientName,
      s.deviceAuth.deviceScopes
    )

pure def exchangeDeviceCode(s: OAuthState, deviceCode: str, clientId: str, grantId: str): OAuthStep =
  val d = s.deviceAuth
  val slotStep = AG::connectAgent(s.agentSlot, d.deviceAccountId, grantId, d.deviceClientName, d.deviceScopes)
  val family = installGrantFamily(s, d.deviceAccountId, d.deviceClientId, d.deviceClientName, d.deviceScopes, d.deviceResource, false, grantId)
  {
    state: {
      ...s,
      deviceAuth: { ...d, deviceStatus: DeviceConsumed },
      tokenFamily: family,
      agentSlot: slotStep.state,
      lastRefusal: RefusalNone,
    },
    out: List(TokensIssued({
      tokenGrantId: grantId,
      tokenAudience: d.deviceResource,
      tokenGeneration: 1,
      accessExp: family.accessExpiresAt,
      grantExp: family.grantExpiresAt,
    })),
  }

pure def canElapse(s: OAuthState, elapsed: AG::Millis): bool =
  elapsed > 0

pure def elapse(s: OAuthState, elapsed: AG::Millis): OAuthStep =
  {
    state: {
      ...s,
      now: s.now + elapsed,
      agentSlot: AG::elapse(s.agentSlot, elapsed).state,
    },
    out: List(),
  }
```

Approval attempts against the device flow are budgeted per account. A signed-in account may make at most 20 approval attempts per clock hour. An attempt is counted before the user code is looked up, so successful, denied, wrong-code and expired-code attempts all count; a request with an empty user code is refused before counting. When the budget is used up, the approval route refuses further attempts with a rate-limit error (HTTP 429) until the next hour. The budget is per account: one account using its budget does not change the budget of any other account. The window is the clock hour, so up to twice the budget (40 attempts) can fall inside one user code's 10-minute lifetime when the attempts straddle an hour boundary. The budget is defence in depth for the 4-digit user code; it raises the cost of guessing and does not make guessing impossible.

### Inductive OAuth invariants enforce PKCE S256, single-agent replacement, and token reuse revocation

```quint
pure def alwaysSingleAgentGrant(s: OAuthState): bool =
  AG::alwaysSingleActiveGrant(s.agentSlot) and s.now == s.agentSlot.now

pure def alwaysRegisteredClientsValid(s: OAuthState): bool =
  s.now >= 0
    and s.registeredClients.every(c =>
      c.regClientId != ""
        and c.regClientName != ""
        and redirectAllowed(c.regRedirectKind)
        and c.regAuthMethod == AuthMethodNone
    )

pure def alwaysAuthRequestRespectsPkceAndResource(s: OAuthState): bool =
  (s.pendingAuth.authPhase != AuthIdle implies (
    s.pendingAuth.reqClientId != ""
      and s.pendingAuth.reqClientName != ""
      and redirectAllowed(s.pendingAuth.reqRedirectKind)
      and s.pendingAuth.reqPkceMethod == PkceS256
      and s.pendingAuth.reqResponseMode == CodeFlow
      and s.pendingAuth.reqResource == canonicalMcpResource
      and s.pendingAuth.reqStateLen >= 1
  ))
    and (s.pendingAuth.authPhase == AuthCodeIssued implies (
      s.pendingAuth.authAccountId != ""
        and s.pendingAuth.authCode != ""
        and AG::hasAnyScope(s.pendingAuth.authGrantedScopes)
    ))

pure def alwaysDeviceAuthRespectsFeedLink(s: OAuthState): bool =
  (s.deviceAuth.deviceStatus != DeviceIdle implies (
    s.deviceAuth.deviceClientId != ""
      and s.deviceAuth.deviceClientName != ""
      and s.deviceAuth.deviceResource == canonicalMcpResource
      and s.deviceAuth.verificationUri == canonicalDeviceUri
      and s.deviceAuth.deviceCode != ""
      and s.deviceAuth.userCode != ""
  ))
    and ((s.deviceAuth.deviceStatus == DeviceApproved or s.deviceAuth.deviceStatus == DeviceConsumed) implies (
      s.deviceAuth.deviceAccountId != ""
        and AG::hasAnyScope(s.deviceAuth.deviceScopes)
    ))

pure def alwaysActiveTokenMatchesActiveGrantAndLifetimes(s: OAuthState): bool =
  (s.tokenFamily.familyStatus == FamilyNone implies (
    s.tokenFamily.generation == 0 and s.tokenFamily.familyGrantId == ""
  ))
    and (s.tokenFamily.familyStatus != FamilyNone implies (
      s.tokenFamily.generation >= 1
        and s.tokenFamily.familyGrantId != ""
        and s.tokenFamily.familyAccountId != ""
        and s.tokenFamily.familyClientId != ""
        and s.tokenFamily.familyClientName != ""
        and s.tokenFamily.audience == canonicalMcpResource
        and AG::hasAnyScope(s.tokenFamily.familyScopes)
        and 0 <= s.tokenFamily.authAt
        and s.tokenFamily.authAt <= s.tokenFamily.issuedAt
        and s.tokenFamily.issuedAt <= s.now
        and s.tokenFamily.grantExpiresAt == s.tokenFamily.authAt + maxGrantLifetimeMs
        and s.tokenFamily.accessExpiresAt <= s.tokenFamily.issuedAt + accessTokenLifetimeMs
        and s.tokenFamily.accessExpiresAt <= s.tokenFamily.grantExpiresAt
    ))
    and (s.tokenFamily.familyStatus == FamilyActive implies (
      s.agentSlot.activeGrantCount == 1
        and AG::grantIdOf(s.agentSlot.activeGrant) == s.tokenFamily.familyGrantId
        and s.agentSlot.accountId == s.tokenFamily.familyAccountId
    ))
    and ((s.tokenFamily.familyStatus == FamilyRevoked or s.tokenFamily.familyStatus == FamilyReused) implies (
      AG::grantIdOf(s.agentSlot.activeGrant) != s.tokenFamily.familyGrantId
        and s.agentSlot.historyRevokedIds.includes(s.tokenFamily.familyGrantId)
    ))

pure def lawNormalizeResourceStripsTrailingSlash(rawResource: str): bool =
  normalizeResource("https://feed.fun/mcp/") == canonicalMcpResource
    and normalizeResource("https://feed.fun/mcp") == canonicalMcpResource
    and (rawResource == "https://evil.example/mcp" implies not(resourceAllowed(rawResource)))

pure def lawWeakPkceImplicitAndDisallowedRedirectsRefused(
  s: OAuthState,
  clientId: str,
  redirectKind: RedirectKind,
  pkceMethod: PkceMethod,
  responseMode: ResponseMode,
  rawResource: str,
  stateLen: int
): bool =
  (pkceMethod != PkceS256 or responseMode != CodeFlow or not(redirectAllowed(redirectKind)) or not(resourceAllowed(rawResource)) or stateLen < 1) implies
    not(canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen))

pure def sometimesAuthCodeConnectedAndRefreshed(s: OAuthState): bool =
  s.tokenFamily.familyStatus == FamilyActive
    and s.tokenFamily.pkceVerified
    and s.tokenFamily.generation >= 2
    and s.agentSlot.activeGrantCount == 1

pure def sometimesDeviceFlowReplacedPriorAgent(s: OAuthState): bool =
  s.tokenFamily.familyStatus == FamilyActive
    and s.deviceAuth.deviceStatus == DeviceConsumed
    and s.agentSlot.activeGrantCount == 1
    and s.agentSlot.historyRevokedIds.length() >= 1

pure def sometimesRefreshReuseRevokedAll(s: OAuthState): bool =
  s.tokenFamily.familyStatus == FamilyReused
    and s.lastRefusal == RefusalReuseDetected
    and s.agentSlot.activeGrantCount == 0
```

### Simulation samples and witness journeys exercise 400+ char state, trailing-slash resource, device flow replacement, and reuse detection

```quint
pure val clientIdValues: Set[str] = Set("client-claude", "client-chatgpt", "client-hermes")
pure val clientNameValues: Set[str] = Set("Claude", "ChatGPT", "Hermes")
pure val rawResourceValues: Set[str] = Set("https://feed.fun/mcp", "https://feed.fun/mcp/", "https://evil.example/mcp")
pure val stateLenValues: Set[int] = Set(0, 32, 420)
pure val accountIdValues: Set[str] = Set("acct-1")
pure val approvedScopesValues: Set[AG::ScopeSet] = Set(AG::allScopes, AG::readOnlyScopes, AG::socialOnlyScopes, AG::emptyScopes)
pure val requestedScopesValues: Set[AG::ScopeSet] = Set(AG::allScopes, AG::tradingScopes, AG::readOnlyScopes)
pure val authCodeValues: Set[str] = Set("code-1", "code-2")
pure val grantIdValues: Set[str] = Set("grant-1", "grant-2", "grant-3")
pure val refreshGrantIdValues: Set[str] = Set("grant-1", "grant-2")
pure val presentedGenValues: Set[int] = Set(0, 1, 2)
pure val deviceCodeValues: Set[str] = Set("dev-1")
pure val userCodeValues: Set[str] = Set("ABCD-1234")
pure val elapsedValues: Set[AG::Millis] = Set(60000, 900000, 3600000)

pure val eval_witness_sometimesAuthCodeConnectedAndRefreshed = (
  ("registerClient", "client-chatgpt", "ChatGPT", ClientCimd, RedirectHostedCallback, AuthMethodNone),
  ("startAuthorization", "client-chatgpt", RedirectHostedCallback, PkceS256, CodeFlow, "https://feed.fun/mcp/", 420),
  ("approveConsent", "acct-1", true, AG::allScopes, "code-1"),
  ("exchangeAuthCode", "code-1", "client-chatgpt", RedirectHostedCallback, "https://feed.fun/mcp", true, "grant-1"),
  ("elapse", 900000),
  ("refreshOAuthToken", "grant-1", 1)
)

pure val eval_witness_sometimesDeviceFlowReplacedPriorAgent = (
  ("registerClient", "client-claude", "Claude", ClientCimd, RedirectHostedCallback, AuthMethodNone),
  ("startAuthorization", "client-claude", RedirectHostedCallback, PkceS256, CodeFlow, "https://feed.fun/mcp", 64),
  ("approveConsent", "acct-1", true, AG::allScopes, "code-1"),
  ("exchangeAuthCode", "code-1", "client-claude", RedirectHostedCallback, "https://feed.fun/mcp", true, "grant-1"),
  ("registerClient", "client-hermes", "Hermes", ClientDcr, RedirectLoopback, AuthMethodNone),
  ("startDeviceFlow", "client-hermes", "https://feed.fun/mcp/", AG::tradingScopes, "dev-1", "ABCD-1234"),
  ("approveDeviceFlow", "ABCD-1234", "acct-1", true, AG::socialOnlyScopes),
  ("exchangeDeviceCode", "dev-1", "client-hermes", "grant-2")
)

pure val eval_witness_sometimesRefreshReuseRevokedAll = (
  ("registerClient", "client-claude", "Claude", ClientCimd, RedirectHostedCallback, AuthMethodNone),
  ("startAuthorization", "client-claude", RedirectHostedCallback, PkceS256, CodeFlow, "https://feed.fun/mcp", 64),
  ("approveConsent", "acct-1", true, AG::allScopes, "code-1"),
  ("exchangeAuthCode", "code-1", "client-claude", RedirectHostedCallback, "https://feed.fun/mcp", true, "grant-1"),
  ("refreshOAuthToken", "grant-1", 1),
  ("refreshOAuthToken", "grant-1", 1)
)
```
