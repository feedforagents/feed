---
name: alchemy
description: Configure, test locally in workerd, and deploy Vibestack applications to Cloudflare with Alchemy v2 (alchemy.run): read before writing or editing alchemy.run.ts, Cloudflare Worker/DO/Static Assets stacks, deploy CLI commands, or deployment CI workflows.
---

# Alchemy deployment, local runtime, and verification

Vibestack uses **Alchemy v2** (`alchemy@2.0.0-beta.85` + `@alchemy.run/cloudflare@2.0.0-beta.85` + `@alchemy.run/test@2.0.0-beta.85`), Effect 4 native, running directly on Node 26+.

## Hard rules

- **Use Alchemy v2 only** (`alchemy` + `@alchemy.run/cloudflare` at `2.0.0-beta.85`). Never install legacy v1 (`alchemy-async` / `0.x`) or obsolete placeholders (`alchemy-effect`, `@alchemy.run/core`, `alchemy.run`).
- **Never install `@cloudflare/vite-plugin`** alongside Alchemy: `Cloudflare.Website.Vite` injects `@alchemy.run/cloudflare-runtime/vite` automatically and conflicts with `@cloudflare/vite-plugin`.
- **Keep `pnpm check` offline and fast.** Never run live cloud deploys inside `pnpm check` or default `pnpm test`. Run offline `workerd` boot/integration verification in `pnpm test:deploy` (using `@alchemy.run/test/Vitest` with `dev: true`) and live post-deploy checks inside `Alchemy.Action` + `pnpm cli deploy --verify`.
- **Always set `ALCHEMY_FAST_DISTILLED=1`** (or `--fast-distilled`) on Node 26 CLI invocations to lazy-load distilled cloud operations and cut startup time and heap usage.
- **Allow `workerd` build scripts** in `pnpm-workspace.yaml` (`allowBuilds: { workerd: true }`).
- **Ignore local state directories**: keep `.alchemy/` and `.wrangler/` out of Git, ESLint, Stylelint, and Turborepo task inputs (`vibestack init` and `vibestack upgrade` add them automatically).
- **Never commit secrets or pass them through cached Turbo tasks.** Put `CLOUDFLARE_*` and `ALCHEMY_*` only in `passThroughEnv` on `cache: false` deploy tasks.
- **Isolate Alchemy TypeScript projects from ESLint `projectService`.** Never include `deploy/` or `alchemy.run.ts` (which import `@alchemy.run/cloudflare` -> `@distilled.cloud/cloudflare`) in an app's main `tsconfig.json`; keep them in a dedicated `deploy/tsconfig.json` checked by `typecheck` (`tsc --noEmit -p deploy/tsconfig.json`) and in ESLint's `untyped` list (`vibestackConfig` adds `"**/alchemy.run.ts"` and `"**/deploy/**"` by default) so `pnpm lint:js` stays fast and never OOMs.

## Toolchain alignment

- Alchemy `2.0.0-beta.85` requires `effect: "^4.1.0"` and Node `>=26`.
- Vibestack pins `effect: 4.1.1`, `@effect/platform-node: 4.1.1`, `@effect/vitest: 4.1.1`, and `vibelang` / `vibelang-runtime` / `vibelang-vite` at `0.0.13`, matching `alchemy@2.0.0-beta.85` with zero peer conflicts.
- Pin exact `alchemy`, `@alchemy.run/cloudflare`, and `@alchemy.run/test` versions in `pnpm-workspace.yaml` under `catalog:`.

## Vibestack domain to Cloudflare mapping

| Vibestack layer | Cloudflare primitive in Alchemy v2 |
| --- | --- |
| Single-writer spec-backed `Machine` | **SQLite Durable Object** (`Cloudflare.Workers.DurableObject` / Worker export): serialize transitions in DO storage, validate stored state with `decodeState` on wake, persist before answering |
| React + Vite 8 + VibeLang SPA (local dev) | `Cloudflare.Website.Vite("App", { rootDir, assets: { notFoundHandling: "single-page-application" } })` — composes with `vibelang-vite`, `@vitejs/plugin-react`, and `@tailwindcss/vite` |
| Prebuilt Turbo SPA / Worker (CI, zero double-build) | `Cloudflare.Worker` with `bundle: false` (prebuilt ESM) and `assets: { ...hashAssetDirectory(distDir), notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] }` |
| Existing external Postgres pool | `Cloudflare.Hyperdrive.lookup` (read-only data source in `2.0.0-beta.85`) or `Cloudflare.Hyperdrive.Connection` with `.pipe(Alchemy.AdoptPolicy.adopt(true))`, supplying `dev` origin for local `alchemy dev` since Cloudflare never returns origin passwords |
| Post-deploy verification gate | `Alchemy.Action` calling `verifyDeploymentEndpoints` from `vibestack/alchemy`, returning a typed `DeploymentReceipt` |
| Operational deploy lever | `pnpm cli deploy [--stage <name>] [--dry-run] [--verify] [--destroy] [--json]` (`packages/cli/src/commands/deploy.ts`) |

## Helpers in `vibestack/alchemy`

`packages/vibestack/src/alchemy.ts` (imported as `vibestack/alchemy`) is a zero-dependency Node 26 module providing four composable primitives:

1. **`resolveStage` & `assertStageGuard`**:
   - Discriminated `StageTarget` (`dev`, `test`, `preview`, `staging`, `production`).
   - Scopes local dev/test stages by user and git worktree (`dev_<user>_<worktree>`, `test_<user>_<worktree>`) so parallel worktrees and agents never collide. Never hardcode a fixed `dev.port`.
   - `assertStageGuard(target, { resourceIds, domains, productionIds, productionDomains })` fails statically before deploy if any non-production stage references a production resource ID or domain.
2. **`hashAssetDirectory(dir)`**:
   - Deterministically SHA-256 hashes a Turbo-built `dist/` directory and returns `{ directory, path, hash, fileCount, totalBytes }` so `Cloudflare.Worker` skips re-hashing and re-uploading unchanged assets.
3. **`verifyDeploymentEndpoints(baseUrl, endpoints, options)`**:
   - Bounded exponential-retry HTTP verifier handling Cloudflare edge propagation (`404`/5xx cold-start windows), checking status codes, headers, body substrings, JSON predicates, and optional commit SHA headers/fields, returning a typed `DeploymentReceipt`.
4. **`makeR2BucketObjects(config, adapter)` & `createR2BucketClient(config)`**:
   - Zero-dep Node 26 R2 object client supporting both S3-compatible SigV4 (`kind: "s3"`, ideal for existing `R2_STATE_ACCESS_KEY_ID` / `R2_STATE_SECRET_ACCESS_KEY` credentials) and Cloudflare R2 REST API (`kind: "api"`). Plugs directly into `alchemy/State/BucketState`'s `makeBucketState` when CI tokens lack `Secrets Store Write`.

## State stores & safe adoption

- **Local dev & offline tests**: `Alchemy.localState()` (stored in `.alchemy/state/`, gitignored).
- **Cloudflare managed state**: `Cloudflare.state()` (one account-level Worker + SQLite DO + Secrets Store). Pre-provision once before CI via `pnpm exec alchemy state bootstrap --backend cloudflare`. Note: CI tokens using `Cloudflare.state()` require **Secrets Store Write** permission.
- **R2 bucket state (when Secrets Store Write is unavailable)**: wrap `makeR2BucketObjects` in `makeBucketState` (conditional-put `__lease__.json` locking; note `StateEncryption`/`passphraseEncryption` is `beta.86+`).
- **Adopting existing Workers & preserving secrets**:
  - Pass `.pipe(Alchemy.AdoptPolicy.adopt(true))` (or `--adopt`) when adopting existing Cloudflare resources.
  - **Worker secrets are preserved**: `Cloudflare.Worker` does not wipe secrets set outside Alchemy (`wrangler secret put` or dashboard); it only deletes secrets previously managed by Alchemy.
  - **`Cloudflare.Pages.Project` caveat**: `Pages.Project` reconciles `envVars` key-by-key and deletes omitted keys if `envVars` is specified. Omit `envVars` to leave unmanaged Pages secrets intact.
  - **`Cloudflare.Pages.Deployment` limitation**: `Pages.Deployment` cannot upload static assets, `_worker.js`, or `_routes.json`. Prefer `Cloudflare.Worker` with Workers Static Assets (`assets: { ... }`); where Classic Pages is strictly required, adopt `Pages.Project` and upload via a memoized `Alchemy.Action`.
  - **Durable Object migrations**: always run `pnpm exec alchemy --fast-distilled plan --adopt --stage <stage>` first when adopting Workers with existing or retired Durable Object classes to confirm zero unintended `deleted_classes` operations.
  - Use `Alchemy.RemovalPolicy.retain()` on stateful resources (D1, R2, Durable Object namespaces, Zones) so `destroy` never drops production data.

## Local dev & verifiable testing (`workerd`)

- **Local runtime**: `pnpm dev:cf` runs `ALCHEMY_FAST_DISTILLED=1 alchemy dev` (real local `workerd` with hot reload for Workers, SQLite DOs, KV, R2, D1, Queues, Email, RateLimit, and Vite HMR for Websites — zero Cloudflare credentials required).
- **Offline `workerd` verification (`pnpm test:deploy`)**:
  - Use `@alchemy.run/test/Vitest` (`Test.make({ providers: Cloudflare.providers(), dev: true, stage })`) with `beforeAll(deploy(Stack))` and `afterAll(destroy(Stack))`.
  - Boots the real built Worker / Static Assets / SQLite DO inside `workerd` locally — catching global-scope runtime errors, asset routing regressions, and DO serialization bugs offline in PR CI before touching Cloudflare.
  - The same stack and `verifyDeploymentEndpoints` probes run post-deploy inside `Alchemy.Action` against the live deployed URL.

## Turborepo & zero-trust CI optimization

- **Single-build handoff**: run `pnpm exec turbo run build typecheck` (or `pnpm all build typecheck`) once (leveraging Turborepo + R2 remote cache), then pass prebuilt outputs (`bundle: false` + `hashAssetDirectory`) into Alchemy so CI never double-builds Vite or VibeLang bundles.
- **Zero-trust publication boundary**:
  - Untrusted PR verification jobs (`ci.yml`) read shared remote caches and run offline `pnpm test:deploy` (`workerd`) with **no** Cloudflare deploy secrets.
  - Privileged deploy jobs (`deploy-site.yml`, `deploy-examples.yml`) run with `concurrency: { cancel-in-progress: false }` on `main`, never restore untrusted PR caches, preflight auth via `pnpm exec alchemy provider check-env`, and fail atomically if post-deploy `Alchemy.Action` verification fails.
- **Credentials**: Alchemy reads `~/.alchemy/profiles.json` (`alchemy profile edit --add Cloudflare`) or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (it does not read Wrangler's OAuth token). Run `pnpm exec vibestack doctor` to verify readiness.
