# Streamable HTTP MCP server and tool authorization

Feed exposes one stateless remote MCP server at `https://feed.fun/mcp` on the official MCP TypeScript SDK over Streamable HTTP (PRD §8.1), replacing the legacy `/api/mcp` route, static GET manifest, and `UserApiKey` credentials (D-16). Tools delegate directly to the same domain services as REST, enforce the single-agent grant ([`agentGrant`](../auth/agentGrant.md)), honor Game/Social mode filtering (D-13), share per-account rate limits with the website, and strictly omit any points-purchase tool, checkout URL, or upsell (D-30).

## Story: Call public and authenticated MCP tools under mixed auth, scope, mode, and D-30 rules

> As a player using ChatGPT, Claude, Hermes, or OpenClaw, I want public discovery tools to work immediately before login, personal/mutating tools to trigger OAuth sign-in cleanly, my scope and Social-mode choices respected, and zero purchase upsells or phone leaks.

### All 49 MVP tools enforce directory annotations, strict schemas, no secrets, and D-30

Every tool has a `<= 64` character `[a-zA-Z0-9_-]+` name, a title, MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), `additionalProperties: false`, zero phone/code fields (`SecretPhone`/`SecretCode` never enter MCP schemas or responses), `"virtual points with no cash value"` descriptions on financial/game tools, and **zero** purchase or checkout tools (D-30).

```quint
import agentGrant as AG from "../auth/agentGrant"

type UiMode = GameMode | SocialMode

type McpTool =
  | ToolAboutFeed
  | ToolHowToPlay
  | ToolStartSignIn
  | ToolCheckSignIn
  | ToolGetPost
  | ToolGetReplies
  | ToolGetUserPosts
  | ToolGetProfile
  | ToolSearch
  | ToolGetTrending
  | ToolGetFollowers
  | ToolGetFollowing
  | ToolListMarkets
  | ToolGetMarket
  | ToolGetLeaderboard
  | ToolWhoami
  | ToolGetHomeFeed
  | ToolGetNotifications
  | ToolGetPortfolio
  | ToolPreviewPerp
  | ToolSetMode
  | ToolMarkNotificationsRead
  | ToolCreatePost
  | ToolDeletePost
  | ToolLike
  | ToolUnlike
  | ToolRepost
  | ToolUnrepost
  | ToolFollow
  | ToolUnfollow
  | ToolBlock
  | ToolUnblock
  | ToolMute
  | ToolUnmute
  | ToolReport
  | ToolUpdateProfile
  | ToolListChats
  | ToolGetMessages
  | ToolSendDm
  | ToolSendMessage
  | ToolCreateGroup
  | ToolInviteToGroup
  | ToolLeaveGroup
  | ToolListGroupInvites
  | ToolRespondToGroupInvite
  | ToolBuyPrediction
  | ToolSellPrediction
  | ToolOpenPerp
  | ToolClosePerp

type CallOutcome =
  | OutcomeNone
  | OutcomeSuccess
  | OutcomeUnauthorized
  | OutcomeForbiddenScope
  | OutcomeRateLimited
  | OutcomeInsufficientPoints

type MutationOrigin = OriginMcp | OriginWeb

type AuditEntry = {
  origin: MutationOrigin,
  viaClientName: str,
  actionLabel: str,
}

type ToolSpec = {
  nameLengthOk: bool,
  isPublicTool: bool,
  requiredScope: AG::Scope,
  isMutating: bool,
  readOnlyHint: bool,
  destructiveHint: bool,
  openWorldHint: bool,
  strictAdditionalPropsFalse: bool,
  acceptsOrReturnsPhoneOrCode: bool,
  isPurchaseOrCheckoutTool: bool,
  mentionsVirtualPointsNoCashValue: bool,
  hasBalanceOrPnlField: bool,
}

type McpCallResponse = {
  hasResult: bool,
  callOutcome: CallOutcome,
  httpStatus: int,
  wwwAuthenticateHeader: bool,
  metaMcpWwwAuthenticate: bool,
  omitsBalancesAndPnl: bool,
  recordedViaClientName: str,
  includesCheckoutLink: bool,
  includesUpsellPrompt: bool,
  exposesPhoneOrCode: bool,
  allowsAdditionalProperties: bool,
}

type McpEffect =
  | EmittedDual401Challenge({ challengeStatus: int })
  | EmittedToolResult({ resultTool: McpTool, omittedFinance: bool, viaClient: str })
  | EmittedPlainInsufficientPoints

type McpServer = {
  uiMode: UiMode,
  agentSlot: AG::AccountAgentSlot,
  rateUsed: int,
  rateLimit: int,
  lastResponse: McpCallResponse,
  auditTrail: List[AuditEntry],
}

type McpStep = {
  state: McpServer,
  out: List[McpEffect],
}

pure val sharedAccountRateLimit: int = 3

pure val idleResponse: McpCallResponse = {
  hasResult: false,
  callOutcome: OutcomeNone,
  httpStatus: 0,
  wwwAuthenticateHeader: false,
  metaMcpWwwAuthenticate: false,
  omitsBalancesAndPnl: true,
  recordedViaClientName: "",
  includesCheckoutLink: false,
  includesUpsellPrompt: false,
  exposesPhoneOrCode: false,
  allowsAdditionalProperties: false,
}

pure val initial: McpServer = {
  uiMode: GameMode,
  agentSlot: AG::initial,
  rateUsed: 0,
  rateLimit: sharedAccountRateLimit,
  lastResponse: idleResponse,
  auditTrail: List(),
}

pure def isPublicMcpTool(t: McpTool): bool =
  t == ToolAboutFeed
    or t == ToolHowToPlay
    or t == ToolStartSignIn
    or t == ToolCheckSignIn
    or t == ToolGetPost
    or t == ToolGetReplies
    or t == ToolGetUserPosts
    or t == ToolGetProfile
    or t == ToolSearch
    or t == ToolGetTrending
    or t == ToolGetFollowers
    or t == ToolGetFollowing
    or t == ToolListMarkets
    or t == ToolGetMarket
    or t == ToolGetLeaderboard

pure def isMessageMcpTool(t: McpTool): bool =
  t == ToolListChats
    or t == ToolGetMessages
    or t == ToolSendDm
    or t == ToolSendMessage
    or t == ToolCreateGroup
    or t == ToolInviteToGroup
    or t == ToolLeaveGroup
    or t == ToolListGroupInvites
    or t == ToolRespondToGroupInvite

pure def isTradeExecutionTool(t: McpTool): bool =
  t == ToolBuyPrediction
    or t == ToolSellPrediction
    or t == ToolOpenPerp
    or t == ToolClosePerp

pure def requiredScopeOf(t: McpTool): AG::Scope =
  if (isPublicMcpTool(t) or t == ToolWhoami or t == ToolGetHomeFeed or t == ToolGetNotifications or t == ToolGetPortfolio)
    AG::ScopeRead
  else if (isMessageMcpTool(t))
    AG::ScopeMessages
  else if (isTradeExecutionTool(t) or t == ToolPreviewPerp)
    AG::ScopeTrade
  else
    AG::ScopeSocialWrite

pure def isMutatingMcpTool(t: McpTool): bool =
  not(isPublicMcpTool(t))
    and t != ToolWhoami
    and t != ToolGetHomeFeed
    and t != ToolGetNotifications
    and t != ToolGetPortfolio
    and t != ToolPreviewPerp
    and t != ToolListChats
    and t != ToolGetMessages
    and t != ToolListGroupInvites

pure def isDestructiveMcpTool(t: McpTool): bool =
  t == ToolDeletePost or t == ToolBlock or t == ToolLeaveGroup

pure def hasBalanceOrPnlField(t: McpTool): bool =
  t == ToolWhoami
    or t == ToolGetPortfolio
    or t == ToolPreviewPerp
    or isTradeExecutionTool(t)
    or t == ToolListMarkets
    or t == ToolGetMarket
    or t == ToolGetLeaderboard

pure def isGameFinanceTool(t: McpTool): bool =
  hasBalanceOrPnlField(t)

pure def toolMetadata(t: McpTool): ToolSpec = {
  nameLengthOk: true,
  isPublicTool: isPublicMcpTool(t),
  requiredScope: requiredScopeOf(t),
  isMutating: isMutatingMcpTool(t),
  readOnlyHint: not(isMutatingMcpTool(t)),
  destructiveHint: isDestructiveMcpTool(t),
  openWorldHint: false,
  strictAdditionalPropsFalse: true,
  acceptsOrReturnsPhoneOrCode: false,
  isPurchaseOrCheckoutTool: false,
  mentionsVirtualPointsNoCashValue: isGameFinanceTool(t),
  hasBalanceOrPnlField: hasBalanceOrPnlField(t),
}
```

### Public tools succeed unauthenticated; protected tools without a valid token fail with both HTTP 401 `WWW-Authenticate` and `_meta["mcp/www_authenticate"]`

Every unauthenticated (or expired/revoked) call to a non-public tool returns transport HTTP `401` with `WWW-Authenticate` (for Claude) **and** `_meta["mcp/www_authenticate"]` (for ChatGPT). Authorized mutations check the grant's scope, enforce the shared per-account rate limit, filter balances/P&L in Social mode (D-13), record `viaClientName` (D-6), and return plain insufficient-points errors with zero upsell (D-30).

```quint
pure def hasLiveTokenForSlot(s: McpServer, presentedGrantId: str, tokenNotExpired: bool): bool =
  presentedGrantId != ""
    and tokenNotExpired
    and AG::grantIdOf(s.agentSlot.activeGrant) == presentedGrantId
    and not(s.agentSlot.historyRevokedIds.includes(presentedGrantId))

pure def canConnectAgentClient(
  s: McpServer,
  accountId: str,
  grantId: str,
  clientName: str,
  scopes: AG::ScopeSet
): bool =
  AG::canConnectAgent(s.agentSlot, accountId, grantId, clientName, scopes)

pure def connectAgentClient(
  s: McpServer,
  accountId: str,
  grantId: str,
  clientName: str,
  scopes: AG::ScopeSet
): McpStep =
  {
    state: {
      ...s,
      agentSlot: AG::connectAgent(s.agentSlot, accountId, grantId, clientName, scopes).state,
    },
    out: List(),
  }

pure def canRevokeAgentClient(s: McpServer, accountId: str, grantId: str): bool =
  AG::canRevokeAgent(s.agentSlot, accountId, grantId)

pure def revokeAgentClient(s: McpServer, accountId: str, grantId: str): McpStep =
  {
    state: {
      ...s,
      agentSlot: AG::revokeAgent(s.agentSlot, accountId, grantId).state,
    },
    out: List(),
  }

pure def succeedPublicToolCall(tool: McpTool, meta: ToolSpec, s: McpServer): McpStep = {
  val omitsFinance = s.uiMode == SocialMode or not(meta.hasBalanceOrPnlField)
  val resp = {
    ...idleResponse,
    hasResult: true,
    callOutcome: OutcomeSuccess,
    httpStatus: 200,
    omitsBalancesAndPnl: omitsFinance,
  }
  {
    state: { ...s, lastResponse: resp },
    out: List(EmittedToolResult({ resultTool: tool, omittedFinance: omitsFinance, viaClient: "" })),
  }
}

pure def failToolCall(failOutcome: CallOutcome, status: int, dual401: bool, s: McpServer): McpStep = {
  val resp = {
    ...idleResponse,
    hasResult: false,
    callOutcome: failOutcome,
    httpStatus: status,
    wwwAuthenticateHeader: dual401,
    metaMcpWwwAuthenticate: dual401,
    omitsBalancesAndPnl: true,
  }
  val effects =
    if (dual401) List(EmittedDual401Challenge({ challengeStatus: 401 }))
    else if (failOutcome == OutcomeInsufficientPoints) List(EmittedPlainInsufficientPoints)
    else List()
  { state: { ...s, lastResponse: resp }, out: effects }
}

pure def executeAuthorizedToolCall(
  tool: McpTool,
  meta: ToolSpec,
  presentedGrantId: str,
  requestedMode: UiMode,
  s: McpServer
): McpStep = {
  val nextMode = if (tool == ToolSetMode) requestedMode else s.uiMode
  val omitsFinance = nextMode == SocialMode or not(meta.hasBalanceOrPnlField)
  val client = AG::grantClientOf(s.agentSlot.activeGrant)
  val nextSlot =
    if (meta.isMutating) AG::recordAgentAction(s.agentSlot, s.agentSlot.accountId, presentedGrantId, client).state
    else s.agentSlot
  val nextRate = if (meta.isMutating) s.rateUsed + 1 else s.rateUsed
  val nextAudit =
    if (meta.isMutating) s.auditTrail.append({ origin: OriginMcp, viaClientName: client, actionLabel: "mcp_mutation" })
    else s.auditTrail
  val resp = {
    ...idleResponse,
    hasResult: true,
    callOutcome: OutcomeSuccess,
    httpStatus: 200,
    omitsBalancesAndPnl: omitsFinance,
    recordedViaClientName: if (meta.isMutating) client else "",
  }
  {
    state: {
      ...s,
      uiMode: nextMode,
      agentSlot: nextSlot,
      rateUsed: nextRate,
      lastResponse: resp,
      auditTrail: nextAudit,
    },
    out: List(EmittedToolResult({ resultTool: tool, omittedFinance: omitsFinance, viaClient: if (meta.isMutating) client else "" })),
  }
}

pure def callMcpTool(
  s: McpServer,
  tool: McpTool,
  presentedGrantId: str,
  tokenNotExpired: bool,
  insufficientPoints: bool,
  requestedMode: UiMode
): McpStep =
  val meta = toolMetadata(tool)
  val tokenLive = hasLiveTokenForSlot(s, presentedGrantId, tokenNotExpired)
  if (meta.isPublicTool)
    succeedPublicToolCall(tool, meta, s)
  else if (not(tokenLive))
    failToolCall(OutcomeUnauthorized, 401, true, s)
  else if (not(AG::hasScope(AG::grantScopesOf(s.agentSlot.activeGrant), meta.requiredScope)))
    failToolCall(OutcomeForbiddenScope, 403, false, s)
  else if (meta.isMutating and s.rateUsed >= s.rateLimit)
    failToolCall(OutcomeRateLimited, 429, false, s)
  else if (isTradeExecutionTool(tool) and insufficientPoints)
    failToolCall(OutcomeInsufficientPoints, 400, false, s)
  else
    executeAuthorizedToolCall(tool, meta, presentedGrantId, requestedMode, s)

pure def canCallWebAction(s: McpServer, isMutating: bool): bool =
  s.agentSlot.accountId != "" and (not(isMutating) or s.rateUsed < s.rateLimit)

pure def callWebAction(s: McpServer, isMutating: bool, nextMode: UiMode): McpStep =
  {
    state: {
      ...s,
      uiMode: nextMode,
      rateUsed: if (isMutating) s.rateUsed + 1 else s.rateUsed,
      lastResponse: idleResponse,
      auditTrail: if (isMutating) s.auditTrail.append({ origin: OriginWeb, viaClientName: "", actionLabel: "web_mutation" }) else s.auditTrail,
    },
    out: List(),
  }

pure def canResetRateWindow(s: McpServer): bool =
  s.rateUsed > 0

pure def resetRateWindow(s: McpServer): McpStep =
  { state: { ...s, rateUsed: 0 }, out: List() }

pure def canElapse(s: McpServer, elapsed: AG::Millis): bool =
  elapsed > 0

pure def elapse(s: McpServer, elapsed: AG::Millis): McpStep =
  { state: { ...s, agentSlot: AG::elapse(s.agentSlot, elapsed).state }, out: List() }
```

### Inductive MCP invariants enforce D-30, Social mode filtering, dual 401 challenges, shared limits, and attribution

```quint
pure def alwaysSingleAgentGrant(s: McpServer): bool =
  AG::alwaysSingleActiveGrant(s.agentSlot)

pure def alwaysSharedRateLimitBounded(s: McpServer): bool =
  s.rateLimit == sharedAccountRateLimit and 0 <= s.rateUsed and s.rateUsed <= s.rateLimit

pure def alwaysD30NoPurchaseUpsellOrSecretLeak(s: McpServer): bool =
  not(s.lastResponse.includesCheckoutLink)
    and not(s.lastResponse.includesUpsellPrompt)
    and not(s.lastResponse.exposesPhoneOrCode)
    and not(s.lastResponse.allowsAdditionalProperties)

pure def alwaysSocialModeOmitsBalancesAndPnl(s: McpServer): bool =
  (s.uiMode == SocialMode and s.lastResponse.hasResult) implies s.lastResponse.omitsBalancesAndPnl

pure def alwaysDual401OnUnauthorizedCall(s: McpServer): bool =
  (s.lastResponse.callOutcome == OutcomeUnauthorized) implies (
    s.lastResponse.httpStatus == 401
      and s.lastResponse.wwwAuthenticateHeader
      and s.lastResponse.metaMcpWwwAuthenticate
  )

pure def alwaysAuditAttributionConsistent(s: McpServer): bool =
  s.auditTrail.every(entry =>
    ((entry.origin == OriginMcp) implies entry.viaClientName != "")
      and ((entry.origin == OriginWeb) implies entry.viaClientName == "")
  )

pure def lawEveryToolFollowsDirectorySchemaAndD30(t: McpTool): bool =
  val m = toolMetadata(t)
  m.nameLengthOk
    and m.strictAdditionalPropsFalse
    and not(m.acceptsOrReturnsPhoneOrCode)
    and not(m.isPurchaseOrCheckoutTool)
    and (isGameFinanceTool(t) implies m.mentionsVirtualPointsNoCashValue)

pure def lawProtectedToolsRequireAuthAndEmitDual401(
  s: McpServer,
  tool: McpTool,
  presentedGrantId: str,
  tokenNotExpired: bool,
  insufficientPoints: bool,
  requestedMode: UiMode
): bool = {
  val stepRes = callMcpTool(s, tool, presentedGrantId, tokenNotExpired, insufficientPoints, requestedMode).state.lastResponse
  val needsAuth = not(isPublicMcpTool(tool)) and not(hasLiveTokenForSlot(s, presentedGrantId, tokenNotExpired))
  needsAuth implies (
    stepRes.callOutcome == OutcomeUnauthorized
      and stepRes.httpStatus == 401
      and stepRes.wwwAuthenticateHeader
      and stepRes.metaMcpWwwAuthenticate
  )
}

pure def lawPublicToolsSucceedUnauthenticated(
  s: McpServer,
  tool: McpTool,
  insufficientPoints: bool,
  requestedMode: UiMode
): bool = {
  val stepRes = callMcpTool(s, tool, "", false, insufficientPoints, requestedMode).state.lastResponse
  val isPub = isPublicMcpTool(tool)
  isPub implies (
    stepRes.hasResult and stepRes.callOutcome == OutcomeSuccess and stepRes.httpStatus == 200
  )
}

pure def sometimesPublicReadSucceeded(s: McpServer): bool =
  s.lastResponse.hasResult and s.lastResponse.callOutcome == OutcomeSuccess and s.agentSlot.activeGrantCount == 0

pure def sometimesDual401Triggered(s: McpServer): bool =
  s.lastResponse.callOutcome == OutcomeUnauthorized and s.lastResponse.wwwAuthenticateHeader and s.lastResponse.metaMcpWwwAuthenticate

pure def sometimesScopeForbidden(s: McpServer): bool =
  s.lastResponse.callOutcome == OutcomeForbiddenScope

pure def sometimesSocialModeFilteredPortfolio(s: McpServer): bool =
  s.uiMode == SocialMode and s.lastResponse.hasResult and s.lastResponse.omitsBalancesAndPnl

pure def sometimesSharedRateLimitHit(s: McpServer): bool =
  s.lastResponse.callOutcome == OutcomeRateLimited and s.rateUsed == s.rateLimit

pure def sometimesInsufficientPointsNoUpsell(s: McpServer): bool =
  s.lastResponse.callOutcome == OutcomeInsufficientPoints and not(s.lastResponse.includesCheckoutLink) and not(s.lastResponse.includesUpsellPrompt)
```

### Simulation samples and witness journeys verify mixed auth, dual 401, scopes, Social mode, shared rate limits, and D-30

```quint
pure val accountIdValues: Set[str] = Set("acct-1")
pure val grantIdValues: Set[str] = Set("grant-1", "grant-2")
pure val presentedGrantIdValues: Set[str] = Set("", "grant-1", "grant-2")
pure val clientNameValues: Set[str] = Set("Claude", "ChatGPT")
pure val elapsedValues: Set[AG::Millis] = Set(60000, 3600000)

pure val eval_witness_sometimesPublicReadSucceeded =
  ("callMcpTool", ToolListMarkets, "", false, false, GameMode)

pure val eval_witness_sometimesDual401Triggered =
  ("callMcpTool", ToolGetHomeFeed, "", false, false, GameMode)

pure val eval_witness_sometimesScopeForbidden = (
  ("connectAgentClient", "acct-1", "grant-1", "Claude", AG::readOnlyScopes),
  ("callMcpTool", ToolBuyPrediction, "grant-1", true, false, GameMode)
)

pure val eval_witness_sometimesSocialModeFilteredPortfolio = (
  ("connectAgentClient", "acct-1", "grant-1", "Claude", AG::allScopes),
  ("callMcpTool", ToolSetMode, "grant-1", true, false, SocialMode),
  ("callMcpTool", ToolGetPortfolio, "grant-1", true, false, SocialMode)
)

pure val eval_witness_sometimesSharedRateLimitHit = (
  ("connectAgentClient", "acct-1", "grant-1", "Claude", AG::allScopes),
  ("callMcpTool", ToolCreatePost, "grant-1", true, false, GameMode),
  ("callMcpTool", ToolLike, "grant-1", true, false, GameMode),
  ("callWebAction", true, GameMode),
  ("callMcpTool", ToolBuyPrediction, "grant-1", true, false, GameMode)
)

pure val eval_witness_sometimesInsufficientPointsNoUpsell = (
  ("connectAgentClient", "acct-1", "grant-1", "Claude", AG::allScopes),
  ("callMcpTool", ToolBuyPrediction, "grant-1", true, true, GameMode)
)
```
