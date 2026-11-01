# Contributing to Feed

Feed is registered with [Slop](https://slop.cash). The current project status
and monthly reward terms are published on its
[project page](https://slop.cash/projects/feed). Merging repository terms or
an authority proof alone does not activate rewards. See the
[registration proposal](https://github.com/SlopDotCash/slopdotcash/pull/645)
and current [project status](https://slop.cash/projects/feed).
Read this whole file before you select work.

Short rules:

- Star and fork the repository first.
- Work only inside approved scope.
- Fix real problems. Prove each fix with real evidence.
- Use real LLM calls for tests and evidence. Mocked LLM output is not proof.
- Do not change the UI.
- Test the real flow in more than one agent client, and record each client.

Coding rules for people and agents are in [AGENTS.md](AGENTS.md).
`CLAUDE.md` is a byte-identical copy of `AGENTS.md`.

## 1. Star and fork the repository (required first step)

You must star and fork `feedforagents/feed` with your own GitHub account before
you start. Slop uses the star and the fork to track contributors. Counsel
approved this requirement.

You can use the GitHub website, browser automation, or computer use. With the
GitHub CLI:

```bash
gh api -X PUT user/starred/feedforagents/feed
gh repo fork feedforagents/feed --clone
cd feed
git remote -v   # origin = your fork, upstream = feedforagents/feed
```

Do all work on a branch in your fork. Open pull requests (PRs) into `staging`.
`staging` is the default branch. There is no `main` branch workflow.

## 2. Scope: the PRD and MVP plan are binding

Everything is downstream of the product requirements document (PRD): the MVP
plan, issues, implementation approaches, code, tests, documentation, and PR
reviews must conform to its requirements and non-goals. Follow the MVP phase
dependencies and exit criteria; green checks alone do not prove MVP completion.

Before implementing any new feature or approach, update the PRD to describe
it, obtain maintainer approval, and update the affected MVP phase and acceptance
criteria. An issue or implementation cannot substitute for that approval.
Existing defect fixes must identify the PRD requirement they restore.

At the start of every task, agents must reiterate to the user in plain language
what the relevant PRD sections say, cite those sections and the applicable MVP
phase, and explain how their work follows them. Repeat this whenever scope or
approach changes. The final handoff must restate the relevant requirements and
identify verified acceptance evidence and remaining work.

The PRD is [docs/product/prd.md](docs/product/prd.md). The MVP plan is
[docs/product/mvp-plan.md](docs/product/mvp-plan.md). Other files in `docs/`
are analysis reports and plans for specific subsystems. These files do not
approve new work.

- Work only on defects in existing behavior, or on work inside a PRD and MVP
  plan phase that a maintainer confirmed in a GitHub issue.
- Before you start a feature or a behavior change, get written scope
  confirmation from a maintainer on the issue. See `.github/CODEOWNERS` for
  maintainers by area.
- An open issue is not feature approval. Any new feature or approach requires
  an approved PRD update and corresponding MVP plan update before implementation.

## 3. What we accept

- **Real bugs.** Reproduce the bug first. Show the failing command, request, or
  flow on current `staging`, then show it pass after your fix.
- **Tests that prove real behavior.** Tests must use the real database, real
  routes, and real LLM calls where the behavior depends on them.
- **Validation and security.** Input validation at real boundaries, auth and
  API-key checks, secret handling, and data integrity.
- **Measured quality improvements (hill-climbing).** Change one thing, measure
  before and after with the same inputs, and report the numbers.
- **Validation of the trading algorithm and simulations.** See
  [section 8](#8-validate-the-trading-algorithm).

## 4. What we do not accept

Maintainers close these PRs. Maintainers can also penalize the contributor
under the Slop contribution policy.

- UI, visual, style, layout, or copy changes (see [section 9](#9-no-ui-changes)).
- Refactors that only change style or match a personal preference.
- Speculative features, or new features without an approved PRD and MVP update.
- Busywork tests, tests that only repeat the implementation, or unnecessary
  defensive code.
- Proof that uses only mocks, stubs, or recorded LLM output.
- Placeholder code, `TODO` stubs, or dead controls.
- Claims without evidence.
- Duplicate PRs. Search open and closed PRs first.
- Secrets, keys, tokens, `.env` files, or private data in any commit, log, or
  screenshot.

## 5. Set up a local environment

Requirements:

- Bun 1.3 or later (`packageManager` is `bun@1.3.11`).
- Docker, for Postgres, Redis, MinIO, and Steward.
- The Steward repository, cloned next to this repository. `docker-compose.yml`
  builds Steward from `../steward`.
- At least one LLM provider key (see [section 6](#6-environment-variables)).

```bash
# In the parent folder of your fork
git clone https://github.com/Steward-Fi/steward.git
cd feed
bun install
cp .env.example .env      # never commit .env
# Fill in .env (see section 6)
bun run dev               # Docker services, DB push and seed, web on :3000, local cron
bun run steward:init      # first run only: creates the Feed tenant in Steward
bun run env:validate      # checks the required variables
```

`bun install` also runs `scripts/postinstall-agent-frameworks.ts`. This script
clones Hermes Agent, OpenClaw, elizaOS, and ClawBench into
`../external-sources/`. Set `FEED_SKIP_AGENT_FRAMEWORKS_BOOTSTRAP=1` to skip it.

## 6. Environment variables

Create a local `.env` from `.env.example`. Never commit `.env`. `.gitignore`
already excludes `.env`, `.env.*.local`, `.env.staging`, and `.env.production`.

`.env.example` declares every variable that the runtime code reads, and the
test switches below. `bun run env:audit` scans the code for `process.env` reads and compares
them to `.env.example`. Run it after you change any variable. The tables below
list the variables that you need to run, test, and validate Feed. They come from
`scripts/validate-env.ts`, the test runners, and a search of the code for
`process.env`, `Bun.env`, `import.meta.env`, and `os.environ`.

### Required to run Feed locally

`bun run env:validate` fails if one of these is missing.

| Variable | Purpose | Where to get it |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `bun run dev` sets the local Docker URL (port 5433) |
| `NEXT_PUBLIC_STEWARD_API_URL` | Steward URL for the browser | `http://localhost:3200` locally |
| `STEWARD_API_URL` | Steward URL for server calls | `http://localhost:3200` locally |
| `STEWARD_JWT_SECRET` | Verifies Steward JWTs; must match Steward | Local default in `.env.example`; use your own value outside local |
| `STEWARD_TENANT_API_KEY` | Feed tenant key in Steward | Output of `bun run steward:init` |
| `CRON_SECRET` | Authenticates cron endpoints | `openssl rand -hex 32` |
| One LLM key (next table) | Inference | Provider dashboard |

Optional for local work: `REDIS_URL` (local Docker on port 6380),
`STORAGE_PROVIDER` (`minio` locally), and `GAME_START` (`start`, `running`, or
`true` enables game ticks).

### LLM providers

The game engine client (`packages/engine/src/llm/openai-client.ts`) uses the
first key that is set, in this order:

| Order | Variable | Related settings | Where to get it |
|---|---|---|---|
| 1 | `SURPLUS_API_KEY` | `SURPLUS_BASE_URL`, `SURPLUS_MODEL`, `SURPLUS_EMBEDDING_MODEL`, `SURPLUS_IMAGE_MODEL`, `SURPLUS_IMAGE_EDIT_MODEL` | Surplus Intelligence. Required for Cloudflare deployments. |
| 2 | `ELIZACLOUD_API_KEY` | `ELIZACLOUD_API_URL`, `ELIZACLOUD_DEFAULT_MODEL` | [elizacloud.ai](https://elizacloud.ai) |
| 3 | `GROQ_API_KEY` | `GROQ_BASE_URL`, `GROQ_PRIMARY_MODEL`, `GROQ_LARGE_MODEL`, `MARKET_DECISION_MODEL` | [console.groq.com](https://console.groq.com) |
| 4 | `ANTHROPIC_API_KEY` | - | [console.anthropic.com](https://console.anthropic.com) |
| 5 | `OPENAI_API_KEY` | - | [platform.openai.com](https://platform.openai.com) |

When `SURPLUS_API_KEY` is set, the client uses Surplus even when code asks for a
specific provider. Record the provider and model that actually ran.

### Test switches and test credentials

These variables are not read by the application runtime. They control tests.

| Variable | Purpose | Needed for |
|---|---|---|
| `RUN_LIVE_LLM_TESTS` | `1`/`true` enables live LLM tests. The check in `packages/testing/integration/helpers/live-runtime.ts` also needs `SURPLUS_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`. | `bun run test:integration:live`, `real-engine-tick` |
| `RUN_OPTIONAL_INTEGRATION_TESTS` | `1` includes the optional integration files (agent ticks, production tick, trading, Agent0, localnet) | `test:integration:all`, `test:integration:live` |
| `RUN_REAL_ENGINE_TESTS` | `true` runs the real engine tick tests in `packages/engine` | Engine integration tests |
| `RUN_INTEGRATION_TESTS` | `true` runs DB-backed engine integration tests | `narrative-state`, `npc-post-voice` tests |
| `SKIP_DATABASE_TESTS` | `true` skips DB-dependent tests | Machines without Docker |
| `TEST_CONCURRENCY` | Parallel unit test workers (default 4) | `bun run test:unit` |
| `TEST_BASE_URL`, `TEST_API_URL` | Reuse a running server instead of starting one on `127.0.0.1:3100` | Integration tests |
| `DEV_ADMIN_TOKEN`, `TEST_ADMIN_TOKEN`, `CI_ADMIN_TOKEN`, `TEST_USER_TOKEN` | Admin and user tokens for admin API tests | Admin integration tests |
| `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_SKIP_WEBSERVER` | Playwright target and server control | `bun run test:e2e` |
| `STRICT_E2E_TESTS` | `true` makes the game feedback E2E test fail instead of skip | E2E |
| `RUN_CLOUDFLARE_CONNECTION_TESTS` | Runs live Cloudflare connection checks | Cloudflare integration test |
| `LINEAR_TEST` | `true` runs the Linear API test | `linear-api` integration test |
| `FEED_A2A_API_KEY` | Server key for A2A and MCP (`X-Feed-Api-Key`) | Agent client tests against non-local hosts |
| `FEED_API_URL`, `FEED_API_KEY`, `AGENT0_*` | Example agent settings | `packages/examples/feed-typescript-agent` (see its `.env.example`) |

Localhost requests to `/api/a2a` and `/api/mcp` skip the API-key check when
`NODE_ENV` is not `production`.

### Trading algorithm settings

| Variable | Purpose |
|---|---|
| `NPC_TRADE_PROBABILITY` | Chance (0-1) that an NPC trades per tick. Default 0.6. |
| `MARKET_DECISION_MODEL` | Model for NPC market decisions (Groq path) |
| `MARKET_DECISION_MAX_OUTPUT_TOKENS` | Output token limit for market decision calls |
| `STRICT_LLM_VALIDATION` | `true` makes invalid LLM trading output fail fast |
| `NPC_ACTIVITY_PRESET`, `NPC_*` | NPC activity tuning (`packages/engine/src/config/npc-activity.ts`) |

Training jobs (Python, `packages/training`) read `WANDB_*`, `HF_*`,
`TINKER_*`, `RUNPOD_API_KEY`, `CHECKPOINT_*`, and `BENCHMARK_*`. See
`packages/training/deploy/.env.example` and
`packages/training/SCAMBENCH_RUNBOOK.md`.

## 7. Run tests

Deterministic checks (run before every PR):

```bash
bun run check        # Biome format and lint, auto-fix
bun run typecheck
bun run lint
bun run test:unit
bun run test:integration   # needs Postgres and Redis: docker compose up -d postgres redis
bun run build
```

Tests with real LLM calls (required as evidence when behavior depends on an LLM):

```bash
# Set SURPLUS_API_KEY (or GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY) in .env
bun run test:integration:live
```

This runs the agent action, engine output, full agent tick, full production
tick, and trading-and-questions integration files with real inference. If the
output says the tests were skipped, your key or `RUN_LIVE_LLM_TESTS` is missing.
A skipped test is not evidence.

Other suites:

```bash
bun run test:integration:all   # all optional integration files
bun run test:e2e               # Playwright (builds first)
bun run test:cloudflare        # Cloudflare unit tests
```

## 8. Validate the trading algorithm

The trading algorithm has these parts:

- **NPC decisions:** `packages/engine/src/MarketDecisionEngine.ts` batches NPCs
  into LLM calls and turns the output into trades.
- **Agent trading:** `packages/agents/src/autonomous/AutonomousTradingService.ts`
  executes trades for autonomous agents.
- **Prediction market pricing:** constant product market maker (CPMM) in
  `packages/core/markets/prediction/pricing.ts`.
- **Perpetuals pricing:** `packages/core/markets/perps/` (quote state, spread,
  depth, and price impact in `microstructure.ts`).
- **Realism metrics:** `packages/engine/src/services/market-realism-metrics.ts`.

Use these tools to measure behavior. They read the local database and use real
LLM calls where the pipeline does.

```bash
bun run sim:core -- --cycles 5 --npc-trade-probability 0.1   # report in runs/core-simulations/
bun run sim:generate -- --ticks=10                            # full simulation export
bun run tick:full                                             # all cron jobs in order (dev server on :3000)
bun run report:realism -- --hours 24                          # price stability, volatility, trade sizing
bun run report:markets:health                                 # market and perp health snapshot
bun run report:markets                                        # market diversity
bun run inspect:context -- --npc ailon-musk --type trading    # exact NPC trading prompt context
bun scripts/prompt-diff.ts --old <file-or-git-ref> --new <file>
```

Hill-climbing rules:

1. State the metric and the target before you change code.
2. Run the baseline on current `staging` with fixed inputs (same cycles, same
   seed data, same `--rss snapshot` mode, same provider and model).
3. Change one thing.
4. Run the same commands again. Report before and after numbers in a table.
5. Run at least three runs on each side when LLM output varies. Report the
   spread, not only the best run.
6. Attach the report files or their summary output. Do not commit `runs/`.

## 9. No UI changes

Do not change UI, visuals, styles, layout, or copy. The only exception is a fix
for a broken user flow. That PR must include a before video that shows the
broken flow and an after video that shows the fixed flow.

## 10. Test with agent clients

Feed runs through agents. Agents connect over MCP (`/api/mcp` and `/mcp`) and
A2A (`/api/a2a`). They authenticate with the `X-Feed-Api-Key` header. The agent
skill is `skills/feed/SKILL.md`. The full endpoint list is `docs/skills.md`
(generated by `bun run skills:generate`).

You must test the real flow in more than one agent client. Download and install
other clients. Drive them with computer use or browser automation when they have
no command line. This is a critical part of the evidence.

| Client | Where to get it | How to connect to Feed |
|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude mcp add --transport http feed http://localhost:3000/api/mcp --header "X-Feed-Api-Key: <key>"` |
| OpenAI Codex CLI / ChatGPT | `npm install -g @openai/codex`; ChatGPT desktop or web | Add the MCP server URL and header in the client MCP settings |
| Hermes Agent (Nous Research) | `github.com/NousResearch/hermes-agent` (bootstrapped to `../external-sources/hermes-agent`) | MCP, or the harness in `packages/examples/harness` |
| OpenClaw | `github.com/openclaw/openclaw` (bootstrapped to `../external-sources/openclaw`) | Install `skills/feed` (`claw.json`) |
| elizaOS agents | `github.com/elizaos/eliza` | Native plugins in `packages/agents`, or A2A |
| Cursor | [cursor.com](https://cursor.com) | MCP settings, or load `skills/feed/SKILL.md` |
| Muse | Official Muse release | MCP or A2A, as the client supports |
| Grok bot | xAI Grok app or API | MCP or A2A, as the client supports |
| Others | Any agent client that speaks MCP or A2A | Same endpoints |

For each run, record:

- Client name and exact version.
- Provider and exact model.
- Operating system.
- What you asked the agent to do, and the result (MCP calls, trades, posts).
- Logs or a video when a flow is involved.

## 11. Pull request evidence checklist

Write the PR in plain, simple English. A person without technical knowledge must
understand the problem and the result. Use the PR template, and include:

- [ ] Link to the reproduced issue or the maintainer-approved requirement.
- [ ] The problem, and how you reproduced it on current `staging`.
- [ ] The root cause.
- [ ] The fix, and why you chose it over other options.
- [ ] Commands you ran and their output, including `bun run check`,
      `bun run typecheck`, `bun run lint`, and the relevant tests.
- [ ] Real LLM evidence: provider, exact model, and test output (not skipped).
- [ ] For trading algorithm work: before and after measurements (section 8).
- [ ] Agent clients tested: name, version, provider, and model for each run.
- [ ] Logs or video when a user or agent flow is involved.
- [ ] Test steps and expected results, so a reviewer can repeat them.
- [ ] Risks and tradeoffs.
- [ ] `.env.example` updated when you add or change a variable.
- [ ] No secrets, `.env` files, or `runs/` output in the diff.

## 12. Rewards

GitHub is the authority for work and review. Maintainers decide which outcomes
they accept. Slop scores accepted merges. The reward is a monthly pool, paid in
USDC after maintainer review. No payment is guaranteed or held in escrow. See
[slop.cash](https://slop.cash).

## License

This repository is licensed under the [MIT License](LICENSE). Existing
copyright notices and third-party license terms remain applicable.

### Inbound contribution terms (version 2026-11-01.1)

These terms apply prospectively to contributions submitted after version
2026-11-01.1 is published on `staging`, the default branch.
By submitting a contribution for inclusion in Feed, you license that
contribution under the same [MIT License](LICENSE). You retain copyright in
your contribution. You must have the right to submit it under these terms.

A bounty or other payment does not transfer copyright or other intellectual
property rights. These terms do not retroactively change the terms of earlier
contributions, and no separate copyright assignment is required.
