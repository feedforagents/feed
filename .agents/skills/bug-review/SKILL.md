---
name: bug-review
description: "Run a high-signal parallel bug review before finishing an app, feature, or PR: rely on automated checks first, then fan out vertical module and horizontal cross-cutting reviewers to eliminate bugs, leaks, state/rendering issues, inefficiencies, and code smells."
---

# Parallel bug review

Run this review before declaring an application, feature, or non-trivial change done.
Read [AGENTS.md](../../../AGENTS.md) in full first, once per session.

Formal proofs and static checks catch model, type, token, barrel, dead-code, cycle, and duplication failures. This workflow catches what sits past them: where the verified core meets React, DOM layering, VibeLang/Effect concurrency, storage, external boundaries, and runtime performance.

## Phase 0: Pre-flight automated gate

Never spend reviewer effort on anything tooling already catches.

1. Run the project's automated suite first:
   - `pnpm verify` when defined, otherwise `pnpm check`, `pnpm lint`, and `pnpm analyze` (when present).
   - If `pnpm check` shows a `✗`, follow the [sync skill](../sync/SKILL.md) first.
2. Fix every automated failure before launching reviewers.
3. Record the baseline commit (`git rev-parse HEAD`) so follow-up verification rounds only re-audit changed files and touched seams.

## Phase 1: Choose scope and shard in parallel

Skip generated and build directories (`gen/`, `generated/`, `dist/`, `.vibe/`, `.cache/`, `.spec-cache/`, `node_modules/`).

- **Full review** (finishing an app, major milestone, or first audit): cover every active non-generated source, spec, test, and config file in the repository.
- **Incremental review** (default for PRs and post-fix verification rounds): collect changed files (`git diff --name-only <base>...HEAD` plus untracked files) together with their owning `spec/` modules, direct callers, and any shared runtime or UI contracts they touch.

When your harness supports parallel subagents or swarm workers, launch both axes in parallel in one turn; otherwise run the same passes in sequence without skipping either axis. Restate the user's goal in every reviewer brief, and cap each shard to ~10–40 files or ~2–5k LOC ([principle-guard-the-context-window](../principle-guard-the-context-window/SKILL.md)).

### Axis A: Vertical module shards (disjoint partitions)

Partition active files by domain, app, or package so every file in scope is read line-by-line by exactly one vertical reviewer. Each reviewer audits these six defect classes:

1. **Spec ↔ shell fidelity.** Unit or scale mismatches (`int` seconds vs. milliseconds, debounce durations), unwired specs or events, no-op emitted effects (`Effect.succeed(undefined)`), swallowed `Rejected` errors, missing hydration from restored/synced snapshots, missing session/account reset cleanup, controls calling `send()` without gating on `can()`, and optimistic side-store writes that run before `Machine.send` accepts.
2. **VibeLang / Effect concurrency and leaks.** `Stream.callback` or `FiberMap` jobs missing `addFinalizer` / `acquireRelease` (leaking listeners, watchers, or mutating state after superseding), `Semaphore` deadlocks on failure or interruption, empty streams completing cleanly without notifying an `InFlight` machine, missing timeouts or `AbortSignal` propagation on network/bridge calls, module-level mutable `Map`/`Set`/`let` side-stores leaking across runtimes/tests/sessions, and TOCTOU races (`issued + 1`, mutable remote-sync flags).
3. **React state, rendering, and UX.** Render-time `runtime.runSync(...)` or side effects, unstable `key` props unmounting inputs mid-edit, async controlled inputs causing caret jumps or dropped keystrokes, components subscribing to many whole machines without selectors or sending at 60Hz, `<Suspense fallback={null}>` blank routes, unrecoverable error boundaries stuck at `null`, stripped or clipped `:focus-visible` rings, missing `prefers-reduced-motion`, borderless dark-mode floating surfaces, and interactive touch targets under 44px.
4. **Boundaries, security, and persistence resilience.** External data (HTTP, IPC, URLs, JSON, storage, env, CLI args) trusted without schema/`decodeEvent`/`decodeState` validation, `localStorage` quota or corrupt-JSON errors crashing via `orDie` or silently resetting user data to empty, cross-origin `postMessage` or path-prefix (`startsWith` without separator + symlink) or plain-object prototype (`obj[key]`) bypasses, producer↔consumer encoding/schema mismatches (`base64url` vs. `base64` vs. hex), and sensitive data leaking on hidden/locked views.
5. **Runtime inefficiencies.** Unconditional syncs or fetches on unrelated events, repeated `structuredClone`/serialization/parser/formatter (`Intl.*`, `RegExp`) allocations in hot paths, unbounded caches or unrevoked `blob:` URLs, and eager imports defeating route code-splitting.
6. **Verification honesty.** Tests mocking internal application services instead of network/platform boundaries, fakes leaking real network traffic, vacuous or false-negative Bombadil properties, orphan modules tested instead of production code, or missing drivers/journeys for stateful shells.

### Axis B: Horizontal cross-cutting reviewer

Launch one cross-cutting reviewer (two on very large monorepos) focused strictly on seams no single module shard can see:

1. **State, caching, and lifecycle architecture.** How `Machine` state interacts with side-stores, persistence quotas, eviction bounds, and sign-out/reset/owner-switch isolation across the whole app.
2. **Global UI layering, focus, and navigation.** Unified `z-*` stacking order across overlays, alerts, sheets, dialogs, and docks; portals vs. viewport/keyboard bounds; `inert`, Escape, and Back-navigation consistency.
3. **Cross-package contracts and build/cache keys.** Producer↔consumer schemas, route tables, manifests, shared runtime helpers, and Turbo/CI env or input keys that could poison caches.

### Live UI verification (apps serving a web interface)

For any package with an `index.html`, do not rely on static reading alone ([principle-prove-it-works](../principle-prove-it-works/SKILL.md)). Confirm `pnpm test:browser` and `pnpm check`'s `explore` stage pass, and inspect the running build across mobile/desktop viewports and light/dark themes for:

- zero uncaught page errors, console errors, or failed requests,
- no blank cold-route frames or broken hit-testing (`elementsFromPoint`) under overlays,
- visible, unclipped `:focus-visible` rings and legible contrast on floating surfaces,
- real interactive controls responding and respecting disabled/loading states.

Do not commit screenshot-comparison tests ([AGENTS.md, "Tests"](../../../AGENTS.md#tests)).

## Phase 2: Evidence and severity bar

Report only verified, high-signal defects. Every finding must include:

- **Severity:**
  - `P0` — crash, data loss/corruption, deadlock, security/privacy bypass, broken core journey, or unusable critical UI.
  - `P1` — race condition, resource/memory leak, spec↔shell mismatch, cross-session state leak, render/perf storm, or accessibility/layering break.
  - `P2` — edge-case error gap, missing timeout/eviction bound, meaningful inefficiency, or concrete bug-inviting smell (silent error swallowing, duplicated business rules outside `spec/`).
- **Exact `file:line` citation** verified by reading the code on disk.
- **Concrete failure path:** trigger → line executed → observable user/system breakage.
- **Root-cause fix** ([principle-fix-root-causes](../principle-fix-root-causes/SKILL.md)), never a symptom guard.

**Never report:**

- style preferences, bikeshedding, or requests for code comments (comments are banned by [AGENTS.md, "Writing code"](../../../AGENTS.md#writing-code)),
- issues already caught by `pnpm check`, `pnpm lint`, or `pnpm analyze`,
- hypothetical failures already ruled out by proved Quint/Dafny rules or TypeScript types.

Keep shard notes in conversation or temporary scratch output; never commit new Markdown audit documents to the repository ([AGENTS.md, "Hard rules"](../../../AGENTS.md#hard-rules)).

## Phase 3: Deduplicate, fix in waves, and incrementally re-verify

1. **Deduplicate.** Collapse overlapping vertical and horizontal findings into one canonical list, keeping the highest severity and all `file:line` citations.
2. **Fix in non-overlapping waves.**
   - **Wave 0 (when needed):** land shared contracts, design tokens, or runtime primitives first.
   - **Wave 1:** fix module defects in parallel on strictly disjoint file globs ([principle-separate-before-serializing-shared-state](../principle-separate-before-serializing-shared-state/SKILL.md)).
   - For each real shell bug fixed, extend the existing journey test that cites its story or rule ([AGENTS.md, "Tests"](../../../AGENTS.md#tests)).
   - When the same defect repeats across modules, encode the guard structurally in `spec/`, types, or lint config ([principle-encode-lessons-in-structure](../principle-encode-lessons-in-structure/SKILL.md)).
3. **Re-run automated gates.** Run `pnpm check` (following the [sync skill](../sync/SKILL.md) if any spec changed), `pnpm lint`, and `pnpm analyze` (when defined). Turborepo and `.spec-cache/` skip untouched packages automatically.
4. **Incremental re-review.** Run a diff-scoped review over only the files modified since the Phase 0 baseline plus any contracts they touch. Confirm every fixed `P0`/`P1`/`P2` is resolved at its root cause and introduced no regression.
5. **Stop condition.** Stop when automated gates are green and zero unresolved `P0` or `P1` findings (and zero regressions) remain. Cap at three fix-and-reverify rounds; if an architectural tradeoff remains unresolved, stop and escalate it clearly to the user.

## Report

Summarize concisely when done:

1. **Scope and automated gates:** full vs. incremental, commands run and status.
2. **Findings resolved:** grouped by `P0` / `P1` / `P2` with `file:line` and root-cause fix.
3. **Regression coverage:** journey tests, spec rules, or structural checks added.
4. **Remaining or escalated items:** any deferred `P2`s or architectural decisions needing user input, or state explicitly that none remain.
