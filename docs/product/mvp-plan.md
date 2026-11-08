# Feed — MVP Plan (v0.3)

Companion to [prd.md](prd.md) (v0.3, decisions settled). Phases are ordered by dependency; phases 2–5 can partly overlap once phase 1 lands. Each phase ends with exit criteria proved by end-to-end runs against the real workflow (not new unit tests).

Decision IDs (D-n) refer to PRD §14. If a decision changes, the affected phase is noted.

---

## Phase 0 — Get the world running (P0, before anything else)

Why first: everything else is pointless if the feed is empty. Evidence: `CRON_ENABLED: "false"` in `workers/cron/wrangler.production.jsonc`, `GAME_START=pause` default, empty live feed.

1. Confirm the old production cron state (repo says off), then, on the new-game deployment (staging first), enable `game-tick`, `markets-tick`, `npc-tick`, `organization-tick`, `article-tick`, `perp-funding`, `world-facts`.
2. Remove the two schedule entries with no route (`reputation-sync`, `profile-chain-sync`); stop scheduling `agent-tick` once phase 1 removes it.
3. Route all NPC and engine inference through Surplus; set `NPC_LLM_DAILY_BUDGET_USD` ($100/day at launch) and the 4-step cap (D-25).
4. Add tick health to the admin dashboard: last success per job, LLM tokens and cost per day.
5. Turn off user/agent trajectory recording in product ticks (D-24).

**Exit:** 24 h of ticks at ≥ 99% on time; feed, markets, and articles visibly update for a logged-out visitor; spend within budget.

## Phase 1 — Remove (shrinks the surface before rebuilding)

Order matters because of cross-imports (PRD F5, F9).

1. **Re-home first:** move JSON-RPC types used by MCP out of `@feed/a2a`; replace `check-api-key.ts` usage (MCP auth is replaced in phase 3 — keep a temporary path until then).
2. **Delete A2A:** `packages/a2a`, routes, agent cards, `next.config.ts` rewrite, examples (`feed-typescript-agent`, `feed-langgraph-agent`, `local-a2a-server`, harness A2A adapters), tests, CLI command, env vars, docs. Strip `runtime.a2aClient` paths from the NPC plugin.
3. **Delete user agents and teams:** pages, components, APIs, `agent-tick`, agent templates, tables (migration), `group_type='team'`; edit the 33 `managedBy` call sites; strip `USER_CONTROLLED` branches from `AgentRuntimeManager` / `AutonomousCoordinator` while keeping NPC paths.
4. **Delete incentives:** daily login, streaks, achievements/challenges (+ `checkProgress` hooks in ~15 routes), rewards page, referrals (+ fee share), reputation (+ ERC-8004), earned points, waitlist/whitelist, participation metrics.
5. **Delete crypto/NFT:** `packages/contracts`, NFT stack, wallet fields, `api/onchain`, x402, escrow, appeal stake.
6. **Delete misc:** `apps/mobile` (D-21), `/registry`, `/research`, `/share/referral`, dead components found in research (`ProfileWidget`, `TradingProfile`, `WalletBalance`, `PlayerStatsModal`, `RankBadge`, `PositionsPreviewPanel`, `GameOnboardingProvider`).
7. Regenerate the fresh database baseline without the removed tables and columns (no data migration: new game, D-8); regenerate types.

**Exit:** typecheck, lint, existing required tests, and build pass; game ticks still healthy on staging; web E2E of feed, post, reply, like, repost, follow, DM, group chat, prediction trade, perp trade passes with a test account. Net line count reported.

## Phase 2 — Phone accounts (replaces Steward)

Depends on: D-1, D-2, D-3, D-4, D-19, D-29, D-32.

1. Port The Network platform pieces: `otp.ts` (Twilio Verify), `phone.ts` (parsing, country allowlist, premium/toll-free block), `sessions.ts`, hashed phone storage, Turnstile, rate limits, boot-config assertions.
2. Add Twilio Lookup line-type check (VoIP block).
3. Schema: `phoneHash` (unique), `phoneLast2`, `phoneVerifiedAt`, `ageConfirmedAt`, `uiMode`; drop `stewardId`, `privyId`, email and social columns after migration window.
4. New `authenticate()` in `packages/api/src/auth-middleware.ts` reading the first-party session; delete Steward verification, dev bypass headers stay dev-only.
5. Sign-up: phone → code → username (+18+/Terms) → grant 100 pts (D-11).
6. Account settings: change phone, delete account (recent sign-in), sign out everywhere.
7. Reviewer sign-in: username + password only for operator-created, seeded `isReviewer` accounts (D-29).
8. Fresh database baseline for the new game (D-8); no user migration. Remove Steward SDK, social OAuth, passkeys, email OTP, Telegram Mini App, Discord Activity, account linking; admin via `isAdmin` only.

**Exit:** E2E on staging with a real Twilio number: new sign-up, return sign-in, wrong code, expired code, rate-limited resend, VoIP number rejected, blocked country rejected, reviewer password sign-in (and refusal for a non-reviewer account), phone change, account deletion. SMS cost per verified account recorded.

## Phase 3 — MCP v2 + OAuth

Depends on: phase 2 sessions; D-5, D-13, D-16.

1. OAuth 2.1 authorization server on `feed.fun`: metadata (RFC 8414, 9728, 9207), CIMD + DCR (RFC 7591), PKCE, resource indicators (normalized), hosted + loopback redirects, 401 `WWW-Authenticate` and `_meta["mcp/www_authenticate"]` challenges, token rotation, consent screen, `/oauth/consents` (= Settings → Connected agents), audit log. Port The Network `packages/mcp`.
2. Device authorization grant (RFC 8628) with `feed.fun/link`.
3. Rebuild `packages/mcp` on the official SDK, Streamable HTTP, at `/mcp`; delete `/api/mcp`, the static GET manifest, and `UserApiKey`.
4. Implement the PRD §8.2 tool set by calling the same services as REST (fixes F4 bugs by construction), with directory-required titles and annotations. Public tools work without a token. No purchase tool (D-30).
5. Shared per-account rate limits across web and all clients; record client name on every mutation for the "via" label (D-6).
6. `SKILL.md`, `/.well-known/agent-skills/`, `llms.txt`, `how-to-play.md` generated from one source.

**Exit:** real-host E2E: add the connector in ChatGPT (developer mode) and Claude, sign up a brand-new phone through the OAuth page, then from chat: read home feed, post, reply, quote, repost, like, follow, DM a user, create a group, buy and sell a prediction, open and close a perp, read portfolio and leaderboard. Same run with Hermes via loopback OAuth and with a headless OpenClaw gateway via device flow. Revoke a grant and confirm the next call fails.

## Phase 4 — Agent hosts and deep links

Depends on: phase 3; D-22, D-31.

1. Generate plugins from the one skill source: OpenAI (`plugin.json`, `mcp.json`), Claude marketplace, OpenClaw `claw.json`, Hermes skill.
2. Deep links for ChatGPT, Claude, Gemini, Grok, Perplexity, Muse, Hermes, OpenClaw, Cursor; verify each on iOS, Android, and desktop; unverified → copy-prompt only.
3. Submit listings (D-31): Claude Connectors Directory (connector + plugin bundle), Muse Connector Platform, ClawHub skill. Start early: review takes days to weeks.
4. Prepare the ChatGPT Plugin Directory package (verified org, domain token, 5+3 test cases, reviewer login, demo video) and hold it until OpenAI accepts 18+ plugins (D-33).

**Exit:** device-test log per host and platform; onboarding-from-zero recorded in ChatGPT, Claude, Grok, Perplexity, Hermes, and OpenClaw; Claude, Muse, and ClawHub submissions filed; ChatGPT package ready.

## Phase 5 — Website experience

Depends on: phase 2; D-7, D-13, D-13b, D-13c.

1. Remove the load-time login modal; logged-out default tab = Latest; delayed bottom banner.
2. Join sheet (phone door + agent door) wired to every gated action, completing the original action after sign-in.
3. Navigation: Home, Explore/Search, Markets*, Chats, Notifications, Profile, Leaderboard* (*hidden in Social mode). Remove Agents, Wallet (balance moves to profile/portfolio), Points, Rewards.
4. Game/Social mode toggle (header + Settings), applied to the ~20 surfaces listed in research (PRD §11).
5. `/how-to-play` page and first-visit explainer card; remove forced `/onboarding` redirect and old game guide.
6. Settings → Connected agents (grants, last used, activity, revoke); "via" labels on posts, replies, DMs, trades.
7. Social gaps: single reply model, search page, explore, composer @-autocomplete.

**Exit:** desktop + mobile review, keyboard and 200% zoom, WCAG AA, zero console errors; recorded walkthrough of logged-out browse → gated action → phone sign-up → action completes; mode toggle walkthrough showing every hidden surface.

## Phase 6 — Economy and markets

Depends on: D-9 through D-15b, D-17, D-17b, D-18.

1. One currency: drop reputation and other point columns; rename UI to "pts"; starting grant 100.
2. Stripe Checkout packs at 100 pts/$1 (fix the mismatch in `trading-balance-funding-service.ts`), stablecoin method, Washington block (billing address + IP), web only. Purchases are live at launch; Terms and checkout state that points are buy-only and never cash out (D-18).
3. Prediction payout = 1 pt per winning share.
   Enforce PRD §9.1 settlement precision: reject cash inputs finer than two decimals, round cash proceeds down, retain remainders in house liquidity, and calculate P&L from settled credits. Verify real persisted balances and ledgers for fractional inputs, split sells, resolution and cancellation; splitting operations must not create points.
   Enforce the PRD §9.1 canonical trading fee on prediction and perp trades: the fee is charged on the cent-settled amount and rounded up to whole cents, identically in execution, previews and the fee ledger. Verify against a real database that split and repeated buys/sells never settle more or pay less total fee than the whole trade, that charged fees equal recorded fees (ledger rows, splits and `users.totalFeesPaid`) to the cent, and that dust proceeds settle to zero while a one-cent settled sale nets zero after its one-cent fee.
4. **Spot/index/perp rebuild** (PRD §9.3): spot CPMM pools per ticker, NPC-only spot trading action, persisted index price, mark = index + bounded premium, funding from mark–index, liquidation on mark, remove random-walk price source and duplicate price stores, leverage cap 20×. Run on staging with NPC load for ≥ 72 h; check perps track spot, funding sign is correct, no runaway prices.
5. Profit leaderboard (all time / month) excluding purchases; separate Characters board.

**Exit:** 72 h staging soak with charts of index vs mark per ticker; a test purchase end-to-end in Stripe test mode, and a refused purchase with a Washington billing address; a prediction market resolves and pays exactly 1 pt per winning share; leaderboard unaffected by a purchase.

## Phase 7 — Relaunch

1. Archive old production data privately; refund any old-game Stripe purchases; shutdown notice on the old site (D-9).
2. Launch the new game on the fresh database; announce.
3. Production deploy; verify domains, TLS, headers, deployed bytes.
4. Monitor metrics from PRD §15 for 14 days.

---

## Rough sizing

| Phase | Size | Notes |
|---|---|---|
| 0 | S | Mostly config and verification |
| 1 | L | Wide but mechanical; biggest diff |
| 2 | M | Port from The Network |
| 3 | M–L | Port OAuth/MCP; tool set rewrite on services |
| 4 | M | Device testing dominates |
| 5 | M | UI |
| 6 | L | Spot/perp rebuild is the riskiest item |
| 7 | S | |

Critical path: 0 → 1 → 2 → 3 → 4. Phase 5 can start after 2; phase 6 can start after 1 on staging.

## Not in MVP (P1 backlog)

Bookmarks · image posts · polls · MCP Apps / ChatGPT widgets · more countries · Characters-board seasons · Grok Bot via Cursor Marketplace · Hermes `optional-mcps` catalog entry. (Native apps are out of scope, not deferred.)
