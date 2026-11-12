# Feed — MVP Plan (v0.5)

Companion to [prd.md](prd.md) (v0.5, onboarding narrowed 2026-11-09). Phases are ordered by dependency; phases 2–5 can partly overlap once phase 1 lands. Each phase ends with exit criteria proved by end-to-end runs against the real workflow (not new unit tests).

Approved onboarding scope: [#1832](https://github.com/feedforagents/feed/issues/1832), narrowed by the maintainer's 2026-11-09 instruction.

**Current delivery boundary:** preserve Steward, the public feed, prompt-first popup with optional existing Sign in, and canonical setup skill. Prove one complete MCP flow: public Latest `get_home_feed` → native supported authorization → same-account `whoami` → explicitly requested `create_post` → persisted `get_post` read-back. First verify Steward's scoped per-client access from owning source/current documentation. The source finding at Steward `develop` commit `297437b23` distinguishes its own agent/provider scopes from Feed human-client resource grants; the closest session signer is unmounted. Retain Steward identity and limit the justified Feed OAuth adapter to this delivery; do not claim Steward lacks scoped-agent support.

Defer headless/device login, CIMD, broad host packaging, automatic web-action queues, and prediction/perp draft restoration from this delivery. Preserve safe login/approval return behavior and core consent, expiry, refresh, revocation, tenant/account binding, and credential privacy. The first tool flow can omit all financial and mode fields; it does not require a `User.uiMode` migration. Wider mode/tool parity and the phase exits below remain unfinished. This incremental change does not authorize a relaunch, database reset, or premature legacy-client retirement.

Consolidate the unmerged work by responsibility in isolated worktrees, folding correctness fixes into the feature they repair and making each PR show its own changes. Keep independent notification privacy repairs separate. A passing subset or assembled review branch is not full MVP acceptance.

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

## Phase 2 — Retain Steward and preserve approval continuity

Depends on: amended D-1 through D-4, D-19, D-29, D-32. SYMBaiEX approved retained Steward and prompt-first entry on 2026-11-09. This replaces the former phone-account rebuild; it does not authorize a database reset or new identity migration.

1. Keep existing Steward sign-in methods, SDK/configuration, sessions, refresh, callbacks, and MFA. Reuse canonical server account resolution and expected tenant validation for authorization/approval. Do not add an identity migration.
2. Preserve pending authorization and its validated return path through login, email/new-tab verification, callback, refresh, and required username/18+/Terms steps; optional game-guide onboarding must not intercept it. This is not an automatic queue of web social/trade actions.
3. Preserve idempotent account signup and existing balances in this delivery. Additional clients reuse the canonical account and receive no extra signup grant. The broader 100-pt starting-economy change (D-11) stays in Phase 6; connecting MCP is not an economy migration.
4. Exclude sign-in/OAuth/consent/callback pages (and device-link pages if later implemented) from analytics pageviews, autocapture, and recording; sanitize sensitive URL values before capture. Preserve existing login security and dev-only bypass boundaries.
5. Keep reviewer access requirements (D-29); verify compatibility with the retained Steward integration. No ordinary-user credential bypass.

**Exit:** real Steward E2E for new and returning users, all supported sign-in methods and required MFA, invalid/expired/canceled login, refresh/logout, same-account reuse, concurrent signup, and approval continuity. Verify no credentials or auth query values in analytics. Unavailable providers remain explicit coverage gaps, not passing results.

## Phase 3 — MCP v2 + OAuth

Depends on: phase 2 retained Steward integration and approval continuity; D-5, D-13, D-16.

1. **First gate — verify Steward scoped access:** record current source/docs evidence for audience/resource binding, per-client scope, consent, expiry, refresh, revocation, and tenant/account binding. The finding in PRD §8.1 is specific: Steward's own `agent` / `api:proxy` credentials target `steward-api`, and its closest session signer is unmounted. Drop-in Feed resource support is not established. Preserve Steward identity; implement only the minimal Feed OAuth scoped-grant adapter needed for this gap. Verify source/license before reuse and revisit if Steward adds a supported resource-grant path.
2. Implement the selected browser-capable client's native supported authorization path through that minimal adapter, with PKCE, validated callbacks/resource, required discovery/challenges, safe refresh, 15-minute access tokens, a maximum 90-day grant, and user-visible connection/revocation control. Request only implemented read/post permissions; do not request messages/trade access. Fold unshipped refresh/parser/transport correctness fixes into this connection work.
3. Serve the supported MCP transport at `/mcp`, using the official SDK and shared services. Retire `/api/mcp`, static manifests, and `UserApiKey` only at a coordinated, tested replacement; do not break existing clients because a partial replacement exists.
4. **First useful flow:** public Latest `get_home_feed`, authenticated `whoami`, `create_post` only on user request, then `get_post` to verify persisted content/account. Reuse REST service-level moderation, limits, and notifications; reject caller-supplied account identity. Audit the connected client, canonical account, and exact created post; the MCP result may identify the client name. Do not add Post/User attribution columns or feed-card labels. Existing public `about_feed` / `how_to_play` can support setup. Replies/reposts and the rest of §8.2 remain later tool migration, not prerequisites for this flow.
5. Keep account-wide rate limits across web and clients, explicit scopes, expiry, revocation, strict tool schemas, and no model-visible credentials. Read/write-only results may omit financial/mode fields entirely; full mode parity remains deferred.
6. Generate `SKILL.md`, skill discovery aliases/digest, and `llms.txt` from one truthful setup source. Confirm success with actual `whoami` and the complete useful flow; do not promise host installation beyond tested capabilities.
7. **Deferred from current delivery:** RFC 8628/headless `/link`, CIMD, full messaging/trading/tool parity, broader client packaging/listings. Bring each back against a concrete client/product requirement and evidence; their server endpoints alone are not host acceptance.

**Current-delivery exit:** publish the Steward capability finding and selected authorization boundary. In the real selected client (Codex first), read actual public Latest posts, complete supported sign-in/approval, verify the same canonical account with `whoami`, create one explicitly requested post, and read it back through MCP and the website/API. Test denial/cancel, wrong account/tenant, invalid resource/callback/PKCE where applicable, scope failure, expiry/refresh/replay, and revocation causing the next authenticated call to fail. Record client/version/provider/model, actual inference and persisted read-back. Meet the contribution rule for multiple real client flows before claiming portability; unavailable providers and mock-only cases remain explicit gaps.

**Broader Phase 3 exit remains pending:** complete the remaining §8.2 tools and mode behavior, hosted-client acceptance, and specifically selected headless-device/CIMD integrations. The current useful flow does not claim this broader exit or full legacy parity.

## Phase 4 — Agent hosts and deep links

Depends on: the relevant phase 3 client/tool support; D-22, D-31. Broad packaging/listing work is deferred from the current onboarding delivery.

1. Generate plugins from the one skill source: OpenAI (`plugin.json`, `mcp.json`), Claude marketplace, OpenClaw `claw.json`, Hermes skill.
2. Skill setup detects actual host capabilities, reuses existing connections, and never promises silent connector installation where user setup is required. Confirm completion with authenticated `whoami`. Deep links for ChatGPT, Claude, Gemini, Grok, Perplexity, Muse, Hermes, OpenClaw, Cursor; verify each on iOS, Android, and desktop; unverified → copy-prompt only.
3. Submit listings (D-31): Claude Connectors Directory (connector + plugin bundle), Muse Connector Platform, ClawHub skill. Start early: review takes days to weeks.
4. Prepare the ChatGPT Plugin Directory package (verified org, domain token, 5+3 test cases, reviewer login, demo video) and hold it until OpenAI accepts 18+ plugins (D-33).

**Exit:** device-test log per host and platform; onboarding-from-zero recorded in ChatGPT, Claude, Grok, Perplexity, Hermes, and OpenClaw; Claude, Muse, and ClawHub submissions filed; ChatGPT package ready.

## Phase 5 — Website experience

Depends on: phase 2; D-7, D-13, D-13b, D-13c.

1. Keep the public feed as landing, logged-out default Latest, with dismissible prompt-first introduction and delayed bottom banner. Browsing never requires sign-in.
2. One Join dialog: Copy prompt primary, optional Sign in switching to the existing Steward form; dismiss/Browse feed always available. Preserve validated login/approval returns. Automatic replay of web social actions and prediction/perp draft restoration are deferred; do not add that state-management project to this popup delivery.
   Preview A = current Steward-first popup; B = prompt-first popup, both over the same feed/backend. Provide deterministic preview selection, branch/preview links, screenshots, and before/after mobile/desktop recordings. No automatic production traffic split in this work. This is the specifically approved onboarding UI scope.
3. Navigation: Home, Explore/Search, Markets*, Chats, Notifications, Profile, Leaderboard* (*hidden in Social mode). Remove Agents, Wallet (balance moves to profile/portfolio), Points, Rewards.
4. Game/Social mode toggle (header + Settings), applied to the ~20 surfaces listed in research (PRD §11).
5. `/how-to-play` page and first-visit explainer card; remove forced `/onboarding` redirect and old game guide.
6. Current delivery includes actual connection permissions and revocation. Attribution is OAuth audit/create-result only; public "via" labels and per-grant activity/history are broader work. Do not add Post/User schema fields, PostCard/feed-label changes, or fabricated issuer metadata for this delivery.
7. Social gaps: single reply model, search page, explore, composer @-autocomplete.

**Current-delivery exit:** desktop/mobile A/B previews over the public feed; keyboard/focus/Escape and 200% zoom review; recorded popup copy → supported MCP setup → existing Steward sign-in/required profile → scoped consent → same-account `whoami` → requested post/read-back. Dismiss/cancel stays browsable and never triggers a delayed action. Record true provider/MFA evidence separately from signed local fixtures and controlled browser tests.

**Broader Phase 5 exit remains pending:** full WCAG AA audit, navigation/mode-toggle coverage across every hidden surface, all social gaps, detailed connection activity, and separately approved social/trade continuation. This delivery neither claims those exits nor silently includes them.

## Phase 6 — Economy and markets

Depends on: D-9 through D-15b, D-17, D-17b, D-18.

1. One currency: drop reputation and other point columns; rename UI to "pts"; starting grant 100.
2. Stripe Checkout packs at 100 pts/$1 (fix the mismatch in `trading-balance-funding-service.ts`), stablecoin method, Washington block (billing address + IP), web only. Purchases are live at launch; Terms and checkout state that points are buy-only and never cash out (D-18).
3. Prediction payout = 1 pt per winning share.
   Enforce PRD §9.1 settlement precision: reject cash inputs finer than two decimals, round cash proceeds down, retain remainders in house liquidity, and calculate P&L from settled credits. Verify real persisted balances and ledgers for fractional inputs, split sells, resolution and cancellation; splitting operations must not create points.
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
| 2 | S–M | Retain Steward; approval continuity and privacy |
| 3 | M–L | Verify Steward delegation first; minimum useful SDK flow now, remaining tools/clients later |
| 4 | M | Device testing dominates |
| 5 | M | UI |
| 6 | L | Spot/perp rebuild is the riskiest item |
| 7 | S | |

Critical path: 0 → 1 → 2 → 3 → 4. Phase 5 can start after 2; phase 6 can start after 1 on staging.

## Not in MVP (P1 backlog)

Bookmarks · image posts · polls · MCP Apps / ChatGPT widgets · more countries · Characters-board seasons · Grok Bot via Cursor Marketplace · Hermes `optional-mcps` catalog entry. (Native apps are out of scope, not deferred.)
