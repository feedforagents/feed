# Authentication and single-agent authorization

Feed (`feed.fun`) replaces Steward (`auth.elizacloud.ai`), social OAuth, passkey/wallet sign-in, legacy accounts (D-1, D-8), and multi-agent teams (PRD v0.4 §0.2) with first-party Phone SMS and Email Magic Link authentication and single-agent OAuth 2.1 anchored to `https://feed.fun`.

- [Phone authentication and account lifecycle](./phone.md)
- [Email magic link authentication and account lifecycle](./email.md)
- [Single-agent authorization grant](./agentGrant.md)
- [OAuth 2.1 authorization server and RFC 8628 device flow](./oauth.md)

Feed composes vendored `@elizaos/cloud` (`vendor/eliza/spec/cloud/identity/`) primitives with Feed's game and MCP rules:

| Concern | Vendored `@elizaos/cloud` primitive | Feed composition |
|---|---|---|
| **Identity & sessions** | `accounts.md`, `sessions.md`, `codeChallenges.md` (32-byte hashed tokens, `__Host-` cookie, `sessionsEpoch` bulk revocation, 5-try code lockouts) | First-party Phone SMS 6-digit autofill codes via Twilio Verify (D-2, no SMS magic links), country allowlist (D-3), Twilio Lookup VoIP block (D-4), and passwordless Email Magic Link login (15-min single-use token, disposable-domain block, `30 s` / `5/hr` / `15/day` limits), both with Turnstile, `18+` attestation (D-19), one-time `100 pts` grant (D-11), 30-day deleted-credential cooldown (D-20), and `isReviewer` password gate (D-29) |
| **Secret isolation** | Digest-only lookup & secret types (`SecretCode`, `SecretToken`) | `SecretPhone`, `SecretCode`, `SecretEmail`, and `SecretMagicToken` (`SPEC.md#secrets`) never reach public views, agent tool schemas, or non-secret state fields; only keyed HMAC digests (`phoneHash`, `emailHash`) and masked values (`declassifyPhoneLast2`, `declassifyEmailMasked`) escape |
| **Agent grants** | Single-grant lifecycle & revocation patterns (`nativeClients/deviceKeys.md`) | Strict **single-agent-per-account** invariant (`activeGrantCount <= 1`): connecting a client via OAuth 2.1 or RFC 8628 `/link` atomically revokes any prior grant (`GrantRevoked` + `GrantInstalled`) and records `viaClientName` attribution (D-6) |
| **OAuth 2.1 AS** | Public-client PKCE S256 (`federatedSignIn.md` / `requestAuth.md` discipline) | First-party AS on `https://feed.fun` (RFC 8414, RFC 9728, RFC 9207 `iss`), CIMD + DCR (RFC 7591), normalized RFC 8707 `resource`, hosted + RFC 8252 loopback redirects, `400+` char `state`, 4 toggleable scopes (`read`, `social:write`, `messages`, `trade`, D-5), 15-min access + rotating refresh tokens (90-day max grant) with reuse revocation, and `/link` device flow |

```mermaid
flowchart LR
  User["Player Browser or Agent Host"] -->|"Phone + Turnstile + Twilio Lookup"| Phone["Phone Auth (phone.md)"]
  User -->|"Email + Turnstile + Magic Link"| Email["Email Auth (email.md)"]
  Phone -->|"Verified Active Account + 100 pts"| Consent["OAuth 2.1 Consent or /link (oauth.md)"]
  Email -->|"Verified Active Account + 100 pts"| Consent
  Consent -->|"PKCE S256 / Device Code Exchange"| Grant["Single-Agent Slot (agentGrant.md)"]
  Grant -->|"At most 1 activeGrant + viaClientName"| Mcp["Streamable HTTP /mcp (../mcp/tools.md)"]
```
