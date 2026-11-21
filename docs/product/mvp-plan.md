# Feed — MVP Plan (v0.5)

Companion to [prd.md](prd.md) (v0.5, onboarding narrowed 2026-11-09). Phases are ordered by dependency; phases 2–5 can partly overlap once phase 1 lands. Each phase ends with exit criteria proved by end-to-end runs against the real workflow (not new unit tests).

Approved onboarding scope: [#1832](https://github.com/feedforagents/feed/issues/1832), narrowed by the maintainer's 2026-11-09 instruction.

**Current delivery boundary:** preserve Steward, the public feed, prompt-first popup with optional existing Sign in, and canonical setup skill. Prove one complete MCP flow: public Latest `get_home_feed` → native supported authorization → same-account `whoami` → explicitly requested `create_post` → persisted `get_post` read-back. First verify Steward's scoped per-client access from owning source/current documentation. The source finding at Steward `develop` commit `297437b23` distinguishes its own agent/provider scopes from Feed human-client resource grants; the closest session signer is unmounted. Retain Steward identity and limit the justified Feed OAuth adapter to this delivery; do not claim Steward lacks scoped-agent support.

Defer headless/device login, CIMD, broad host packaging, automatic web-action queues, and prediction/perp draft restoration from this delivery. Preserve safe login/approval return behavior and core consent, expiry, refresh, revocation, tenant/account binding, and credential privacy. The first tool flow can omit all financial and mode fields; it does not require a `User.uiMode` migration. Wider mode/tool parity and the phase exits below remain unfinished. This incremental change does not authorize a relaunch, database reset, or premature legacy-client retirement.

Consolidate the unmerged work by responsibility in isolated worktrees, folding correctness fixes into the feature they repair and making each PR show its own changes. Keep independent notification privacy repairs separate. A passing subset or assembled review branch is not full MVP acceptance.

Decision IDs (D-n) refer to PRD §14. If a decision changes, the affected phase is noted.

---

## Phase 0 — Get the world running (P0, before anything else)

Why first: game ticks keep the public feed, markets, and articles active. The checked-in production Worker config enables cron, and the sample app configuration starts paused. Verify the deployed settings and actual tick delivery.

1. Confirm which cron jobs are active in the deployed production environment. On the new-game deployment (staging first), enable or verify `game-tick`, `markets-tick`, `npc-tick`, `organization-tick`, `article-tick`, `perp-funding`, and `world-facts`.
2. The Worker and internal scheduler exclude the missing `reputation-sync` and `profile-chain-sync` routes. The retired `agent-tick` is also absent from both schedules.
3. Route NPC and engine inference through Surplus and implement [D-25 spend enforcement](prd.md#d-25-spend-enforcement). Set `NPC_LLM_DAILY_BUDGET_USD` to $100/day at launch and preserve the four-step maximum.
4. Add tick health to the admin dashboard: last success per job, LLM tokens, confirmed spend, and reserved cost for the UTC day.
5. Turn off user/agent trajectory recording in product ticks (D-24).
6. Implement the bounded prediction market handoff in [PRD §9.2](prd.md#92-prediction-markets).
   Track pending resolutions and the age of the oldest one alongside market tick
   delivery so on-time ticks cannot mask a growing backlog.
7. Implement the world clock and generation split in
   [PRD §9.7](prd.md#97-world-clock-and-generated-activity). Track committed
   market-linked clues, oldest pending work, and the last RSS refresh alongside
   minute tick delivery.

**Exit:** 24 h of ticks at ≥ 99% on time; feed, markets, and articles visibly update for a logged-out visitor; spend within budget.

**World clock evidence:** Replay the same cold database and inference model
before and after the change. Verify on-time game ticks, visible and timely
phase-appropriate market clues, continued RSS and article updates, and
fewer inference calls per published post. Exercise provider failure,
duplicate delivery, and restart. A retry must neither duplicate a clue nor
publish it out of phase or reveal the hidden outcome.

Run this split on localnet until D-25 is deployed and verified. Localnet setups
that use the migration journal apply
[`0009_npc_market_clue.sql`](../../packages/db/drizzle/migrations/manual/0009_npc_market_clue.sql)
after the journal and before starting NPC cron jobs. Fresh databases created by
`bun run dev` already have the table. Apply the migration on existing local
databases before setting `DEPLOYMENT_ENV=localnet`.

**Market recovery evidence:** Replay the 15-expired-market backlog with real
inference and PostgreSQL. Verify that minute ticks stay on time, expired
markets stop accepting trades, and the eligible backlog drains after a
provider timeout, duplicate delivery, and worker restart. Verify one payout
and public proof per completed market, with proofs private until resolution.
A market on manual review hold stays closed to trading and awaits the admin
decision. Verify replacement markets resume. Record backlog age and time to
drain.

**Spend evidence:** Verify concurrent requests at the remaining budget edge,
uncertain provider responses, retry and restart behavior, and UTC rollover.
Show both throttle levels and reconcile confirmed Surplus charges for the
same acceptance window against the budget. Record local timing and visibility
evidence with its inference provider and settings.

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

**Approved staging-only exception:** The exception in PRD §9.1 and Phase 6 may defer Farcaster/NFT schema removals solely for the guarded additive financial upgrade. Retention does not satisfy this phase's removal or exit criteria; production and relaunch requirements remain unchanged.

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
   Enforce the PRD §9.1 canonical trading fee on prediction and perp trades: the fee is charged on the cent-settled amount and rounded up to whole cents, identically in execution, previews and the fee ledger. Verify against a real database that split and repeated trades never increase total trader credit or receive more buy shares than whole execution, that charged fees equal recorded fees (ledger rows, splits and `users.totalFeesPaid`) to the cent, and that dust proceeds settle to zero while a one-cent settled sale nets zero after its one-cent fee.
4. **Spot/index/perp rebuild** (PRD §9.3): spot CPMM pools per ticker, NPC-only spot trading action, persisted index price, mark = index + bounded premium, funding from mark–index, liquidation on mark, remove random-walk price source and duplicate price stores, leverage cap 20×. Run on staging with NPC load for ≥ 72 h; check perps track spot, funding sign is correct, no runaway prices.
5. Profit leaderboard (all time / month) excluding purchases; separate Characters board.

**Approved — existing staging schema only.** Under the PRD §9.1 staging exception, the exact original baseline may receive only original additive migrations `0003`–`0005` through the normal migrator, with genuine `[0000, 0003, 0004, 0005]` receipts and all specified guards. Acceptance requires local nonempty-data retention, rollback, postflight shape and rerun proof, plus the existing required tests and build. Retained Farcaster/NFT data is preserved; this does not complete Phase 1 removals or Phase 6. Future cleanup needs a separate reviewed migration. Phase 7's fresh production database and D-8 remain unchanged.

**Exit:** 72 h staging soak with charts of index vs mark per ticker; a test purchase end-to-end in Stripe test mode, and a refused purchase with a Washington billing address; a prediction market resolves and pays exactly 1 pt per winning share; leaderboard unaffected by a purchase.

**Approved staging funding rollout acceptance (2026-11-17).**
On a disposable copy of each supported staging migration lineage, apply the
funding ledger migration and verify existing receipts, balances and positions,
the new ledger constraints, rollback and safe reruns. Prove one accrual per
position and scheduled period with the real Worker queue, authenticated
HTTP handler and PostgreSQL. Cover duplicate delivery, a partial failure
retried across the next UTC boundary, and delivery of the next distinct
period. Exercise the pause and drain cutover before enabling the scheduler
route in Phase 0.

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
