// spec/auth/oauth.md, "Inductive OAuth invariants enforce PKCE S256, single-agent replacement, and token reuse revocation"

lemma FindClientValid(clients: seq<ClientRegistration>, clientId: string, init: ClientRegistration)
  requires (init.regClientId == "" || init.regClientName != "")
  requires forall c :: c in clients ==> c.regClientName != ""
  ensures Std.Collections.Seq.FoldLeft((acc: ClientRegistration, c: ClientRegistration) => (if (c.regClientId == clientId) then c else acc), init, clients).regClientId != "" ==> Std.Collections.Seq.FoldLeft((acc: ClientRegistration, c: ClientRegistration) => (if (c.regClientId == clientId) then c else acc), init, clients).regClientName != ""
  decreases |clients|
{
  if |clients| > 0 {
    var next := if (clients[0].regClientId == clientId) then clients[0] else init;
    assert forall c :: c in clients[1..] ==> c in clients;
    FindClientValid(clients[1..], clientId, next);
  }
}

lemma startAuthorization_ensures(s: OAuthState, clientId: string, redirectKind: RedirectKind, pkceMethod: PkceMethod, responseMode: ResponseMode, rawResource: string, stateLen: int)
  ensures (inv(s) ==> canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) ==> alwaysSingleAgentGrant(startAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen).state))
  ensures (inv(s) ==> canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) ==> alwaysRegisteredClientsValid(startAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen).state))
  ensures (inv(s) ==> canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) ==> alwaysAuthRequestRespectsPkceAndResource(startAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen).state))
  ensures (inv(s) ==> canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) ==> alwaysDeviceAuthRespectsFeedLink(startAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen).state))
  ensures (inv(s) ==> canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) ==> alwaysActiveTokenMatchesActiveGrantAndLifetimes(startAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen).state))
{
  if inv(s) && canStartAuthorization(s, clientId, redirectKind, pkceMethod, responseMode, rawResource, stateLen) {
    FindClientValid(s.registeredClients, clientId, noClient);
  }
}

lemma startDeviceFlow_ensures(s: OAuthState, clientId: string, rawResource: string, requestedScopes: auth__agentGrant_ScopeSet, deviceCode: string, userCode: string)
  ensures (inv(s) ==> canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) ==> alwaysSingleAgentGrant(startDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode).state))
  ensures (inv(s) ==> canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) ==> alwaysRegisteredClientsValid(startDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode).state))
  ensures (inv(s) ==> canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) ==> alwaysAuthRequestRespectsPkceAndResource(startDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode).state))
  ensures (inv(s) ==> canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) ==> alwaysDeviceAuthRespectsFeedLink(startDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode).state))
  ensures (inv(s) ==> canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) ==> alwaysActiveTokenMatchesActiveGrantAndLifetimes(startDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode).state))
{
  if inv(s) && canStartDeviceFlow(s, clientId, rawResource, requestedScopes, deviceCode, userCode) {
    FindClientValid(s.registeredClients, clientId, noClient);
  }
}
